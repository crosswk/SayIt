// xAI 语音转文字 — grok-voice-transcribe-2.0（issue #99）
//
// 一张卡两条路，和 OpenAI / Gemini 那两家一样：
//   · 实时字幕开着 → WebSocket `wss://api.x.ai/v1/stt`（xai_live_*）
//   · 实时字幕关着 → 一次性 REST `POST https://api.x.ai/v1/stt`（transcribe）
//
// 协议（https://docs.x.ai/developers/model-capabilities/audio/speech-to-text）：
//   REST：multipart/form-data，`file` 必须是**最后一个**字段（排在后面的选项会被忽略）。
//         原始 PCM 要带 `audio_format=pcm` + `sample_rate`，所以不用包 WAV 头。
//         返回 `{"text": ..., "language": ..., "duration": ..., "words": [...]}`。
//   WS：  配置全在 URL query 里，不发 setup 消息；鉴权用 Authorization 头。
//         等 `transcript.created` 再发音频；音频是**二进制帧**里的裸 PCM（不是 base64 JSON）；
//         结束发文本帧 `{"type":"audio.done"}`，服务端回 `transcript.done` 后关连接。
//
// 和别家不一样、容易写错的几处：
//   A. 16 kHz 是它的原生采样率（文档原话），直接发，不用像 OpenAI Realtime 那样转 24k。
//   B. 热词字段叫 `keyterm`，**重复**这个字段传多条，最多 100 条、每条不超过 50 个字符。
//      超长的那条我们直接丢掉（截断会变成一个错的词，偏置到错的地方去）。
//   C. 默认去掉「嗯、呃」这类口头禅（`filler_words=false`），正合口述的需要，不用改。
//   D. `format=true`（数字、金额写成书面形式）必须同时带 `language`。云端识别这条路
//      目前不传语种，所以不开 —— 带了 format 却没 language 会直接 400。
//
// ── 未经真实接口验证（没有 xAI key，照文档实现）──
//   1. `transcript.partial` 三种状态的拼接方式。文档说 `speech_final=true` 那条是
//      「完整拼接好的一整句」，`is_final=true` 是锁定的一小段（约 3 秒）。这里按
//      「整句来了就替掉本句攒的小段」处理；如果实际 speech_final 只给最后一小段，
//      症状是字幕和最终文本缺前半句 —— 但最终文本优先用 `transcript.done`，影响的只是字幕。
//   2. `transcript.done` 的 text 是整次会话的全文（文档示例把它当 Full transcript 打印）。
//      它为空时退回我们自己拼的结果。
//   3. 握手被拒（密钥错）时服务端回的是 HTTP 401 还是 error 事件，文档没说，两种都接。

use super::{diag, types::AsrProviderConfig, types::AsrResult, types::TestResult};
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

const REST_URL: &str = "https://api.x.ai/v1/stt";
const WS_URL: &str = "wss://api.x.ai/v1/stt";
const SCOPE: &str = "xai/stt";
const LIVE_SCOPE: &str = "xai/live";
const DEFAULT_MODEL: &str = "grok-voice-transcribe-2.0";
/// 整条链路是 16k 单声道 s16le（services/audio.ts），也是 xAI 的原生采样率。
const SAMPLE_RATE: u32 = 16000;
/// 文档上限：最多 100 条、每条不超过 50 个字符。
pub(crate) const KEYTERM_LIMIT: usize = 100;
const KEYTERM_MAX_CHARS: usize = 50;

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;

fn resolve_model(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string()
}

/// 热词 → keyterm：去空白、去重、丢掉超长的、最多 100 条。
fn keyterms(hotwords: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in hotwords {
        let word = word.trim();
        if word.is_empty() || word.chars().count() > KEYTERM_MAX_CHARS {
            continue;
        }
        if out.iter().any(|w| w == word) {
            continue;
        }
        out.push(word.to_string());
        if out.len() >= KEYTERM_LIMIT {
            break;
        }
    }
    out
}

fn log_keyterms(scope: &str, hotwords: &[String], sent: &[String]) {
    if hotwords.is_empty() {
        return;
    }
    // 只记条数，不记词本身
    diag::log(
        scope,
        "keyterms",
        &format!("sent={} of={} limit={}", sent.len(), hotwords.len(), KEYTERM_LIMIT),
    );
}

/// 401 单独标成「密钥被拒」，界面据此提示去检查密钥，而不是笼统的「连接失败」。
fn fail_for_status(scope: &str, status: u16, message: String) -> String {
    if status == 401 || status == 403 {
        diag::fail_code(scope, "http_status", "provider_bad_key", message)
    } else {
        diag::fail(scope, "http_status", message)
    }
}

// ─────────────────────────── 一次性 REST ───────────────────────────

/// 请求超时随音频时长放宽：5 分钟的录音上传 + 识别不该被 60 秒掐掉。
fn request_timeout(audio_sec: f64) -> Duration {
    Duration::from_secs((30.0 + audio_sec * 0.5).clamp(30.0, 300.0) as u64)
}

/// 发一次 REST。`pcm` 是 16 位小端裸 PCM。
async fn send_pcm(
    config: &AsrProviderConfig,
    pcm: Vec<u8>,
    sample_rate: u32,
    terms: &[String],
    scope: &str,
    timeout: Duration,
) -> Result<String, String> {
    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            scope,
            "credentials",
            "provider_bad_key",
            "xAI speech-to-text is missing the API Key; complete it in Settings".to_string(),
        ));
    }
    // 顺序有讲究：选项全部在前，file 必须最后（文档：排在 file 后面的字段可能被忽略）
    let mut form = reqwest::multipart::Form::new()
        .text("model", resolve_model(config))
        .text("audio_format", "pcm")
        .text("sample_rate", sample_rate.to_string());
    for term in terms {
        form = form.text("keyterm", term.clone());
    }
    let part = reqwest::multipart::Part::bytes(pcm)
        .file_name("audio.pcm")
        .mime_str("application/octet-stream")
        .map_err(|e| diag::fail(scope, "build_form", format!("Failed to build the audio part: {}", e)))?;
    let form = form.part("file", part);

    let resp = super::http_client::shared()
        .post(REST_URL)
        .header("Authorization", format!("Bearer {}", config.api_key.trim()))
        .multipart(form)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| diag::fail(scope, "http_send", format!("Request failed: {}", e)))?;

    let status = resp.status();
    let summary = diag::http_summary(status, resp.headers());
    let body = resp
        .text()
        .await
        .map_err(|e| diag::fail(scope, "read_body", format!("Failed to read response: {}", e)))?;
    if !status.is_success() {
        return Err(fail_for_status(
            scope,
            status.as_u16(),
            format!(
                "Transcription error {} [{}]: {}",
                status,
                summary,
                diag::truncate(&body, 300)
            ),
        ));
    }
    let data: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        diag::fail(
            scope,
            "parse_json",
            format!(
                "Failed to parse response: {} [{}] response excerpt: {}",
                e,
                summary,
                diag::truncate(&body, 200)
            ),
        )
    })?;
    // 200 却没有 text 字段算失败：协议没跑完却走成功路径，前端只会显示
    // 「未检测到有效声音」，把用户引去查麦克风（pitfalls #15）。
    let Some(text) = data.get("text").and_then(|t| t.as_str()) else {
        return Err(diag::fail(
            scope,
            "parse_json",
            format!("Response has no text field [{}] {}", summary, diag::describe_json(&body)),
        ));
    };
    Ok(text.trim().to_string())
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, audio_pcm_b64)
        .map_err(|e| diag::fail(SCOPE, "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;
    if pcm.is_empty() {
        diag::empty_result(SCOPE, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }
    let rate = if sample_rate == 0 { SAMPLE_RATE } else { sample_rate };
    let audio_sec = pcm.len() as f64 / 2.0 / rate as f64;
    let terms = keyterms(hotwords);
    log_keyterms(SCOPE, hotwords, &terms);
    diag::log(
        SCOPE,
        "start",
        &format!("audio_sec={:.1} rate={} model={}", audio_sec, rate, resolve_model(config)),
    );

    let start = Instant::now();
    let text = send_pcm(config, pcm, rate, &terms, SCOPE, request_timeout(audio_sec)).await?;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    if text.is_empty() {
        diag::empty_result(
            SCOPE,
            &format!("Response contained no transcript audio_sec={:.1} elapsed={}ms", audio_sec, elapsed_ms),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, text.chars().count());
    }
    Ok(AsrResult { text, elapsed_ms })
}

// ─────────────────────────── 流式：拼字幕 ───────────────────────────

/// 两段文字接起来。英文这类用空格分词的语言，句子之间要补一个空格；中文不加。
fn join_text(a: &str, b: &str) -> String {
    let b = b.trim();
    if b.is_empty() {
        return a.to_string();
    }
    let a_trimmed = a.trim_end();
    if a_trimmed.is_empty() {
        return b.to_string();
    }
    let last = a_trimmed.chars().last().unwrap_or(' ');
    let first = b.chars().next().unwrap_or(' ');
    let needs_space = last.is_ascii() && first.is_ascii_alphanumeric();
    if needs_space {
        format!("{} {}", a_trimmed, b)
    } else {
        format!("{}{}", a_trimmed, b)
    }
}

#[derive(Default)]
struct Transcript {
    /// 已经说完的整句（speech_final）
    committed: String,
    /// 本句里已锁定的小段（is_final 但不是 speech_final）
    locked: String,
    /// 还会变的中间结果
    interim: String,
    /// transcript.done 给的全文
    done_text: Option<String>,
    finished: bool,
    error: Option<String>,
    partial_events: usize,
}

enum Applied {
    Ignored,
    Updated,
    Finished,
    Failed,
}

impl Transcript {
    fn display(&self) -> String {
        join_text(&join_text(&self.committed, &self.locked), &self.interim)
    }

    fn final_text(&self) -> String {
        match &self.done_text {
            Some(text) if !text.trim().is_empty() => text.trim().to_string(),
            _ => self.display().trim().to_string(),
        }
    }

    fn apply(&mut self, ev: &serde_json::Value) -> Applied {
        let kind = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "transcript.partial" => {
                let text = ev.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let is_final = ev.get("is_final").and_then(|v| v.as_bool()).unwrap_or(false);
                let speech_final = ev.get("speech_final").and_then(|v| v.as_bool()).unwrap_or(false);
                self.partial_events += 1;
                if speech_final {
                    // 整句定稿：用它替掉本句攒的小段（见文件头「未经验证」第 1 条）
                    self.committed = join_text(&self.committed, text);
                    self.locked.clear();
                    self.interim.clear();
                } else if is_final {
                    self.locked = join_text(&self.locked, text);
                    self.interim.clear();
                } else {
                    self.interim = text.trim().to_string();
                }
                Applied::Updated
            }
            "transcript.done" => {
                let text = ev.get("text").and_then(|t| t.as_str()).unwrap_or("");
                self.done_text = Some(text.to_string());
                self.finished = true;
                Applied::Finished
            }
            "error" => {
                let message = ev
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown error");
                self.error = Some(diag::truncate(message, 300));
                self.finished = true;
                Applied::Failed
            }
            _ => Applied::Ignored,
        }
    }
}

// ─────────────────────────── 流式：建连 ───────────────────────────

/// 拼 WebSocket 地址。keyterm 可能含中文、空格，交给 Url 做编码，别手拼。
fn ws_url(model: &str, terms: &[String], interim: bool) -> Result<String, String> {
    let mut url = reqwest::Url::parse(WS_URL).map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("model", model)
            .append_pair("sample_rate", &SAMPLE_RATE.to_string())
            .append_pair("encoding", "pcm")
            .append_pair("interim_results", if interim { "true" } else { "false" });
        for term in terms {
            query.append_pair("keyterm", term);
        }
    }
    Ok(url.to_string())
}

async fn open_session(
    config: &AsrProviderConfig,
    hotwords: &[String],
    interim: bool,
) -> Result<(WsStream, String), String> {
    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            LIVE_SCOPE,
            "credentials",
            "provider_bad_key",
            "xAI speech-to-text is missing the API Key; complete it in Settings".to_string(),
        ));
    }
    let model = resolve_model(config);
    let terms = keyterms(hotwords);
    log_keyterms(LIVE_SCOPE, hotwords, &terms);
    let url = ws_url(&model, &terms, interim)
        .map_err(|e| diag::fail(LIVE_SCOPE, "build_request", format!("Failed to build request: {}", e)))?;
    let mut request = url
        .into_client_request()
        .map_err(|e| diag::fail(LIVE_SCOPE, "build_request", format!("Failed to build request: {}", e)))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", config.api_key.trim())).map_err(|e| {
            diag::fail_code(
                LIVE_SCOPE,
                "authorization_header",
                "provider_bad_key",
                format!("Invalid Authorization header: {}", e),
            )
        })?,
    );
    // 所有出网请求都带 UA（pitfalls 第 1 条）
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_static(concat!("SayIt/", env!("CARGO_PKG_VERSION"))),
    );

    let (mut ws, response) = match tokio_tungstenite::connect_async(request).await {
        Ok(pair) => pair,
        Err(tungstenite::Error::Http(resp)) => {
            let status = resp.status().as_u16();
            let body = resp
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).to_string())
                .unwrap_or_default();
            return Err(fail_for_status(
                LIVE_SCOPE,
                status,
                format!("WebSocket handshake rejected: HTTP {} {}", status, diag::truncate(&body, 200)),
            ));
        }
        Err(e) => {
            return Err(diag::fail(LIVE_SCOPE, "connect", format!("WebSocket connection failed: {}", e)));
        }
    };
    diag::log(
        LIVE_SCOPE,
        "connected",
        &format!("status={} model={} rate={}", response.status(), model, SAMPLE_RATE),
    );

    // 文档：等 transcript.created 再发音频，服务端要先把识别后端准备好
    let ready = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| {
                diag::fail(LIVE_SCOPE, "recv_ready", format!("Failed to receive the ready event: {}", e))
            })?;
            match msg {
                tungstenite::Message::Text(text) => {
                    let Ok(ev) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    match ev.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "transcript.created" => return Ok(true),
                        "error" => {
                            let message = ev.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
                            return Err(diag::fail(
                                LIVE_SCOPE,
                                "server_error",
                                format!("Server rejected the session: {}", diag::truncate(message, 300)),
                            ));
                        }
                        _ => {}
                    }
                }
                tungstenite::Message::Close(frame) => {
                    let reason = frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "No reason".to_string());
                    return Err(diag::fail(
                        LIVE_SCOPE,
                        "closed_before_ready",
                        format!("Server closed the session: {}", reason),
                    ));
                }
                _ => {}
            }
        }
        Ok(false)
    })
    .await
    .map_err(|_| {
        diag::fail(
            LIVE_SCOPE,
            "ready_timeout",
            "Timed out waiting for the transcription session to start".to_string(),
        )
    })??;
    if !ready {
        return Err(diag::fail(
            LIVE_SCOPE,
            "closed_before_ready",
            "WebSocket closed before the session became ready".to_string(),
        ));
    }
    diag::log(LIVE_SCOPE, "session_ready", &format!("model={}", model));
    Ok((ws, model))
}

// ─────────────────────────── 流式会话 ───────────────────────────

static SINK: once_cell::sync::Lazy<Arc<Mutex<Option<WsSink>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
static READER: once_cell::sync::Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
static STATE: once_cell::sync::Lazy<Arc<Mutex<Transcript>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(Transcript::default())));
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// 打开流式会话。和其他流式供应商一样，无论要不要上抛字幕，后台 reader 都一直读，
/// 服务端在发音频期间持续推事件，没人读会把连接堵死；realtime 只决定要不要 emit。
#[tauri::command]
pub async fn xai_live_open(
    app: AppHandle,
    config: AsrProviderConfig,
    hotwords: Option<Vec<String>>,
    realtime: Option<bool>,
) -> Result<(), String> {
    let realtime = realtime.unwrap_or(false);
    cleanup().await;

    let hotwords = hotwords.unwrap_or_default();
    let (ws, model) = open_session(&config, &hotwords, realtime).await?;
    let (sink, stream) = ws.split();
    *STATE.lock().await = Transcript::default();
    *SINK.lock().await = Some(sink);
    let handle = tokio::spawn(run_reader(stream, app, STATE.clone(), realtime));
    *READER.lock().await = Some(handle);
    ACTIVE.store(true, Ordering::SeqCst);
    diag::log(LIVE_SCOPE, "stream_open", &format!("realtime={} model={}", realtime, model));
    Ok(())
}

async fn run_reader(
    mut stream: SplitStream<WsStream>,
    app: AppHandle,
    state: Arc<Mutex<Transcript>>,
    realtime: bool,
) {
    let mut emitted = 0usize;
    let mut ended_cleanly = false;
    let mut close_reason = String::new();
    while let Some(msg) = stream.next().await {
        let text = match msg {
            Ok(tungstenite::Message::Text(t)) => t.to_string(),
            Ok(tungstenite::Message::Close(frame)) => {
                close_reason = frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "no reason".to_string());
                break;
            }
            Err(e) => {
                close_reason = e.to_string();
                break;
            }
            Ok(_) => continue,
        };
        let Ok(ev) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let (applied, display) = {
            let mut s = state.lock().await;
            let applied = s.apply(&ev);
            (applied, s.display())
        };
        match applied {
            Applied::Updated => {
                if realtime {
                    emitted += 1;
                    if emitted == 1 {
                        diag::log(LIVE_SCOPE, "first_partial", "");
                    }
                    let _ = app.emit(
                        "asr-partial",
                        serde_json::json!({ "text": display, "provider": "xai_live" }),
                    );
                }
            }
            Applied::Finished => {
                if realtime {
                    let final_text = state.lock().await.final_text();
                    let _ = app.emit(
                        "asr-partial",
                        serde_json::json!({ "text": final_text, "provider": "xai_live" }),
                    );
                }
                ended_cleanly = true;
                break;
            }
            Applied::Failed => {
                ended_cleanly = true;
                break;
            }
            Applied::Ignored => {}
        }
    }
    let mut s = state.lock().await;
    s.finished = true;
    // 协议没跑完就断了必须留痕，否则 finish 只能返回空串（pitfalls 第 15 条）
    if !ended_cleanly && s.error.is_none() {
        s.error = Some(format!(
            "connection closed before the transcript completed: {}",
            diag::truncate(&close_reason, 200)
        ));
    }
    diag::log(
        LIVE_SCOPE,
        "reader_stopped",
        &format!("emits={} partials={} clean={}", emitted, s.partial_events, ended_cleanly),
    );
}

async fn cleanup() {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Some(mut sink) = SINK.lock().await.take() {
        let _ = sink.close().await;
    }
    if let Some(handle) = READER.lock().await.take() {
        handle.abort();
    }
    *STATE.lock().await = Transcript::default();
}

#[tauri::command]
pub async fn xai_live_send(pcm_b64: String) -> Result<(), String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(LIVE_SCOPE, "send_without_session", "Session is not open".to_string()));
    }
    // 这家要二进制帧里的裸 PCM，所以这里要解一次 base64
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &pcm_b64)
        .map_err(|e| diag::fail(LIVE_SCOPE, "decode_b64", format!("Failed to decode audio: {}", e)))?;
    let mut sink = SINK.lock().await;
    let s = sink
        .as_mut()
        .ok_or_else(|| diag::fail(LIVE_SCOPE, "send_without_session", "Session is not open".to_string()))?;
    s.send(tungstenite::Message::Binary(pcm.into()))
        .await
        .map_err(|e| diag::fail(LIVE_SCOPE, "send_audio", format!("Failed to send audio: {}", e)))
}

#[tauri::command]
pub async fn xai_live_finish() -> Result<String, String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(LIVE_SCOPE, "finish_without_session", "Session is not open".to_string()));
    }
    {
        let mut sink = SINK.lock().await;
        let s = sink
            .as_mut()
            .ok_or_else(|| diag::fail(LIVE_SCOPE, "finish_without_session", "Session is not open".to_string()))?;
        // 发送失败不致命：服务端可能已经收尾，继续读已累计的文本即可
        if let Err(e) = s
            .send(tungstenite::Message::Text(
                serde_json::json!({ "type": "audio.done" }).to_string().into(),
            ))
            .await
        {
            diag::log(LIVE_SCOPE, "audio_done_send_err_ignored", &e.to_string());
        }
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        {
            let st = STATE.lock().await;
            if st.finished {
                let err = st.error.clone();
                let text = st.final_text();
                let partials = st.partial_events;
                drop(st);
                cleanup().await;
                // 已经识别出文字就交回去，哪怕收尾时断了 —— 丢掉等于让用户白说一遍
                if !text.is_empty() {
                    if let Some(err) = &err {
                        diag::log(LIVE_SCOPE, "finished_with_error", err);
                    }
                    diag::ok(LIVE_SCOPE, 0, text.chars().count());
                    return Ok(text);
                }
                if let Some(err) = err {
                    return Err(diag::fail(LIVE_SCOPE, "task_failed", format!("Transcription failed: {}", err)));
                }
                diag::empty_result(
                    LIVE_SCOPE,
                    &format!("Session finished with no transcript partials={}", partials),
                );
                return Ok(String::new());
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    // 超时也把已拿到的文本交回去
    let text = STATE.lock().await.final_text();
    diag::log(LIVE_SCOPE, "finish_timeout", &format!("returning partial chars={}", text.chars().count()));
    cleanup().await;
    Ok(text)
}

#[tauri::command]
pub async fn xai_live_close() -> Result<(), String> {
    cleanup().await;
    Ok(())
}

// ─────────────────────────── 连通性测试 ───────────────────────────

/// 走 REST 发 0.5 秒静音：一次请求就能验证密钥、额度和网络，不产生内容。
/// 不用 WebSocket 测：握手通了不代表 REST 那条（关掉实时字幕时走的）也通。
pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let scope = format!("{}-test", SCOPE);
    let start = Instant::now();
    let result = send_pcm(config, vec![0u8; 16000], SAMPLE_RATE, &[], &scope, Duration::from_secs(30)).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(_) => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: format!("model: {}", resolve_model(config)),
        },
        Err(message) => TestResult { ok: false, message, elapsed_ms, detail: String::new() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyterms_follow_the_documented_limits() {
        let long = "x".repeat(KEYTERM_MAX_CHARS + 1);
        let words: Vec<String> = vec![" SayIt ".into(), "SayIt".into(), "".into(), long, "豆包".into()];
        assert_eq!(keyterms(&words), vec!["SayIt".to_string(), "豆包".to_string()]);

        let many: Vec<String> = (0..KEYTERM_LIMIT + 20).map(|i| format!("w{}", i)).collect();
        assert_eq!(keyterms(&many).len(), KEYTERM_LIMIT);
    }

    /// 热词里有中文和空格，必须编码进 query，且每条单独一个 keyterm
    #[test]
    fn ws_url_carries_config_in_query() {
        let url = ws_url(DEFAULT_MODEL, &["Claude Code".into(), "豆包".into()], true).unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        let pairs: Vec<(String, String)> = parsed.query_pairs().map(|(k, v)| (k.into(), v.into())).collect();
        assert!(pairs.contains(&("model".into(), DEFAULT_MODEL.into())));
        assert!(pairs.contains(&("sample_rate".into(), "16000".into())));
        assert!(pairs.contains(&("encoding".into(), "pcm".into())));
        assert!(pairs.contains(&("interim_results".into(), "true".into())));
        let terms: Vec<&String> = pairs.iter().filter(|(k, _)| k == "keyterm").map(|(_, v)| v).collect();
        assert_eq!(terms, vec!["Claude Code", "豆包"]);
        assert!(!url.contains(' '));
    }

    #[test]
    fn english_sentences_get_a_space_chinese_do_not() {
        assert_eq!(join_text("Hello there.", "How are you"), "Hello there. How are you");
        assert_eq!(join_text("今天开会。", "下午三点"), "今天开会。下午三点");
        assert_eq!(join_text("", "abc"), "abc");
        assert_eq!(join_text("abc", "  "), "abc");
    }

    /// 文档的三种状态：interim 覆盖、chunk final 锁定、utterance final 用整句替掉小段
    #[test]
    fn partial_events_build_captions_and_done_wins() {
        let mut t = Transcript::default();
        let ev = |text: &str, is_final: bool, speech_final: bool| {
            serde_json::json!({ "type": "transcript.partial", "text": text, "is_final": is_final, "speech_final": speech_final })
        };
        t.apply(&ev("今天下", false, false));
        assert_eq!(t.display(), "今天下");
        t.apply(&ev("今天下午三点", true, false));
        assert_eq!(t.display(), "今天下午三点");
        t.apply(&ev("开个", false, false));
        assert_eq!(t.display(), "今天下午三点开个");
        t.apply(&ev("今天下午三点开个会。", true, true));
        assert_eq!(t.display(), "今天下午三点开个会。");
        t.apply(&ev("把方案", false, false));
        assert_eq!(t.display(), "今天下午三点开个会。把方案");

        // done 为空时退回自己拼的；有值时以它为准
        assert_eq!(t.final_text(), "今天下午三点开个会。把方案");
        assert!(matches!(
            t.apply(&serde_json::json!({ "type": "transcript.done", "text": "今天下午三点开个会，把方案过一遍。" })),
            Applied::Finished
        ));
        assert_eq!(t.final_text(), "今天下午三点开个会，把方案过一遍。");
    }

    #[test]
    fn error_event_finishes_with_the_message() {
        let mut t = Transcript::default();
        assert!(matches!(t.apply(&serde_json::json!({ "type": "error", "message": "bad audio" })), Applied::Failed));
        assert!(t.finished);
        assert_eq!(t.error.as_deref(), Some("bad audio"));
    }
}
