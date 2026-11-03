// 豆包流式语音识别 2.0 — 边录边发的会话管理
// start 时建连，send 实时发送音频，finish 发最后一包等结果
//
// 两种模式：
//  - 普通模式（realtime=false）：bigmodel_nostream 端点，准确率更高（默认）。
//  - 实时显示模式（realtime=true）：bigmodel(_async) 双向流式端点，边说边返回中间结果，
//    通过 `asr-partial` 事件上抛给前端做悬浮窗实时上屏。
//
// **两种模式都必须边发边读**（官方文档：两个端点都是「每输入一个包返回一个包」）。
// 以前普通模式录音期间一帧都不读，2026-10-27 实测 120 秒录音服务端回了 605 帧、4.76 MB，
// 全堆在接收缓冲里；用户网络上某个环节缓冲一满就被流控卡死，服务端 5 秒收不到包就结束会话
// （45000081 等包超时），客户端要到松键才发现（诊断包 61c93385，>90 秒录音 4/10 失败）。
// 所以普通模式也拆成写半边 + 后台 reader，只是不 emit。见 .kiro/decisions.md「豆包长录音失败」。

use super::diag;
use super::doubao_auth::{self, DoubaoAuth};
use super::doubao_protocol;
use super::types::AsrProviderConfig;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// 发完最后一包后等最终结果的上限。nostream 实测松键后 0.6~1.3 秒出全文。
const FINISH_TIMEOUT: Duration = Duration::from_secs(15);

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;

/// 会话的发送端（写半边）。读半边交给后台 reader。
static SINK: once_cell::sync::Lazy<Arc<Mutex<Option<WsSink>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 后台 reader 任务句柄（用于中止）。
static READER: once_cell::sync::Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 会话共享状态：累计文本 / 是否结束 / 错误。
#[derive(Default)]
struct SessionState {
    text: String,
    finished: bool,
    error: Option<String>,
}

static STATE: once_cell::sync::Lazy<Arc<Mutex<SessionState>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(SessionState::default())));

/// 当前是否有会话。
static ACTIVE: AtomicBool = AtomicBool::new(false);

// ── 发送节奏记账：排查「服务端等包超时」时要知道是不是我们自己停发了 ──
static OPENED_AT_MS: AtomicU64 = AtomicU64::new(0);
static LAST_SEND_MS: AtomicU64 = AtomicU64::new(0);
static MAX_SEND_GAP_MS: AtomicU64 = AtomicU64::new(0);
static SENT_PACKETS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn reset_send_stats() {
    let now = now_ms();
    OPENED_AT_MS.store(now, Ordering::SeqCst);
    LAST_SEND_MS.store(now, Ordering::SeqCst);
    MAX_SEND_GAP_MS.store(0, Ordering::SeqCst);
    SENT_PACKETS.store(0, Ordering::SeqCst);
}

fn record_send() {
    let now = now_ms();
    let last = LAST_SEND_MS.swap(now, Ordering::SeqCst);
    MAX_SEND_GAP_MS.fetch_max(now.saturating_sub(last), Ordering::SeqCst);
    SENT_PACKETS.fetch_add(1, Ordering::SeqCst);
}

fn send_stats() -> String {
    let opened = OPENED_AT_MS.load(Ordering::SeqCst);
    format!(
        "packets={} max_send_gap_ms={} since_last_send_ms={} session_ms={}",
        SENT_PACKETS.load(Ordering::SeqCst),
        MAX_SEND_GAP_MS.load(Ordering::SeqCst),
        now_ms().saturating_sub(LAST_SEND_MS.load(Ordering::SeqCst)),
        now_ms().saturating_sub(opened)
    )
}

fn build_client_request_json(
    uid: &str,
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
        "user": { "uid": uid },
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
    auth: &DoubaoAuth<'_>,
    resource_id: &str,
) -> Result<tungstenite::http::Request<()>, String> {
    let mut builder = tungstenite::http::Request::builder()
        .uri(url)
        .header("Host", "openspeech.bytedance.com")
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
        .header("Upgrade", "websocket");
    // 鉴权头按控制台代次不同：新版只有 X-Api-Key，旧版是 App Key + Access Key
    for (name, value) in auth.headers() {
        builder = builder.header(name, value);
    }
    builder
        .body(())
        .map_err(|e| format!("Failed to build request: {}", e))
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
/// hotwords：热词列表，会通过 request.corpus.context 字段直传给服务端（流式输入模式最多 5000 词）
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

    // 关闭遗留会话
    cleanup_session().await;

    let auth = DoubaoAuth::from_config(&config);
    if let Some(missing) = auth.missing_field() {
        return Err(diag::fail_code(
            "doubao/realtime",
            "credentials",
            "provider_bad_key",
            format!("Doubao ASR is missing {}; complete it in Settings", missing),
        ));
    }
    let uid = auth.uid().to_string();

    // 实时：按顺序尝试多个「端点 × 资源」组合，优先推荐的 async 端点 + 用户手里的 duration 资源。
    // 非实时：沿用一直可用的 nostream，同样在小时版/并发版之间兜底。
    let candidates: &[(&str, &str)] = if realtime {
        &[
            (WS_URL_STREAM_ASYNC, RESOURCE_ID_DURATION),
            (WS_URL_STREAM, RESOURCE_ID_DURATION),
            (WS_URL_STREAM_ASYNC, RESOURCE_ID_CONCURRENT),
            (WS_URL_STREAM, RESOURCE_ID_CONCURRENT),
        ]
    } else {
        &[
            (WS_URL_NOSTREAM, RESOURCE_ID_DURATION),
            (WS_URL_NOSTREAM, RESOURCE_ID_CONCURRENT),
        ]
    };

    let mut connected: Option<WsStream> = None;
    let mut chosen_url = WS_URL_NOSTREAM;
    let mut last_err = String::from("Unknown error");
    for (url, resource_id) in candidates {
        let request = build_handshake_request(url, &auth, resource_id)
            .map_err(|e| diag::fail("doubao/realtime", "build_request", e))?;
        match tokio_tungstenite::connect_async(request).await {
            Ok((sock, response)) => {
                doubao_auth::log_ws_logid(
                    &format!(
                        "stream realtime={} url={} resourceId={} auth={}",
                        realtime,
                        url,
                        resource_id,
                        auth.mode_name()
                    ),
                    &response,
                );
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
    let mut ws = connected.ok_or_else(|| diag::fail("doubao/realtime", "connect", format!("WebSocket connection failed: {}", last_err)))?;

    // 发送 full client request
    let client_request = build_client_request_json(&uid, sample_rate, &hotwords);
    let frame = doubao_protocol::build_full_client_request(&client_request);
    ws.send(tungstenite::Message::Binary(frame.into()))
        .await
        .map_err(|e| diag::fail("doubao/realtime", "send_request", format!("Failed to send request: {}", e)))?;

    // 等待服务端确认（第一包 server response）
    if let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| diag::fail("doubao/realtime", "recv_ack", format!("Failed to receive acknowledgement: {}", e)))?;
        if let tungstenite::Message::Binary(data) = msg {
            let resp = doubao_protocol::parse_server_response(&data)
                .map_err(|e| diag::fail("doubao/realtime", "parse_ack", e))?;
            if resp.is_error {
                return Err(diag::fail("doubao/realtime", "server_error_on_ack", format!("Server error: {}", resp.payload)));
            }
        }
    }

    // 拆成读写两半：写半边留给 send/finish，读半边交给后台 reader 一直读。
    let (sink, stream) = ws.split();
    *STATE.lock().await = SessionState::default();
    *SINK.lock().await = Some(sink);
    reset_send_stats();
    let handle = tokio::spawn(run_reader(stream, app.clone(), STATE.clone(), realtime));
    *READER.lock().await = Some(handle);
    ACTIVE.store(true, Ordering::SeqCst);
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao_stream] session open realtime={} endpoint={} reader spawned",
        realtime, chosen_url
    ));

    Ok(())
}

/// 后台 reader：持续读取服务端回包，更新累计文本；实时模式下上抛中间结果。
///
/// 连接在收到最后一包结果**之前**断开，一律记成错误（以前记成正常结束，finish 会带着
/// 半截文本甚至空文本返回成功）。前端拿到错误后会用手里的完整音频再识别一次。
async fn run_reader(
    mut stream: SplitStream<WsStream>,
    app: AppHandle,
    state: Arc<Mutex<SessionState>>,
    emit_partials: bool,
) {
    let mut frame_count = 0usize;
    let mut emit_count = 0usize;
    let mut ended_cleanly = false;
    let mut abnormal: Option<String> = None;
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(tungstenite::Message::Binary(data)) => {
                frame_count += 1;
                let resp = match doubao_protocol::parse_server_response(&data) {
                    Ok(r) => r,
                    Err(_) => continue, // 忽略无法解析的帧，等下一包
                };

                if resp.is_error {
                    // 「last packet has been received already」属于良性收尾竞争：
                    // 服务端已经因为收到过负包/VAD 自动收尾而结束，此时应当用已累计文本正常收尾，
                    // 而不是把整条识别判为失败。
                    if resp.payload.contains("last packet has been received")
                        || resp.payload.contains("last package has been received")
                    {
                        crate::commands::system::write_log_line(
                            "[RUST] [doubao_stream] benign end: last packet already received",
                        );
                        ended_cleanly = true;
                    } else {
                        abnormal = Some(format!("server error: {}", resp.payload));
                    }
                    break;
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&resp.payload) {
                    if let Some(text) = json
                        .get("result")
                        .and_then(|r| r.get("text"))
                        .and_then(|t| t.as_str())
                    {
                        if !text.is_empty() {
                            state.lock().await.text = text.to_string();
                            if emit_partials {
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
                }

                if resp.is_last {
                    ended_cleanly = true;
                    break;
                }
            }
            Ok(tungstenite::Message::Close(frame)) => {
                let reason = frame
                    .map(|f| format!("code={} reason={}", u16::from(f.code), f.reason))
                    .unwrap_or_else(|| "no close frame".to_string());
                abnormal = Some(format!("server closed the connection before the final result ({})", reason));
                break;
            }
            Err(e) => {
                abnormal = Some(format!("connection dropped before the final result: {}", e));
                break;
            }
            Ok(_) => {}
        }
    }
    if !ended_cleanly && abnormal.is_none() {
        abnormal = Some("connection ended before the final result".to_string());
    }
    // 这一行是「谁先断的、断在什么时候」的唯一证据：session_ms 是建连到此刻的时长，
    // since_last_send_ms 大说明是我们自己停发了，小说明是服务端 / 网络掐的。
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao_stream] reader stopped clean={} frames={} emits={} {}{}",
        ended_cleanly,
        frame_count,
        emit_count,
        send_stats(),
        abnormal.as_deref().map(|a| format!(" err={}", a)).unwrap_or_default()
    ));
    let mut s = state.lock().await;
    if s.error.is_none() {
        s.error = abnormal;
    }
    s.finished = true;
}

/// 清理会话资源（关闭发送端、中止 reader、重置状态）。
async fn cleanup_session() {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Some(mut sink) = SINK.lock().await.take() {
        let _ = sink.close().await;
    }
    if let Some(handle) = READER.lock().await.take() {
        handle.abort();
    }
    *STATE.lock().await = SessionState::default();
}

/// 发送一个音频包（非最后一包）
#[tauri::command]
pub async fn doubao_stream_send(pcm_b64: String) -> Result<(), String> {
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &pcm_b64)
        .map_err(|e| diag::fail("doubao/realtime", "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;

    let frame = doubao_protocol::build_audio_request(&pcm, false);

    let mut sink = SINK.lock().await;
    let s = sink.as_mut().ok_or_else(|| diag::fail("doubao/realtime", "send_without_session", "Session is not open".to_string()))?;
    s.send(tungstenite::Message::Binary(frame.into()))
        .await
        .map_err(|e| diag::fail("doubao/realtime", "send_audio", format!("Failed to send audio: {}", e)))?;
    record_send();
    Ok(())
}

/// 发送最后一包并等待最终识别结果
///
/// 失败（服务端报错、连接提前断开、超时）一律返回 Err，**不返回半截文本**：前端手里有完整
/// 录音，会改走一次性上传重新识别。以前超时会把已累计的文本当成功结果返回，用户拿到的是
/// 被截掉后半段的文字，而且不会有任何提示。
#[tauri::command]
pub async fn doubao_stream_finish() -> Result<String, String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail("doubao/realtime", "finish_without_session", "Session is not open".to_string()));
    }
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao_stream] finish start {}",
        send_stats()
    ));

    // 若 reader 已经自然收尾（VAD/服务端已结束），就不要再发负包，避免重复末包报错。
    let already_finished = { STATE.lock().await.finished };
    if !already_finished {
        let mut sink = SINK.lock().await;
        if let Some(s) = sink.as_mut() {
            let frame = doubao_protocol::build_audio_request(&[], true);
            // 发送失败不在这里判死：连接若已断开，reader 会记下原因，下面统一返回。
            if let Err(e) = s.send(tungstenite::Message::Binary(frame.into())).await {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [doubao_stream] finish send last-packet err={}",
                    e
                ));
            }
        }
    }

    let deadline = Instant::now() + FINISH_TIMEOUT;
    loop {
        {
            let st = STATE.lock().await;
            if st.finished {
                let result = match st.error.clone() {
                    Some(err) => Err(err),
                    None => Ok(st.text.clone()),
                };
                drop(st);
                cleanup_session().await;
                return result.map_err(|err| {
                    diag::fail("doubao/realtime", "recognition_error", format!("Recognition error: {}", err))
                });
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    cleanup_session().await;
    Err(diag::fail(
        "doubao/realtime",
        "finish_timeout",
        format!("Timed out waiting for the final result after {}s", FINISH_TIMEOUT.as_secs()),
    ))
}

/// 关闭会话（异常中断时调用）
#[tauri::command]
pub async fn doubao_stream_close() -> Result<(), String> {
    cleanup_session().await;
    Ok(())
}
