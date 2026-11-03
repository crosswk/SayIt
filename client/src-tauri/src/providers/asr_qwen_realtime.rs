// 千问实时语音识别 — qwen3-asr-flash-realtime
// WebSocket 流式：边录边发，OpenAI Realtime 风格协议
//
// 流式会话两种模式：
//  - 普通模式（realtime=false）：send 只发音频，finish 时才收集全部转录结果。
//  - 实时显示模式（realtime=true）：后台 reader 持续读取识别事件，把中间结果通过
//    `asr-partial` 事件上抛给前端做悬浮窗实时上屏；finish 返回累计的最终文本。
// 另有一次性识别 `transcribe`（录完再发），见那个函数的注释。

use super::{
    diag,
    types::{AsrProviderConfig, AsrResult, TestResult},
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::{AUTHORIZATION, USER_AGENT};
use tungstenite::http::HeaderValue;

// 用稳定版模型名（不带日期快照）：带日期的快照版免费额度可能已耗尽，
// 稳定版按账号额度计费，实测可正常建连并返回实时中间结果。
const MODEL: &str = "qwen3-asr-flash-realtime";

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;

/// 普通模式会话：整条 WebSocket。
static SESSION: once_cell::sync::Lazy<Arc<Mutex<Option<WsStream>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式：拆分后的发送端。
static RT_SINK: once_cell::sync::Lazy<Arc<Mutex<Option<WsSink>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式后台 reader 任务句柄。
static RT_READER: once_cell::sync::Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式共享状态。
/// committed：已确定分句拼接的最终文本；partial：当前进行中的增量缓冲。
#[derive(Default)]
struct RtState {
    committed: String,
    partial: String,
    finished: bool,
    error: Option<String>,
}

impl RtState {
    /// 实时展示用文本 = 已确定 + 进行中
    fn display(&self) -> String {
        if self.partial.is_empty() {
            self.committed.clone()
        } else if self.committed.is_empty() {
            self.partial.clone()
        } else {
            format!("{}{}", self.committed, self.partial)
        }
    }
}

static RT_STATE: once_cell::sync::Lazy<Arc<Mutex<RtState>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(RtState::default())));

static RT_ACTIVE: AtomicBool = AtomicBool::new(false);

const SCOPE: &str = "qwen/realtime";

/// 建 WebSocket 连接。
///
/// 填了业务空间 ID 走「北京 + 业务空间」专属端点，没填走通用端点。
/// 一次性识别那条路不带业务空间 ID，靠的就是通用端点：2026-10-27 实测
/// （dev-scripts/probe_qwen_realtime_oneshot.py）3 秒、89 秒、5 分钟的录音都能识别。
async fn connect(api_key: &str, workspace: &str, purpose: &str) -> Result<WsStream, String> {
    let workspace = workspace.trim();
    let url = if workspace.is_empty() {
        format!("wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={}", MODEL)
    } else {
        format!(
            "wss://{}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model={}",
            workspace, MODEL
        )
    };

    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| diag::fail(SCOPE, "build_request", format!("Failed to build request: {}", e)))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key))
            .map_err(|e| diag::fail_code(SCOPE, "authorization_header", "provider_bad_key", format!("Invalid Authorization header: {}", e)))?,
    );
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_static(concat!("SayIt/", env!("CARGO_PKG_VERSION"))),
    );

    let (ws, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| diag::fail(SCOPE, "connect", format!("WebSocket connection failed: {}", e)))?;
    crate::commands::system::write_log_line(&format!(
        "[RUST] [qwen_stream] connected status={} model={} {} host={}",
        response.status(),
        MODEL,
        purpose,
        if workspace.is_empty() { "generic" } else { "workspace" }
    ));
    Ok(ws)
}

/// 发 session.update，并等到 session.updated 才算就绪（说明配置被接受、模型可用）。
/// 若额度耗尽/无权限，服务端会在 session.created 后直接关闭连接（携带原因），
/// 此时拿不到 session.updated → 返回 Err。
async fn configure_session(
    ws: &mut WsStream,
    sample_rate: u32,
    hotwords: Option<&[String]>,
    turn_detection: serde_json::Value,
) -> Result<(), String> {
    let mut input_audio_transcription = serde_json::json!({ "language": "zh" });
    if let Some(words) = hotwords {
        if let Some(ctx) = super::asr_qwen::build_hotword_context_text(words) {
            input_audio_transcription["corpus"] = serde_json::json!({ "text": ctx });
        }
    }
    let session_update = serde_json::json!({
        "event_id": "init_session",
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": sample_rate,
            "input_audio_transcription": input_audio_transcription,
            "turn_detection": turn_detection
        }
    });
    ws.send(tungstenite::Message::Text(
        serde_json::to_string(&session_update).unwrap().into(),
    ))
    .await
    .map_err(|e| diag::fail(SCOPE, "send_session_update", format!("Failed to send session.update: {}", e)))?;

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| diag::fail(SCOPE, "recv_ack", format!("Failed to receive acknowledgement: {}", e)))?;
        match msg {
            tungstenite::Message::Text(text) => {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                    let event_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if event_type == "session.updated" {
                        crate::commands::system::write_log_line("[RUST] [qwen_stream] session updated");
                        return Ok(());
                    }
                    if event_type == "error" {
                        return Err(diag::fail(SCOPE, "server_error", format!("Server error: {}", event_error_message(&data))));
                    }
                }
            }
            tungstenite::Message::Close(frame) => {
                let reason = close_reason(frame);
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [qwen_stream] closed before ready: {}",
                    reason
                ));
                return Err(diag::fail(SCOPE, "closed_before_ready", format!("Server closed the session: {}", reason)));
            }
            _ => {}
        }
    }
    Err(diag::fail(SCOPE, "closed_before_ready", "WebSocket closed before the session became ready".to_string()))
}

fn event_error_message(data: &serde_json::Value) -> String {
    data.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error")
        .to_string()
}

fn close_reason(frame: Option<tungstenite::protocol::CloseFrame>) -> String {
    frame
        .map(|f| format!("code={} reason={}", u16::from(f.code), f.reason))
        .unwrap_or_else(|| "No reason".to_string())
}

/// 一次性识别每包发 1 秒音频。包大小不影响限速（Omni 那边实测过），只影响事件条数。
const ONESHOT_CHUNK_BYTES: usize = 32_000;

/// 录完再发：整段音频推完 → commit → 等一条 completed。
///
/// 关掉实时字幕、或者流式连接没建起来时走这里。**以前这条路走的是 asr_qwen（模型写死
/// qwen3-asr-flash）**，用户在下拉里选的是 realtime，实际识别、计费的却是另一个模型，
/// 界面上看不出来。别再把 qwen_realtime 并回 asr_qwen 那个分支。
///
/// 为什么关掉 server_vad、手动 commit：录音一口气推上去，VAD 按音频时间轴切句，而录音
/// 结尾的那句话后面没有足够长的静音，VAD 不会把它判成一句话结束 —— 实测 3 秒的录音
/// session.finish 之后直接 session.finished、一个字都没有。手动模式下一次 commit 出
/// 一条 completed，整段一起识别，自带标点（实测 89 秒 2.3 秒出全文）。
pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    use base64::Engine;
    use futures_util::FutureExt;

    let pcm = base64::engine::general_purpose::STANDARD
        .decode(audio_pcm_b64)
        .map_err(|e| diag::fail(SCOPE, "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;
    if pcm.is_empty() {
        diag::empty_result(SCOPE, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }
    let audio_sec = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    let workspace = config
        .extra
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    diag::log(
        SCOPE,
        "oneshot_start",
        &format!("pcm_bytes={} audio_sec={:.1} hotwords={}", pcm.len(), audio_sec, hotwords.len()),
    );

    let start = Instant::now();
    let mut ws = connect(&config.api_key, workspace, "oneshot").await?;
    configure_session(&mut ws, sample_rate, Some(hotwords), serde_json::Value::Null).await?;

    // 先突发后限速，规则与 Omni 共用（同一个接口的上行限速）。
    // **必须边发边读**：发送期间服务端一直在推 `.text` 中间结果，一路不读的话 5 分钟录音
    // 会在发送中途被断开（2026-10-27 实测，边读就能过）；服务端在发送途中报的错误和
    // close 原因也只有这时候读得到，读不到日志里只剩「第 N 包发不出去」。
    let send_start = Instant::now();
    let total_chunks = pcm.len().div_ceil(ONESHOT_CHUNK_BYTES);
    let mut wire_sent: u64 = 0;
    let mut waits: u32 = 0;
    for (idx, chunk) in pcm.chunks(ONESHOT_CHUNK_BYTES).enumerate() {
        let frame = serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": base64::engine::general_purpose::STANDARD.encode(chunk),
        })
        .to_string();
        let frame_len = frame.len() as u64;
        if let Some(due) = super::asr_qwen_omni::realtime_upload_due(wire_sent, frame_len) {
            let deadline = send_start + due;
            if deadline > Instant::now() {
                waits += 1;
                tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
            }
        }
        ws.send(tungstenite::Message::Text(frame.into())).await.map_err(|e| {
            diag::fail(
                SCOPE,
                "send_audio",
                format!("Failed to send audio chunk {}/{} (wire_bytes={}): {}", idx + 1, total_chunks, wire_sent, e),
            )
        })?;
        wire_sent += frame_len;

        while let Some(message) = ws.next().now_or_never().flatten() {
            match message {
                Ok(tungstenite::Message::Text(text)) => {
                    let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    if data.get("type").and_then(|t| t.as_str()) == Some("error") {
                        let _ = ws.close(None).await;
                        return Err(diag::fail(
                            SCOPE,
                            "server_error_while_sending",
                            format!("Recognition error while sending chunk {}/{}: {}", idx + 1, total_chunks, event_error_message(&data)),
                        ));
                    }
                }
                Ok(tungstenite::Message::Close(frame)) => {
                    return Err(diag::fail(
                        SCOPE,
                        "closed_while_sending",
                        format!("Server closed the connection while sending chunk {}/{} (audio={:.1}s): {}", idx + 1, total_chunks, audio_sec, close_reason(frame)),
                    ));
                }
                Ok(_) => {}
                Err(e) => {
                    return Err(diag::fail(
                        SCOPE,
                        "recv_while_sending",
                        format!("Read failed while sending chunk {}/{}: {}", idx + 1, total_chunks, e),
                    ));
                }
            }
        }
    }
    // 「限速真的生效了」的证据：排查时先看这一行在不在、waits 是不是 >0。
    diag::log(
        SCOPE,
        "oneshot_pacing",
        &format!("wire_bytes={} chunks={} waits={} send_ms={}", wire_sent, total_chunks, waits, send_start.elapsed().as_millis()),
    );

    ws.send(tungstenite::Message::Text(
        serde_json::json!({ "type": "input_audio_buffer.commit" }).to_string().into(),
    ))
    .await
    .map_err(|e| diag::fail(SCOPE, "send_commit", format!("Failed to commit audio: {}", e)))?;

    // 上限按音频长度放宽：89 秒实测 commit 后约 1.5 秒出全文，长音频线性长一些。
    let collect_budget = Duration::from_secs(20) + Duration::from_secs_f64(audio_sec.min(600.0) / 2.0);
    let text = tokio::time::timeout(collect_budget, async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| diag::fail(SCOPE, "recv", format!("Failed to receive result: {}", e)))?;
            match msg {
                tungstenite::Message::Text(text) => {
                    let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    match data.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "conversation.item.input_audio_transcription.completed" => {
                            return Ok(data
                                .get("transcript")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .trim()
                                .to_string());
                        }
                        "error" => {
                            return Err(diag::fail(SCOPE, "recognition_error", format!("Recognition error: {}", event_error_message(&data))));
                        }
                        _ => {}
                    }
                }
                // 协议没跑完就被关：不能当成「识别到空文本」上报成功（pitfalls #15）
                tungstenite::Message::Close(frame) => {
                    return Err(diag::fail(
                        SCOPE,
                        "closed_before_completed",
                        format!("The server closed the connection before returning a result: {}", close_reason(frame)),
                    ));
                }
                _ => {}
            }
        }
        Err(diag::fail(SCOPE, "closed_before_completed", "The connection ended before returning a result".to_string()))
    })
    .await
    .map_err(|_| diag::fail(SCOPE, "collect_timeout", "Timed out waiting for the recognition result".to_string()))??;

    // 结果已经到手，收尾失败不影响本次识别
    let _ = ws
        .send(tungstenite::Message::Text(
            serde_json::json!({ "event_id": "finish", "type": "session.finish" }).to_string().into(),
        ))
        .await;
    let _ = ws.close(None).await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    if text.is_empty() {
        diag::empty_result(SCOPE, &format!("Commit completed with no transcript audio_sec={:.1} elapsed={}ms", audio_sec, elapsed_ms));
    } else {
        diag::ok(SCOPE, elapsed_ms, text.chars().count());
    }
    Ok(AsrResult { text, elapsed_ms })
}

/// 设置页「测试连接」：握手 + session.update 被接受就算通。
/// 以前这里走的是 asr_qwen::test_connection，测的是 qwen3-asr-flash 的 HTTP 接口。
pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let start = Instant::now();
    let workspace = config
        .extra
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let result = async {
        let mut ws = connect(&config.api_key, &workspace, "test").await?;
        configure_session(&mut ws, 16000, None, serde_json::Value::Null).await?;
        let _ = ws.close(None).await;
        Ok::<(), String>(())
    }
    .await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(()) => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: format!("model: {}", MODEL),
        },
        Err(message) => TestResult { ok: false, message, elapsed_ms, detail: String::new() },
    }
}

/// 打开千问实时 ASR 会话
///
/// hotwords：热词列表，通过 session.input_audio_transcription.corpus.text 上下文偏置（最多 10000 tokens）
/// realtime：是否开启实时显示（中间结果上抛）
#[tauri::command]
pub async fn qwen_stream_open(
    app: AppHandle,
    config: AsrProviderConfig,
    hotwords: Option<Vec<String>>,
    realtime: Option<bool>,
    workspace_id: Option<String>,
) -> Result<(), String> {
    let realtime = realtime.unwrap_or(false);

    // 关闭遗留会话
    cleanup_realtime().await;
    {
        let mut session = SESSION.lock().await;
        if let Some(mut ws) = session.take() {
            let _ = ws.close(None).await;
        }
    }

    let workspace = workspace_id.unwrap_or_default();
    let mut ws = connect(&config.api_key, &workspace, &format!("stream realtime={}", realtime)).await?;
    // 字段对齐官方 SDK：modalities: ["text"] + 音频格式/采样率 + 语言 + VAD。
    // 边录边发要靠 server_vad 自己切句、逐句出 completed。
    configure_session(
        &mut ws,
        16000,
        hotwords.as_deref(),
        serde_json::json!({
            "type": "server_vad",
            "threshold": 0.0,
            "silence_duration_ms": 400
        }),
    )
    .await?;

    if realtime {
        let (sink, stream) = ws.split();
        {
            let mut st = RT_STATE.lock().await;
            *st = RtState::default();
        }
        *RT_SINK.lock().await = Some(sink);
        let handle = tokio::spawn(run_realtime_reader(stream, app.clone(), RT_STATE.clone()));
        *RT_READER.lock().await = Some(handle);
        RT_ACTIVE.store(true, Ordering::SeqCst);
    } else {
        RT_ACTIVE.store(false, Ordering::SeqCst);
        *SESSION.lock().await = Some(ws);
    }

    Ok(())
}

/// 后台 reader：读取识别事件，累积文本并上抛中间结果。
async fn run_realtime_reader(
    mut stream: SplitStream<WsStream>,
    app: AppHandle,
    state: Arc<Mutex<RtState>>,
) {
    crate::commands::system::write_log_line("[RUST] [qwen_stream] realtime reader spawned");
    let mut emit_count = 0usize;
    while let Some(msg) = stream.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => {
                let mut s = state.lock().await;
                s.finished = true;
                break;
            }
        };

        let text = match msg {
            tungstenite::Message::Text(t) => t,
            tungstenite::Message::Close(_) => {
                let mut s = state.lock().await;
                s.finished = true;
                break;
            }
            _ => continue,
        };

        let data = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let event_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            // Qwen 实时中间结果：text 为当前句到目前为止的识别文本，stash 为不稳定的预测尾巴。
            // 这是 qwen3-asr-flash-realtime 实际使用的增量事件（非 OpenAI 风格的 .delta）。
            "conversation.item.input_audio_transcription.text" => {
                let cur = data.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let stash = data.get("stash").and_then(|t| t.as_str()).unwrap_or("");
                if !cur.is_empty() || !stash.is_empty() {
                    let display = {
                        let mut s = state.lock().await;
                        // text 是"当前句"的全量文本（非增量），直接覆盖 partial
                        s.partial = format!("{}{}", cur, stash);
                        s.display()
                    };
                    emit_count += 1;
                    if emit_count == 1 {
                        crate::commands::system::write_log_line(
                            "[RUST] [qwen_stream] emitted first asr-partial (text)",
                        );
                    }
                    let _ = app.emit(
                        "asr-partial",
                        serde_json::json!({ "text": display, "provider": "qwen" }),
                    );
                }
            }
            // 兼容 OpenAI 风格的增量事件（部分快照/模型可能使用）
            "conversation.item.input_audio_transcription.delta" => {
                if let Some(delta) = data.get("delta").and_then(|t| t.as_str()) {
                    if !delta.is_empty() {
                        let display = {
                            let mut s = state.lock().await;
                            s.partial.push_str(delta);
                            s.display()
                        };
                        let _ = app.emit(
                            "asr-partial",
                            serde_json::json!({ "text": display, "provider": "qwen" }),
                        );
                    }
                }
            }
            // 分句确定：并入 committed，清空 partial，并上抛
            "conversation.item.input_audio_transcription.completed" => {
                if let Some(transcript) = data.get("transcript").and_then(|t| t.as_str()) {
                    if !transcript.is_empty() {
                        let display = {
                            let mut s = state.lock().await;
                            if !s.committed.is_empty() {
                                s.committed.push_str("，");
                            }
                            s.committed.push_str(transcript);
                            s.partial.clear();
                            s.display()
                        };
                        let _ = app.emit(
                            "asr-partial",
                            serde_json::json!({ "text": display, "provider": "qwen" }),
                        );
                    }
                }
            }
            "session.finished" => {
                let mut s = state.lock().await;
                s.finished = true;
                break;
            }
            "error" => {
                let err_msg = data
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error")
                    .to_string();
                let mut s = state.lock().await;
                s.error = Some(err_msg);
                s.finished = true;
                break;
            }
            _ => {}
        }
    }
    crate::commands::system::write_log_line(&format!(
        "[RUST] [qwen_stream] reader stopped emits={}",
        emit_count
    ));
    let mut s = state.lock().await;
    s.finished = true;
}

async fn cleanup_realtime() {
    RT_ACTIVE.store(false, Ordering::SeqCst);
    if let Some(mut sink) = RT_SINK.lock().await.take() {
        let _ = sink.close().await;
    }
    if let Some(handle) = RT_READER.lock().await.take() {
        handle.abort();
    }
    let mut st = RT_STATE.lock().await;
    *st = RtState::default();
}

/// 发送音频数据
#[tauri::command]
pub async fn qwen_stream_send(pcm_b64: String) -> Result<(), String> {
    let event = serde_json::json!({
        "event_id": format!("audio_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
        "type": "input_audio_buffer.append",
        "audio": pcm_b64
    });
    let payload = serde_json::to_string(&event).unwrap();

    if RT_ACTIVE.load(Ordering::SeqCst) {
        let mut sink = RT_SINK.lock().await;
        let s = sink.as_mut().ok_or_else(|| diag::fail("qwen/realtime", "send_without_session", "Session is not open".to_string()))?;
        s.send(tungstenite::Message::Text(payload.into()))
            .await
            .map_err(|e| diag::fail("qwen/realtime", "send_audio", format!("Failed to send audio: {}", e)))?;
        return Ok(());
    }

    let mut session = SESSION.lock().await;
    let ws = session.as_mut().ok_or_else(|| diag::fail("qwen/realtime", "send_without_session", "Session is not open".to_string()))?;
    ws.send(tungstenite::Message::Text(payload.into()))
        .await
        .map_err(|e| diag::fail("qwen/realtime", "send_audio", format!("Failed to send audio: {}", e)))?;

    Ok(())
}

/// 结束会话并等待最终结果
#[tauri::command]
pub async fn qwen_stream_finish() -> Result<String, String> {
    let finish_event = serde_json::json!({
        "event_id": "finish",
        "type": "session.finish"
    });
    let finish_payload = serde_json::to_string(&finish_event).unwrap();

    // 实时模式：通过发送端发 finish，等待后台 reader 收尾
    if RT_ACTIVE.load(Ordering::SeqCst) {
        {
            let mut sink = RT_SINK.lock().await;
            let s = sink.as_mut().ok_or_else(|| diag::fail("qwen/realtime", "finish_without_session", "Session is not open".to_string()))?;
            s.send(tungstenite::Message::Text(finish_payload.into()))
                .await
                .map_err(|e| diag::fail("qwen/realtime", "send_finish", format!("Failed to send finish event: {}", e)))?;
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            {
                let st = RT_STATE.lock().await;
                if st.finished {
                    if let Some(err) = st.error.clone() {
                        drop(st);
                        cleanup_realtime().await;
                        return Err(diag::fail("qwen/realtime", "recognition_error", format!("Recognition error: {}", err)));
                    }
                    // display() = 已确定分句 + 尚未 completed 的当前句，避免丢掉最后一句
                    let text = st.display();
                    drop(st);
                    cleanup_realtime().await;
                    return Ok(text);
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }

        let text = RT_STATE.lock().await.display();
        cleanup_realtime().await;
        return Ok(text);
    }

    // 普通模式：整条会话同步收结果
    let mut session = SESSION.lock().await;
    let ws = session.as_mut().ok_or_else(|| diag::fail("qwen/realtime", "finish_without_session", "Session is not open".to_string()))?;

    ws.send(tungstenite::Message::Text(finish_payload.into()))
        .await
        .map_err(|e| diag::fail("qwen/realtime", "send_finish", format!("Failed to send finish event: {}", e)))?;

    let mut final_text = String::new();
    let mut completed_count = 0usize;

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| diag::fail("qwen/realtime", "recv", format!("Failed to receive result: {}", e)))?;
        if let tungstenite::Message::Text(text) = msg {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                let event_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match event_type {
                    "conversation.item.input_audio_transcription.completed" => {
                        if let Some(transcript) = data.get("transcript").and_then(|t| t.as_str()) {
                            if !transcript.is_empty() {
                                completed_count += 1;
                                if !final_text.is_empty() {
                                    final_text.push_str("，");
                                }
                                final_text.push_str(transcript);
                            }
                        }
                    }
                    "session.finished" => {
                        break;
                    }
                    "error" => {
                        let err_msg = data
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error");
                        let _ = ws.close(None).await;
                        *session = None;
                        return Err(diag::fail("qwen/realtime", "recognition_error", format!("Recognition error: {}", err_msg)));
                    }
                    _ => {}
                }
            }
        }
    }

    crate::commands::system::write_log_line(&format!(
        "[RUST] [qwen_stream] finished completedSegments={} utf8Len={} utf16Len={}",
        completed_count,
        final_text.len(),
        final_text.encode_utf16().count()
    ));
    let _ = ws.close(None).await;
    *session = None;

    Ok(final_text)
}

/// 关闭会话
#[tauri::command]
pub async fn qwen_stream_close() -> Result<(), String> {
    if RT_ACTIVE.load(Ordering::SeqCst) {
        cleanup_realtime().await;
        return Ok(());
    }
    let mut session = SESSION.lock().await;
    if let Some(mut ws) = session.take() {
        let _ = ws.close(None).await;
    }
    Ok(())
}
