// OpenAI 实时转写 — gpt-live-transcribe
//
// 走 Realtime API 的「转写会话」（`?intent=transcription`），不是语音对话那套：
// 只上传音频、只收文字，模型不说话。
//
// ⚠️ 与 asr_qwen_realtime.rs 长得像但**不是同一套事件**。千问那份是照 OpenAI 的
// 老形态抄的，字段停在 `session.input_audio_format` / `sample_rate` 这一层；
// OpenAI 现在把这些收进了 `session.audio.input.*`，还多了 `keywords` / `delay`。
// 别拿千问那份的 payload 往这里套。
//
// 协议（官方 Realtime transcription 指南）：
//   1. 连 wss://api.openai.com/v1/realtime?intent=transcription
//   2. 发 session.update，type=transcription，配模型 / 音频格式 / 关掉自动断句
//   3. input_audio_buffer.append 发 base64 PCM（音频在 JSON 里，不是二进制帧）
//   4. input_audio_buffer.commit 结束这一轮
//   5. 收 conversation.item.input_audio_transcription.delta（增量）
//      与 .completed（该轮最终文本）
//
// ── 采样率：发送前 16k → 24k ──
// 接口参考写明 "Only a 24kHz sample rate is supported"，rate 只能是 24000。0.2.5 曾按
// 「格式字段是显式声明的，16k 应当被接受」直接发 16k，结果用户反馈实时字幕一个字都不出
// （issue #96）。我们整条链路是 16k（services/audio.ts），所以在 openai_live_send 里重采样。
//
// ── 未经真实接口验证的两处（没有 OpenAI key，只能照文档实现）──
// 用 `dev-scripts/probe_openai_live_transcribe.py` 打一次真实接口即可逐条确认：
//   B. **就绪事件名**。这里同时接受 `session.updated` 与 `transcription_session.updated`
//      （历史上用过后者），任一到达即算就绪。
//   C. **keywords 字段的位置**。文档把它放在 `audio.input.transcription.keywords`，
//      这也正好是我们热词功能最合适的落点 —— 比 Whisper 那种「拿带标点的句子做示范」
//      可靠得多。若服务端不认，退化的表现是热词不生效，不影响转写本身。

use super::{diag, types::AsrProviderConfig};
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

const WS_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const SCOPE: &str = "openai/live";

/// 流式默认模型。**别把它用在 `/audio/transcriptions`** —— 那个端点要 `gpt-transcribe`，
/// 两者不通用（见 asr_groq.rs 的 endpoint_for，关掉实时字幕时走的是那条路）。
const DEFAULT_MODEL: &str = "gpt-live-transcribe";

/// 发给 OpenAI 的采样率：Realtime 只收 24k 单声道 s16le。
const SAMPLE_RATE: u32 = 24000;

/// 16k → 24k 线性插值，**跨分片保留状态**。
///
/// 前端每 100ms 左右送一片音频。各片单独插值的话，每个接缝处输出样本数会差一个，
/// 几分钟下来就是可闻的变速和咔哒声，所以输出时钟在整个会话里连续走。
/// 线性插值对语音识别足够：16k 里本来就没有 8kHz 以上的内容，24k 只是换一个容器。
#[derive(Default)]
struct Upsampler16To24 {
    /// 还会用到的输入样本，tail[0] 的全局下标是 base
    tail: Vec<i16>,
    base: u64,
    /// 下一个输出样本的下标（24k 时钟）。第 k 个输出对应输入位置 k*2/3。
    next_out: u64,
}

impl Upsampler16To24 {
    fn push(&mut self, input: &[i16]) -> Vec<i16> {
        self.tail.extend_from_slice(input);
        let mut out = Vec::with_capacity(input.len() * 3 / 2 + 2);
        loop {
            let num = self.next_out * 2;
            let rel = (num / 3 - self.base) as usize;
            let frac = (num % 3) as i32;
            let sample = if frac == 0 {
                match self.tail.get(rel) {
                    Some(&s) => s,
                    None => break,
                }
            } else {
                match (self.tail.get(rel), self.tail.get(rel + 1)) {
                    (Some(&a), Some(&b)) => (a as i32 + (b as i32 - a as i32) * frac / 3) as i16,
                    _ => break,
                }
            };
            out.push(sample);
            self.next_out += 1;
        }
        // 下一个输出要用的第一个输入样本之前的都用不到了
        let drop = ((self.next_out * 2 / 3) - self.base) as usize;
        let drop = drop.min(self.tail.len());
        self.tail.drain(..drop);
        self.base += drop as u64;
        out
    }
}

static UPSAMPLER: once_cell::sync::Lazy<std::sync::Mutex<Upsampler16To24>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(Upsampler16To24::default()));

/// 前端送来的 16k base64 PCM → 24k base64 PCM。
fn pcm16k_b64_to_24k_b64(pcm_b64: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm_b64)
        .map_err(|e| format!("invalid audio chunk: {}", e))?;
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    let out = UPSAMPLER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(&samples);
    let mut out_bytes = Vec::with_capacity(out.len() * 2);
    for s in out {
        out_bytes.extend_from_slice(&s.to_le_bytes());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(out_bytes))
}

/// 延迟档位：minimal | low | medium | high | xhigh。
///
/// 取 `low` 而不是 `minimal`：这个值决定模型在吐字前先攒多少音频，档位越低越早出字、
/// 但错字更多。我们的用法是「说完插入到光标」，实时字幕只是过程反馈，最终文本的
/// 准确率比首字延迟重要；`minimal` 换来的那点提前量不值得多出来的错字。
const DELAY: &str = "low";

/// 热词条数上限。keywords 是提示不是强制，给太多反而会稀释每一个的作用；
/// 文档要求每条单行、且不含 `<` `>` 与换行，违反会让整个 session.update 被拒 ——
/// 那会让识别**完全不可用**，所以这里过滤掉而不是原样上送。
///
/// ⚠️ 这是**客户端自设**的，不是服务端限制（见 capabilities.rs 的 client_cap）。
const KEYWORD_LIMIT: usize = 100;

/// 给 `capabilities.rs` 的测试用，理由同 asr_qwen_audio_stream::hotword_limit_for_docs。
#[cfg(test)]
pub fn keyword_limit_for_docs() -> usize {
    KEYWORD_LIMIT
}

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;

// ─────────────────────────── 协议编解码 ───────────────────────────

/// 本次要用的模型：前端选定的优先，否则默认。
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

/// 热词 → `keywords` 数组。
///
/// 按文档要求剔掉带 `<` `>` 或换行的词条：留着会让 session.update 整条被拒，
/// 代价是识别完全不能用，而丢掉一个热词只是它不生效。
fn build_keywords(hotwords: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    hotwords
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .filter(|w| !w.contains('<') && !w.contains('>'))
        .filter(|w| !w.contains('\n') && !w.contains('\r'))
        .filter(|w| seen.insert(w.to_lowercase()))
        .take(KEYWORD_LIMIT)
        .map(|w| w.to_string())
        .collect()
}

/// 首条 session.update。
///
/// `turn_detection: null` 是刻意的：我们自己知道用户什么时候松开热键，由
/// `input_audio_buffer.commit` 明确收一轮。交给服务端 VAD 断句会在说话停顿处
/// 提前收尾，把一段话切成几轮。
fn session_update_payload(model: &str, hotwords: &[String]) -> serde_json::Value {
    let mut transcription = serde_json::json!({
        "model": model,
        "delay": DELAY,
    });
    let keywords = build_keywords(hotwords);
    if !keywords.is_empty() {
        diag::log(
            SCOPE,
            "hotwords",
            &format!("keywords={} of={}", keywords.len(), hotwords.len()),
        );
        transcription["keywords"] = serde_json::json!(keywords);
    }
    serde_json::json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": SAMPLE_RATE },
                    "transcription": transcription,
                    "turn_detection": serde_json::Value::Null,
                }
            }
        }
    })
}

fn append_audio_payload(pcm_b64: &str) -> serde_json::Value {
    serde_json::json!({ "type": "input_audio_buffer.append", "audio": pcm_b64 })
}

fn commit_payload() -> serde_json::Value {
    serde_json::json!({ "type": "input_audio_buffer.commit" })
}

fn event_type(ev: &serde_json::Value) -> &str {
    ev.get("type").and_then(|t| t.as_str()).unwrap_or("")
}

fn error_message(ev: &serde_json::Value) -> String {
    ev.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error")
        .to_string()
}

/// 就绪事件。两个名字都接受，见文件头 B 条。
fn is_session_ready(event: &str) -> bool {
    event == "session.updated" || event == "transcription_session.updated"
}

// ─────────────────────────── 累积状态 ───────────────────────────

/// 一次会话累积到的文本。
///
/// committed = 已 `.completed` 的轮次，partial = 当前轮的增量拼接。
/// 我们把 turn_detection 关了，正常只有一轮；但服务端仍可能分轮返回，
/// 所以按多轮处理 —— 只认一轮的话，多出来的会被丢掉。
#[derive(Default)]
struct Transcript {
    committed: String,
    partial: String,
    finished: bool,
    error: Option<String>,
    /// 收到过多少条 delta，只用于日志
    delta_events: usize,
}

/// 一条事件对累积状态做了什么。
enum Applied {
    Ignored,
    Updated,
    Finished,
    Failed,
}

impl Transcript {
    fn display(&self) -> String {
        format!("{}{}", self.committed, self.partial)
    }

    fn apply(&mut self, ev: &serde_json::Value) -> Applied {
        match event_type(ev) {
            "conversation.item.input_audio_transcription.delta" => {
                let delta = ev.get("delta").and_then(|d| d.as_str()).unwrap_or("");
                if delta.is_empty() {
                    return Applied::Ignored;
                }
                // delta 是**增量**（与千问那份的 text 全量语义相反），要追加
                self.partial.push_str(delta);
                self.delta_events += 1;
                Applied::Updated
            }
            "conversation.item.input_audio_transcription.completed" => {
                let transcript = ev.get("transcript").and_then(|t| t.as_str()).unwrap_or("");
                // completed 给的是该轮**最终**文本，用它替掉本轮攒的 delta：
                // 模型会在后续 delta 里修正前面的字，最终文本才是它认准的那版。
                self.partial.clear();
                if !transcript.is_empty() {
                    self.committed.push_str(transcript);
                }
                self.finished = true;
                Applied::Finished
            }
            "error" => {
                self.error = Some(error_message(ev));
                self.finished = true;
                Applied::Failed
            }
            _ => Applied::Ignored,
        }
    }
}

// ─────────────────────────── 建连 ───────────────────────────

/// 建连 → 发 session.update → 等就绪。拿到 WsStream 才算可以发音频。
async fn open_session(
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<(WsStream, String), String> {
    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            SCOPE,
            "credentials",
            "provider_bad_key",
            "OpenAI transcription is missing the API Key; complete it in Settings".to_string(),
        ));
    }

    let model = resolve_model(config);
    let mut request = WS_URL.into_client_request().map_err(|e| {
        diag::fail(
            SCOPE,
            "build_request",
            format!("Failed to build request: {}", e),
        )
    })?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", config.api_key.trim())).map_err(|e| {
            diag::fail_code(
                SCOPE,
                "authorization_header",
                "provider_bad_key",
                format!("Invalid Authorization header: {}", e),
            )
        })?,
    );
    // Realtime 的 beta 头。GA 之后带着它也无害，缺了则老账号连不上。
    request
        .headers_mut()
        .insert("openai-beta", HeaderValue::from_static("realtime=v1"));
    // 所有出网请求都带 UA：自有 ALB 与第三方网关会按「无 UA」直接 403，
    // 且报错里绝不提 UA（见 pitfalls 第 1 条）。
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_static(concat!("SayIt/", env!("CARGO_PKG_VERSION"))),
    );

    let (mut ws, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "connect",
                format!("WebSocket connection failed: {}", e),
            )
        })?;
    diag::log(
        SCOPE,
        "connected",
        &format!(
            "status={} model={} rate={}",
            response.status(),
            model,
            SAMPLE_RATE
        ),
    );

    let payload = session_update_payload(&model, hotwords);
    ws.send(tungstenite::Message::Text(
        serde_json::to_string(&payload).unwrap().into(),
    ))
    .await
    .map_err(|e| {
        diag::fail(
            SCOPE,
            "send_session_update",
            format!("Failed to send session.update: {}", e),
        )
    })?;

    // 必须等到就绪事件：配置被拒（模型没开通、采样率不接受、keywords 违规）时
    // 服务端会回 error 或直接关连接，都要在这里变成 Err，让上层回落到一次性 HTTP，
    // 而不是抱着一条不工作的连接空转。
    let ready = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| {
                diag::fail(
                    SCOPE,
                    "recv_ack",
                    format!("Failed to receive acknowledgement: {}", e),
                )
            })?;
            match msg {
                tungstenite::Message::Text(text) => {
                    let Ok(ev) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    let name = event_type(&ev);
                    if is_session_ready(name) {
                        return Ok(true);
                    }
                    if name == "error" {
                        return Err(diag::fail(
                            SCOPE,
                            "server_error",
                            format!("Server rejected the session: {}", error_message(&ev)),
                        ));
                    }
                }
                tungstenite::Message::Close(frame) => {
                    let reason = frame
                        .map(|f| f.reason.to_string())
                        .unwrap_or_else(|| "No reason".to_string());
                    return Err(diag::fail(
                        SCOPE,
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
            SCOPE,
            "session_ready_timeout",
            "Timed out waiting for the transcription session to start".to_string(),
        )
    })??;

    if !ready {
        return Err(diag::fail(
            SCOPE,
            "closed_before_ready",
            "WebSocket closed before the session became ready".to_string(),
        ));
    }
    diag::log(SCOPE, "session_ready", &format!("model={}", model));
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

/// 打开流式转写会话。
///
/// 和 asr_qwen_audio_stream 一样**不分「实时 / 普通」两条代码路径**：无论要不要上抛
/// 中间结果，后台 reader 都必须一直读 —— 服务端在发音频期间持续推 delta，
/// 没人读会把连接堵死。realtime 只决定要不要 emit。
#[tauri::command]
pub async fn openai_live_open(
    app: AppHandle,
    config: AsrProviderConfig,
    hotwords: Option<Vec<String>>,
    realtime: Option<bool>,
) -> Result<(), String> {
    let realtime = realtime.unwrap_or(false);
    cleanup().await;

    let hotwords = hotwords.unwrap_or_default();
    let (ws, model) = open_session(&config, &hotwords).await?;

    let (sink, stream) = ws.split();
    *STATE.lock().await = Transcript::default();
    *SINK.lock().await = Some(sink);
    let handle = tokio::spawn(run_reader(stream, app, STATE.clone(), realtime));
    *READER.lock().await = Some(handle);
    ACTIVE.store(true, Ordering::SeqCst);
    diag::log(
        SCOPE,
        "stream_open",
        &format!("realtime={} model={}", realtime, model),
    );
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
            Ok(tungstenite::Message::Text(t)) => t,
            Ok(tungstenite::Message::Close(frame)) => {
                close_reason = frame
                    .map(|f| f.reason.to_string())
                    .unwrap_or_else(|| "no reason".to_string());
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
                        diag::log(SCOPE, "first_partial", "");
                    }
                    let _ = app.emit(
                        "asr-partial",
                        serde_json::json!({ "text": display, "provider": "openai_live" }),
                    );
                }
            }
            Applied::Finished => {
                // 最终文本也要上屏一次：completed 会把 delta 里的错字修正掉，
                // 不 emit 的话悬浮窗会一直停在修正前那版
                if realtime {
                    let _ = app.emit(
                        "asr-partial",
                        serde_json::json!({ "text": display, "provider": "openai_live" }),
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
    // 协议没跑完就断了必须留痕。否则 finish 只能返回空串，而空串会被显示成
    // 「未检测到有效声音」，把用户引去查麦克风 —— 真实原因（额度、鉴权、
    // 模型没开通）就此消失。见 pitfalls 第 15 条。
    if !ended_cleanly && s.error.is_none() {
        s.error = Some(format!(
            "connection closed before the transcript completed: {}",
            diag::truncate(&close_reason, 200)
        ));
    }
    diag::log(
        SCOPE,
        "reader_stopped",
        &format!(
            "emits={} deltas={} clean={}",
            emitted, s.delta_events, ended_cleanly
        ),
    );
}

async fn cleanup() {
    ACTIVE.store(false, Ordering::SeqCst);
    // 新会话从 0 开始数样本，否则上一次剩下的尾巴会拼到下一次录音的开头
    *UPSAMPLER.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Upsampler16To24::default();
    if let Some(mut sink) = SINK.lock().await.take() {
        let _ = sink.close().await;
    }
    if let Some(handle) = READER.lock().await.take() {
        handle.abort();
    }
    *STATE.lock().await = Transcript::default();
}

#[tauri::command]
pub async fn openai_live_send(pcm_b64: String) -> Result<(), String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(
            SCOPE,
            "send_without_session",
            "Session is not open".to_string(),
        ));
    }
    // 必须解码重采样：前端是 16k，OpenAI 只收 24k（见文件头）。
    let pcm_b64 = pcm16k_b64_to_24k_b64(&pcm_b64)
        .map_err(|e| diag::fail(SCOPE, "resample", e))?;
    let payload = serde_json::to_string(&append_audio_payload(&pcm_b64)).unwrap();
    let mut sink = SINK.lock().await;
    let s = sink.as_mut().ok_or_else(|| {
        diag::fail(
            SCOPE,
            "send_without_session",
            "Session is not open".to_string(),
        )
    })?;
    s.send(tungstenite::Message::Text(payload.into()))
        .await
        .map_err(|e| diag::fail(SCOPE, "send_audio", format!("Failed to send audio: {}", e)))
}

#[tauri::command]
pub async fn openai_live_finish() -> Result<String, String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(
            SCOPE,
            "finish_without_session",
            "Session is not open".to_string(),
        ));
    }
    {
        let mut sink = SINK.lock().await;
        let s = sink.as_mut().ok_or_else(|| {
            diag::fail(
                SCOPE,
                "finish_without_session",
                "Session is not open".to_string(),
            )
        })?;
        // 发送失败不致命：可能服务端已经收尾，继续读已累计的文本即可。
        if let Err(e) = s
            .send(tungstenite::Message::Text(
                serde_json::to_string(&commit_payload()).unwrap().into(),
            ))
            .await
        {
            diag::log(SCOPE, "commit_send_err_ignored", &e.to_string());
        }
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        {
            let st = STATE.lock().await;
            if st.finished {
                let err = st.error.clone();
                let text = st.display().trim().to_string();
                let deltas = st.delta_events;
                drop(st);
                cleanup().await;
                // 已经识别出文字就交回去，哪怕收尾时断了 —— 丢掉它等于让用户白说一遍。
                // 但断连原因仍要留痕。
                if !text.is_empty() {
                    if let Some(err) = &err {
                        diag::log(SCOPE, "finished_with_error", err);
                    }
                    return Ok(text);
                }
                if let Some(err) = err {
                    return Err(diag::fail(
                        SCOPE,
                        "task_failed",
                        format!("Transcription failed: {}", err),
                    ));
                }
                diag::empty_result(
                    SCOPE,
                    &format!("Session finished with no transcript deltas={}", deltas),
                );
                return Ok(String::new());
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    // 超时也把已拿到的文本交回去：丢掉它等于让用户白说一遍。
    let text = STATE.lock().await.display().trim().to_string();
    diag::log(
        SCOPE,
        "finish_timeout",
        &format!("returning partial chars={}", text.chars().count()),
    );
    cleanup().await;
    Ok(text)
}

#[tauri::command]
pub async fn openai_live_close() -> Result<(), String> {
    cleanup().await;
    Ok(())
}

// ─────────────────────────── 连通性测试 ───────────────────────────

/// 只建连 + 开会话 + 立刻关：能开出转写会话就说明密钥和模型都对得上。
///
/// 不发音频 —— 这个命令只回答「能不能连」，真实转写由设置页的识别测试负责，
/// 而那条走的是 HTTP 一次性路径（见 registry.rs）。
pub async fn test_connection(config: &AsrProviderConfig) -> super::types::TestResult {
    let start = Instant::now();
    let model = resolve_model(config);
    let result = async {
        let (mut ws, _) = open_session(config, &[]).await?;
        let _ = ws.close(None).await;
        Ok::<(), String>(())
    }
    .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(()) => super::types::TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: format!("model: {}", model),
        },
        Err(message) => super::types::TestResult {
            ok: false,
            message,
            elapsed_ms,
            detail: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "openai_live_transcribe".to_string(),
            api_key: "sk-test".to_string(),
            app_id: String::new(),
            extra,
        }
    }

    /// 分片喂和一次性喂必须得到同一串输出：接缝处多一个或少一个样本，几分钟下来就会变速。
    #[test]
    fn upsampler_is_continuous_across_chunks() {
        let input: Vec<i16> = (0..1600).map(|i| ((i * 37) % 2000 - 1000) as i16).collect();
        let whole = Upsampler16To24::default().push(&input);

        let mut chunked = Upsampler16To24::default();
        let mut pieces = Vec::new();
        for chunk in input.chunks(127) {
            pieces.extend(chunked.push(chunk));
        }
        assert_eq!(pieces, whole);
        // 100ms 的 16k（1600 个样本）≈ 100ms 的 24k（2400 个，末尾最多差一个在等下一片）
        assert!((2398..=2400).contains(&whole.len()), "got {}", whole.len());
        // 整数位置原样保留，中间位置在两邻点之间
        assert_eq!(whole[0], input[0]);
        assert_eq!(whole[3], input[2]);
        let (a, b) = (input[0].min(input[1]), input[0].max(input[1]));
        assert!(whole[1] >= a && whole[1] <= b);
    }

    #[test]
    fn model_falls_back_to_the_live_default() {
        assert_eq!(resolve_model(&config(serde_json::json!({}))), DEFAULT_MODEL);
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": "   " }))),
            DEFAULT_MODEL
        );
        assert_eq!(
            resolve_model(&config(serde_json::json!({ "model": "gpt-transcribe" }))),
            "gpt-transcribe"
        );
    }

    /// session.update 的形状是这份实现的全部前提，写错一个层级就是「连上了但没有字」。
    /// 尤其 turn_detection 必须是 **JSON null**，不是缺省、也不是字符串 "null"。
    #[test]
    fn session_update_matches_the_documented_shape() {
        let payload = session_update_payload(DEFAULT_MODEL, &[]);
        assert_eq!(payload["type"], "session.update");
        assert_eq!(payload["session"]["type"], "transcription");
        let input = &payload["session"]["audio"]["input"];
        assert_eq!(input["format"]["type"], "audio/pcm");
        // 接口只收 24000（issue #96：发 16000 时一个字都不出）
        assert_eq!(input["format"]["rate"], 24000);
        assert_eq!(input["transcription"]["model"], DEFAULT_MODEL);
        assert_eq!(input["transcription"]["delay"], DELAY);
        assert!(input["turn_detection"].is_null());
        // 没有热词时不带 keywords 字段（空数组也可能被判成"限定只认这些词"）
        assert!(input["transcription"].get("keywords").is_none());
    }

    #[test]
    fn hotwords_become_keywords() {
        let words = vec!["SayIt".to_string(), " Kiro ".to_string()];
        let payload = session_update_payload(DEFAULT_MODEL, &words);
        let keywords = &payload["session"]["audio"]["input"]["transcription"]["keywords"];
        assert_eq!(keywords[0], "SayIt");
        assert_eq!(keywords[1], "Kiro");
    }

    /// 带 `<` `>` 或换行的词条会让服务端拒掉整条 session.update —— 那是「识别完全不可用」，
    /// 比「这个热词不生效」严重得多，所以必须在这里剔掉。
    #[test]
    fn illegal_keywords_are_dropped_not_forwarded() {
        let words = vec![
            "good".to_string(),
            "bad<tag>".to_string(),
            "two\nlines".to_string(),
            "carriage\rreturn".to_string(),
        ];
        assert_eq!(build_keywords(&words), vec!["good".to_string()]);
    }

    #[test]
    fn keywords_are_deduped_and_capped() {
        let words = vec!["SayIt".to_string(), "sayit".to_string()];
        assert_eq!(build_keywords(&words).len(), 1);
        let many: Vec<String> = (0..KEYWORD_LIMIT + 50).map(|i| format!("w{}", i)).collect();
        assert_eq!(build_keywords(&many).len(), KEYWORD_LIMIT);
    }

    /// delta 是**增量**（要追加），completed 给的是该轮最终文本（要替掉本轮的 delta）。
    /// 把 delta 当全量覆盖会只剩最后一个字；把 completed 当增量追加会让文本重复一遍。
    #[test]
    fn deltas_accumulate_and_completed_replaces_them() {
        let mut t = Transcript::default();
        t.apply(&serde_json::json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": "Hello,"
        }));
        t.apply(&serde_json::json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": " how are"
        }));
        assert_eq!(t.display(), "Hello, how are");
        assert_eq!(t.delta_events, 2);

        t.apply(&serde_json::json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "Hello, how are you?"
        }));
        assert_eq!(t.display(), "Hello, how are you?");
        assert!(t.finished);
    }

    #[test]
    fn empty_deltas_are_ignored() {
        let mut t = Transcript::default();
        assert!(matches!(
            t.apply(&serde_json::json!({
                "type": "conversation.item.input_audio_transcription.delta",
                "delta": ""
            })),
            Applied::Ignored
        ));
        assert_eq!(t.delta_events, 0);
        assert!(matches!(
            t.apply(&serde_json::json!({ "type": "input_audio_buffer.committed" })),
            Applied::Ignored
        ));
    }

    #[test]
    fn server_error_is_captured() {
        let mut t = Transcript::default();
        assert!(matches!(
            t.apply(&serde_json::json!({
                "type": "error",
                "error": { "message": "insufficient_quota" }
            })),
            Applied::Failed
        ));
        assert_eq!(t.error.as_deref(), Some("insufficient_quota"));
        assert!(t.finished);
    }

    /// 历史上用过 transcription_session.updated，两个名字都要认 —— 只认一个的症状是
    /// 建连超时后静默回落到一次性识别，字幕永远不出来。
    #[test]
    fn both_ready_event_names_are_accepted() {
        assert!(is_session_ready("session.updated"));
        assert!(is_session_ready("transcription_session.updated"));
        assert!(!is_session_ready("session.created"));
    }
}
