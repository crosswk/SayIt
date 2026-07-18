// 豆包流式语音识别 2.0 — 实时流式会话管理
// 支持边录边发：start 时建连，send_chunk 实时发送音频，finish 发最后一包等结果
//
// 两种模式：
//  - 普通模式（realtime=false）：用 bigmodel_nostream 端点，只在最后一包后返回结果，准确率更高（默认）。
//  - 实时显示模式（realtime=true）：用 bigmodel 双向流式端点，边说边返回中间结果；
//    后台 reader 持续读取并通过 `asr-partial` 事件上抛给前端做悬浮窗实时上屏。
//    识别完成后，finish 返回累计的最终文本，仍会照常交给 AI 处理。

use super::doubao_protocol;
use super::types::AsrProviderConfig;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;

// 流式输入模式（非实时，准确率更高）
const WS_URL_NOSTREAM: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
// 双向流式模式（实时，边说边出字）
const WS_URL_STREAM: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
// 双向流式优化版（官方更推荐，时延更优，只在结果变化时返回新包）
const WS_URL_STREAM_ASYNC: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
// 豆包 Seed-ASR 2.0 资源 ID：小时版(包时) / 并发版(按量)。
// 双向流式端点对资源授权更严格，不同账号可能只开通了其中之一，实时连接时依次尝试。
const RESOURCE_ID_DURATION: &str = "volc.seedasr.sauc.duration";
const RESOURCE_ID_CONCURRENT: &str = "volc.seedasr.sauc.concurrent";

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;

/// 普通模式（nostream）会话状态：整条 WebSocket 直接持有。
static SESSION: once_cell::sync::Lazy<Arc<Mutex<Option<WsStream>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式：拆分后的发送端（写半边）。读半边交给后台 reader。
static RT_SINK: once_cell::sync::Lazy<Arc<Mutex<Option<WsSink>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式后台 reader 任务句柄（用于中止）。
static RT_READER: once_cell::sync::Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式共享状态：累计文本 / 是否结束 / 错误。
#[derive(Default)]
struct RtState {
    text: String,
    finished: bool,
    error: Option<String>,
}

static RT_STATE: once_cell::sync::Lazy<Arc<Mutex<RtState>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(RtState::default())));

/// 当前是否处于实时模式会话。
static RT_ACTIVE: AtomicBool = AtomicBool::new(false);

fn build_client_request_json(
    app_id: &str,
    sample_rate: u32,
    hotwords: &Option<Vec<String>>,
) -> String {
    let mut request_params = serde_json::json!({
        "model_name": "bigmodel",
        "enable_itn": true,
        "enable_punc": true,
        "result_type": "full",
        "show_utterances": true
    });
    if let Some(words) = hotwords {
        if let Some(ctx) = doubao_protocol::build_hotword_context(words) {
            // 热词须放在 request.corpus.context（非 request.context），否则流式接口不生效。
            // 注意：双向流式模式 context 上限约 100 tokens，超出会被服务端截断。
            request_params["corpus"] = serde_json::json!({ "context": ctx });
        }
    }

    let client_request = serde_json::json!({
        "user": { "uid": app_id },
        "audio": {
            "format": "pcm",
            "rate": sample_rate,
            "bits": 16,
            "channel": 1
        },
        "request": request_params
    });
    serde_json::to_string(&client_request).unwrap()
}

fn build_handshake_request(
    url: &str,
    app_id: &str,
    access_key: &str,
    resource_id: &str,
) -> Result<tungstenite::http::Request<()>, String> {
    tungstenite::http::Request::builder()
        .uri(url)
        .header("Host", "openspeech.bytedance.com")
        .header("X-Api-App-Key", app_id)
        .header("X-Api-Access-Key", access_key)
        .header("X-Api-Resource-Id", resource_id)
        // 双向流式端点(bigmodel)要求带 X-Api-Request-Id，否则网关直接 400（nostream 不带也能过）
        .header("X-Api-Request-Id", uuid::Uuid::new_v4().to_string())
        .header("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string())
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        )
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .body(())
        .map_err(|e| format!("构建请求失败: {}", e))
}

/// 把 WebSocket 握手错误展开成可读字符串；HTTP 错误会带上状态码和响应体，方便定位 400 的真实原因。
fn describe_ws_error(err: &tungstenite::Error) -> String {
    match err {
        tungstenite::Error::Http(resp) => {
            let status = resp.status();
            let body = resp
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "<empty body>".to_string());
            format!("HTTP {} body={}", status, body)
        }
        other => other.to_string(),
    }
}

/// 打开豆包流式 ASR 会话：建立 WebSocket 连接并发送 client request
///
/// hotwords：热词列表，会通过 request.context 字段直传给服务端（流式输入模式最多 5000 词）
/// realtime：是否开启实时显示（双向流式 + 中间结果上抛）
#[tauri::command]
pub async fn doubao_stream_open(
    app: AppHandle,
    config: AsrProviderConfig,
    sample_rate: u32,
    hotwords: Option<Vec<String>>,
    realtime: Option<bool>,
) -> Result<(), String> {
    let realtime = realtime.unwrap_or(false);

    // 关闭任何遗留会话（两种模式都清）
    cleanup_realtime().await;
    {
        let mut session = SESSION.lock().await;
        if let Some(mut ws) = session.take() {
            let _ = ws.close(None).await;
        }
    }

    let app_id = if config.app_id.is_empty() {
        &config.api_key
    } else {
        &config.app_id
    };

    // 实时：按顺序尝试多个「端点 × 资源」组合，优先推荐的 async 端点 + 用户手里的 duration 资源。
    // 非实时：沿用一直可用的 nostream + duration。
    let candidates: &[(&str, &str)] = if realtime {
        &[
            (WS_URL_STREAM_ASYNC, RESOURCE_ID_DURATION),
            (WS_URL_STREAM, RESOURCE_ID_DURATION),
            (WS_URL_STREAM_ASYNC, RESOURCE_ID_CONCURRENT),
            (WS_URL_STREAM, RESOURCE_ID_CONCURRENT),
        ]
    } else {
        &[(WS_URL_NOSTREAM, RESOURCE_ID_DURATION)]
    };

    let mut connected: Option<WsStream> = None;
    let mut chosen_url = WS_URL_NOSTREAM;
    let mut last_err = String::from("未知错误");
    for (url, resource_id) in candidates {
        let request = build_handshake_request(url, app_id, &config.api_key, resource_id)?;
        match tokio_tungstenite::connect_async(request).await {
            Ok((sock, _)) => {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [doubao_stream] connected realtime={} url={} resourceId={}",
                    realtime, url, resource_id
                ));
                connected = Some(sock);
                chosen_url = url;
                break;
            }
            Err(e) => {
                last_err = describe_ws_error(&e);
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [doubao_stream] connect FAILED realtime={} url={} resourceId={} err={}",
                    realtime, url, resource_id, last_err
                ));
            }
        }
    }
    let mut ws = connected.ok_or_else(|| format!("WebSocket 连接失败: {}", last_err))?;

    // 发送 full client request
    let client_request = build_client_request_json(app_id, sample_rate, &hotwords);
    let frame = doubao_protocol::build_full_client_request(&client_request);
    ws.send(tungstenite::Message::Binary(frame.into()))
        .await
        .map_err(|e| format!("发送请求失败: {}", e))?;

    // 等待服务端确认（第一包 server response）
    if let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("接收确认失败: {}", e))?;
        if let tungstenite::Message::Binary(data) = msg {
            let resp = doubao_protocol::parse_server_response(&data)?;
            if resp.is_error {
                return Err(format!("服务端错误: {}", resp.payload));
            }
        }
    }

    if realtime {
        // 拆分为读写两半：写半边留给 send/finish，读半边交给后台 reader 持续读中间结果
        let (sink, stream) = ws.split();
        {
            let mut st = RT_STATE.lock().await;
            *st = RtState::default();
        }
        *RT_SINK.lock().await = Some(sink);
        let handle = tokio::spawn(run_realtime_reader(stream, app.clone(), RT_STATE.clone()));
        *RT_READER.lock().await = Some(handle);
        RT_ACTIVE.store(true, Ordering::SeqCst);
        crate::commands::system::write_log_line(&format!(
            "[RUST] [doubao_stream] realtime mode ON, endpoint={} reader spawned",
            chosen_url
        ));
    } else {
        RT_ACTIVE.store(false, Ordering::SeqCst);
        *SESSION.lock().await = Some(ws);
    }

    Ok(())
}

/// 后台 reader：持续读取服务端识别结果，更新累计文本并通过事件上抛中间结果。
async fn run_realtime_reader(
    mut stream: SplitStream<WsStream>,
    app: AppHandle,
    state: Arc<Mutex<RtState>>,
) {
    let mut frame_count = 0usize;
    let mut emit_count = 0usize;
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(tungstenite::Message::Binary(data)) => {
                frame_count += 1;
                let resp = match doubao_protocol::parse_server_response(&data) {
                    Ok(r) => r,
                    Err(_) => continue, // 忽略无法解析的帧，等下一包
                };

                if resp.is_error {
                    let mut s = state.lock().await;
                    // 「last packet has been received already」属于良性收尾竞争：
                    // 服务端已经因为收到过负包/VAD 自动收尾而结束，此时应当用已累计文本正常收尾，
                    // 而不是把整条识别判为失败。
                    if resp.payload.contains("last packet has been received")
                        || resp.payload.contains("last package has been received")
                    {
                        crate::commands::system::write_log_line(
                            "[RUST] [doubao_stream] benign end: last packet already received",
                        );
                    } else {
                        s.error = Some(resp.payload.clone());
                    }
                    s.finished = true;
                    break;
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&resp.payload) {
                    if let Some(text) = json
                        .get("result")
                        .and_then(|r| r.get("text"))
                        .and_then(|t| t.as_str())
                    {
                        if !text.is_empty() {
                            {
                                let mut s = state.lock().await;
                                s.text = text.to_string();
                            }
                            emit_count += 1;
                            if emit_count == 1 {
                                crate::commands::system::write_log_line(
                                    "[RUST] [doubao_stream] emitted first asr-partial",
                                );
                            }
                            let _ = app.emit(
                                "asr-partial",
                                serde_json::json!({ "text": text, "provider": "doubao" }),
                            );
                        }
                    }
                }

                if resp.is_last {
                    let mut s = state.lock().await;
                    s.finished = true;
                    break;
                }
            }
            Ok(tungstenite::Message::Close(_)) | Err(_) => {
                let mut s = state.lock().await;
                s.finished = true;
                break;
            }
            Ok(_) => {}
        }
    }
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao_stream] reader stopped frames={} emits={}",
        frame_count, emit_count
    ));
    // 兜底：无论如何退出都标记结束，避免 finish 卡等
    let mut s = state.lock().await;
    s.finished = true;
}

/// 清理实时模式资源（关闭发送端、中止 reader、重置状态）。
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

/// 发送一个音频包（非最后一包）
#[tauri::command]
pub async fn doubao_stream_send(pcm_b64: String) -> Result<(), String> {
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &pcm_b64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let frame = doubao_protocol::build_audio_request(&pcm, false);

    if RT_ACTIVE.load(Ordering::SeqCst) {
        let mut sink = RT_SINK.lock().await;
        let s = sink.as_mut().ok_or("会话未建立")?;
        s.send(tungstenite::Message::Binary(frame.into()))
            .await
            .map_err(|e| format!("发送音频失败: {}", e))?;
        return Ok(());
    }

    let mut session = SESSION.lock().await;
    let ws = session.as_mut().ok_or("会话未建立")?;
    ws.send(tungstenite::Message::Binary(frame.into()))
        .await
        .map_err(|e| format!("发送音频失败: {}", e))?;

    Ok(())
}

/// 发送最后一包并等待最终识别结果
#[tauri::command]
pub async fn doubao_stream_finish() -> Result<String, String> {
    // 实时模式：通过发送端发最后一包，等待后台 reader 读到最终结果
    if RT_ACTIVE.load(Ordering::SeqCst) {
        // 若 reader 已经自然收尾（VAD/服务端已结束），就不要再发负包，避免重复末包报错。
        let already_finished = { RT_STATE.lock().await.finished };
        if !already_finished {
            let mut sink = RT_SINK.lock().await;
            if let Some(s) = sink.as_mut() {
                let frame = doubao_protocol::build_audio_request(&[], true);
                // 发送失败不致命：可能服务端已经收尾，继续读已累计文本即可。
                if let Err(e) = s.send(tungstenite::Message::Binary(frame.into())).await {
                    crate::commands::system::write_log_line(&format!(
                        "[RUST] [doubao_stream] finish send last-packet err(ignored)={}",
                        e
                    ));
                }
            }
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            {
                let st = RT_STATE.lock().await;
                if st.finished {
                    if let Some(err) = st.error.clone() {
                        drop(st);
                        cleanup_realtime().await;
                        return Err(format!("识别错误: {}", err));
                    }
                    let text = st.text.clone();
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

        // 超时：返回目前已累计的文本，避免整体失败
        let text = RT_STATE.lock().await.text.clone();
        cleanup_realtime().await;
        return Ok(text);
    }

    // 普通模式（nostream）：整条会话同步收结果
    let mut session = SESSION.lock().await;
    let ws = session.as_mut().ok_or("会话未建立")?;

    // 发送空的最后一包（负包）
    let frame = doubao_protocol::build_audio_request(&[], true);
    ws.send(tungstenite::Message::Binary(frame.into()))
        .await
        .map_err(|e| format!("发送最后一包失败: {}", e))?;

    // 接收最终结果
    let mut final_text = String::new();

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("接收结果失败: {}", e))?;
        match msg {
            tungstenite::Message::Binary(data) => {
                let resp = doubao_protocol::parse_server_response(&data)?;
                if resp.is_error {
                    // 关闭会话
                    let _ = ws.close(None).await;
                    *session = None;
                    return Err(format!("识别错误: {}", resp.payload));
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&resp.payload) {
                    if let Some(text) = json
                        .get("result")
                        .and_then(|r| r.get("text"))
                        .and_then(|t| t.as_str())
                    {
                        if !text.is_empty() {
                            final_text = text.to_string();
                        }
                    }
                }

                if resp.is_last {
                    break;
                }
            }
            tungstenite::Message::Close(_) => break,
            _ => {}
        }
    }

    // 关闭连接
    let _ = ws.close(None).await;
    *session = None;

    Ok(final_text)
}

/// 关闭会话（异常中断时调用）
#[tauri::command]
pub async fn doubao_stream_close() -> Result<(), String> {
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
