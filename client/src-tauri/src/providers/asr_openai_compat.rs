// 「OpenAI 兼容」那张卡的分发层：把协议探测出来，再交给真正干活的那一份实现。
//
// ## 为什么需要这一层
//
// 「OpenAI 兼容」在语音这块其实是**两套完全不同的协议**（实测记录见
// `dev-scripts/probe_bailian_openai_audio.py`）：
//   · `/audio/transcriptions`：multipart 传文件，响应 `{"text": ...}` —— asr_groq.rs
//   · `/chat/completions`：音频作为 `input_audio` 塞进 messages —— asr_openai_chat_audio.rs
//     对话接口有两种音频形态：百炼 data URL 字符串、标准 OpenAI data/format 对象。
//
// 这里曾经做成两张卡、让用户自己选。否掉了：**用户没办法知道自己要连的服务说哪种协议**，
// 他得去翻对方文档，或者两张卡轮流试。那是把我们的实现细节推给用户承担。
// 所以合成一张卡，协议默认 `auto` 由这里试出来；`extra.protocol` 的三个显式值
// （`transcriptions` / `chat` / `chat_standard`）留作探测判不准时的手动退路。
//
// ## 探测只在进程内做一次
//
// 结果按「地址 + 模型」缓存在进程里，与 AI 润色那边「记住这个端点不接受某参数」
// 是同一个套路（见 `.kiro/decisions.md`「默认替所有 OpenAI 兼容端点关闭思考」）。
// 所以最坏情况是每个端点每次启动多两个失败请求，而不是每次转写都重新探测。
//
// ⚠️ 不要把探测改成「先发一个轻量请求试路由」：那会在正常路径上凭空多一次往返。
// 现在的做法是拿**真实的那次转写**去试，成功了顺手记住。

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::collections::HashMap;
use std::sync::Mutex;

const SCOPE: &str = "openai-compat/dispatch";

/// 内部分发 key：交给 asr_groq / asr_openai_chat_audio 时换成它们认识的 provider id。
const AS_TRANSCRIPTIONS: &str = "openai_compat_transcribe";
const AS_CHAT: &str = "openai_chat_audio";
const AS_CHAT_STANDARD: &str = "openai_chat_audio_standard";

/// 「这个地址 + 这个模型」上次是哪种协议成功的。
///
/// 只在进程内有效，重启即忘 —— 这是刻意的：用户换了对面的服务、或者对面升级了，
/// 缓存不该跨进程留着。命中率在一次会话里已经够用。
static PROTOCOL_CACHE: Mutex<Option<HashMap<String, &'static str>>> = Mutex::new(None);

fn cache_key_from_extra(extra: &serde_json::Value) -> String {
    let field = |name: &str| {
        extra
            .get(name)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    format!("{}|{}", field("baseUrl"), field("model"))
}

fn cache_key(config: &AsrProviderConfig) -> String {
    cache_key_from_extra(&config.extra)
}

/// 这份配置上次探到的是哪种协议，没探过返回 None。
///
/// 给 `capabilities.rs` 用：auto 档的热词能力取决于协议，探测之前只能回答"未确定"，
/// 探过之后就该给准话。只改 `labelled()` 里测试成功的那句提示是不够的 ——
/// 真正的转写也会探测并写缓存（见下面 transcribe 里的 remember_protocol），
/// 用户可能根本没点过「测试连接」就直接开始口述了。
///
/// 缓存键含地址和模型，所以**换了配置自然不命中**，会退回"未确定"而不是给出旧答案。
pub fn detected_protocol(extra: &serde_json::Value) -> Option<&'static str> {
    cached_protocol(&cache_key_from_extra(extra))
}

fn cached_protocol(key: &str) -> Option<&'static str> {
    let guard = PROTOCOL_CACHE.lock().ok()?;
    guard.as_ref()?.get(key).copied()
}

fn remember_protocol(key: &str, protocol: &'static str) {
    if let Ok(mut guard) = PROTOCOL_CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(key.to_string(), protocol);
    }
}

/// 用户显式选了协议吗（`auto` 与缺省都算没选）。
fn explicit_protocol(config: &AsrProviderConfig) -> Option<&'static str> {
    match config.extra.get("protocol").and_then(|v| v.as_str()) {
        Some("transcriptions") => Some(AS_TRANSCRIPTIONS),
        Some("chat") => Some(AS_CHAT),
        Some("chat_standard") => Some(AS_CHAT_STANDARD),
        _ => None,
    }
}

/// 把 config 换成下游认识的 provider id，其余原样。
fn with_provider(config: &AsrProviderConfig, provider: &str) -> AsrProviderConfig {
    AsrProviderConfig {
        provider: provider.to_string(),
        api_key: config.api_key.clone(),
        app_id: config.app_id.clone(),
        extra: config.extra.clone(),
    }
}

/// 这条错误像不像「路由不存在」，也就是协议猜错了。
///
/// 判据故意窄：它唯一的用处是在两边都失败时决定**报哪一条错**，猜错只会让提示
/// 变差、不影响正确性。密钥错、模型不存在这类错误不该被当成协议问题 ——
/// 那会让用户以为「换个协议就好了」，而真正该做的是去改密钥。
fn looks_like_wrong_route(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("404")
        || lower.contains("405")
        || lower.contains("not found")
        || lower.contains("method not allowed")
}

async fn run(
    provider: &str,
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let scoped = with_provider(config, provider);
    if provider == AS_CHAT || provider == AS_CHAT_STANDARD {
        super::asr_openai_chat_audio::transcribe(audio_pcm_b64, sample_rate, &scoped, hotwords).await
    } else {
        super::asr_groq::transcribe(audio_pcm_b64, sample_rate, &scoped, hotwords).await
    }
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    // 手动指定过就直接走，不探测（这是探测判不准时的退路，必须说一不二）。
    if let Some(chosen) = explicit_protocol(config) {
        diag::log(SCOPE, "manual", &format!("protocol={}", chosen));
        return run(chosen, audio_pcm_b64, sample_rate, config, hotwords).await;
    }

    let key = cache_key(config);
    if let Some(chosen) = cached_protocol(&key) {
        diag::log(SCOPE, "cached", &format!("protocol={}", chosen));
        return run(chosen, audio_pcm_b64, sample_rate, config, hotwords).await;
    }

    // 先试 multipart 那套：它是这两者里更常见的一种（OpenAI 自己、Groq、
    // 以及所有自建 whisper 服务都是它）。
    diag::log(SCOPE, "probe", "trying /audio/transcriptions first");
    let first = run(AS_TRANSCRIPTIONS, audio_pcm_b64, sample_rate, config, hotwords).await;
    let first_error = match first {
        Ok(result) => {
            remember_protocol(&key, AS_TRANSCRIPTIONS);
            diag::log(SCOPE, "detected", "protocol=transcriptions");
            return Ok(result);
        }
        Err(error) => error,
    };

    diag::log(
        SCOPE,
        "probe",
        &format!(
            "/audio/transcriptions failed, trying /chat/completions: {}",
            diag::truncate(&first_error, 200)
        ),
    );
    match run(AS_CHAT, audio_pcm_b64, sample_rate, config, hotwords).await {
        Ok(result) => {
            remember_protocol(&key, AS_CHAT);
            diag::log(SCOPE, "detected", "protocol=chat");
            Ok(result)
        }
        Err(second_error) => {
            // 百炼 data URL 不一定能被兼容网关解析；换标准 OpenAI 对象再试一次。
            match run(AS_CHAT_STANDARD, audio_pcm_b64, sample_rate, config, hotwords).await {
                Ok(result) => {
                    remember_protocol(&key, AS_CHAT_STANDARD);
                    diag::log(SCOPE, "detected", "protocol=chat_standard");
                    Ok(result)
                }
                Err(standard_error) => {
                    // 优先反馈标准格式的真实错误；但别用它的 404
                    // 覆盖另一个协议更具体的报错。
                    let error = if !looks_like_wrong_route(&standard_error) {
                        standard_error
                    } else if !looks_like_wrong_route(&second_error) {
                        second_error
                    } else {
                        first_error
                    };
                    diag::log(SCOPE, "all_failed", &format!("error={}", diag::truncate(&error, 200)));
                    Err(error)
                }
            }
        }
    }
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    if let Some(chosen) = explicit_protocol(config) {
        return labelled(chosen, run_test(chosen, config).await);
    }

    let key = cache_key(config);
    if let Some(chosen) = cached_protocol(&key) {
        return labelled(chosen, run_test(chosen, config).await);
    }

    let first = run_test(AS_TRANSCRIPTIONS, config).await;
    if first.ok {
        remember_protocol(&key, AS_TRANSCRIPTIONS);
        return labelled(AS_TRANSCRIPTIONS, first);
    }
    let second = run_test(AS_CHAT, config).await;
    if second.ok {
        remember_protocol(&key, AS_CHAT);
        return labelled(AS_CHAT, second);
    }
    let third = run_test(AS_CHAT_STANDARD, config).await;
    if third.ok {
        remember_protocol(&key, AS_CHAT_STANDARD);
        return labelled(AS_CHAT_STANDARD, third);
    }
    if !looks_like_wrong_route(&third.message) {
        third
    } else if !looks_like_wrong_route(&second.message) {
        second
    } else {
        first
    }
}

async fn run_test(provider: &str, config: &AsrProviderConfig) -> TestResult {
    let scoped = with_provider(config, provider);
    if provider == AS_CHAT || provider == AS_CHAT_STANDARD {
        super::asr_openai_chat_audio::test_connection(&scoped).await
    } else {
        super::asr_groq::test_connection(&scoped).await
    }
}

/// 在成功信息里写明探到的是哪种协议。
///
/// 用户点「测试」本来就是想知道「能不能用」，顺手告诉他走的是哪条路 ——
/// 否则自动探测就是个黑盒，出问题时他连该查哪半边都不知道。
fn labelled(provider: &str, mut result: TestResult) -> TestResult {
    if result.ok {
        let name = if provider == AS_CHAT_STANDARD {
            "/chat/completions (standard input_audio)"
        } else if provider == AS_CHAT {
            "/chat/completions"
        } else {
            "/audio/transcriptions"
        };
        // 顺带说明热词 —— 这两条协议的答案相反（chat 能把词表追加到 instruction，
        // transcriptions 的 prompt 被标点引导占用了），而用户看到「连接成功」时
        // 最容易顺带以为热词也生效了。issue #67 的原话是「避免连接成功后仍让用户
        // 误以为热词已生效」。能力判定在 capabilities.rs，这里只是把它说出来。
        let hotwords = if provider == AS_CHAT || provider == AS_CHAT_STANDARD {
            "hotwords: sent as context"
        } else {
            "hotwords: not sent on this protocol"
        };
        result.message = format!("{} [{} · {}]", result.message, name, hotwords);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "openai_compat".to_string(),
            api_key: "k".to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn explicit_protocol_wins_over_detection() {
        assert_eq!(
            explicit_protocol(&config(serde_json::json!({ "protocol": "chat" }))),
            Some(AS_CHAT),
        );
        assert_eq!(
            explicit_protocol(&config(serde_json::json!({ "protocol": "chat_standard" }))),
            Some(AS_CHAT_STANDARD),
        );
        assert_eq!(
            explicit_protocol(&config(serde_json::json!({ "protocol": "transcriptions" }))),
            Some(AS_TRANSCRIPTIONS),
        );
        // auto、缺省、以及任何不认识的值都算「让代码自己试」
        assert_eq!(explicit_protocol(&config(serde_json::json!({ "protocol": "auto" }))), None);
        assert_eq!(explicit_protocol(&config(serde_json::json!({}))), None);
        assert_eq!(explicit_protocol(&config(serde_json::json!({ "protocol": "nope" }))), None);
    }

    /// 缓存键必须同时含地址和模型：同一个网关上两个模型可能走不同协议
    /// （聚合站尤其常见），只按地址缓存会把第二个模型带偏。
    #[test]
    fn cache_key_covers_both_address_and_model() {
        let a = cache_key(&config(serde_json::json!({ "baseUrl": "http://x/v1", "model": "m1" })));
        let b = cache_key(&config(serde_json::json!({ "baseUrl": "http://x/v1", "model": "m2" })));
        let c = cache_key(&config(serde_json::json!({ "baseUrl": "http://y/v1", "model": "m1" })));
        assert_ne!(a, b);
        assert_ne!(a, c);
        // 同样的输入要得到同样的键，否则缓存永远不命中
        assert_eq!(
            a,
            cache_key(&config(serde_json::json!({ "baseUrl": "http://x/v1", "model": "m1" }))),
        );
    }

    #[test]
    fn the_cache_round_trips() {
        let key = "cache-round-trip|model";
        assert_eq!(cached_protocol(key), None);
        remember_protocol(key, AS_CHAT);
        assert_eq!(cached_protocol(key), Some(AS_CHAT));
    }

    /// 「路由不存在」的判据要窄。
    ///
    /// 放宽了会把「密钥错」也当成协议问题，于是提示变成「换个协议试试」，
    /// 而用户真正该做的是去改密钥。
    #[test]
    fn wrong_route_detection_stays_narrow() {
        assert!(looks_like_wrong_route("Transcription error 404 [http=404]: not found"));
        assert!(looks_like_wrong_route("error 405 Method Not Allowed"));

        assert!(!looks_like_wrong_route("Invalid API key"));
        assert!(!looks_like_wrong_route("model not_a_model does not exist"));
        assert!(!looks_like_wrong_route("Transcription error 401 [http=401]: unauthorized"));
        assert!(!looks_like_wrong_route("insufficient balance"));
    }

    /// 成功信息里要写明走的是哪条协议；失败信息不加料（那会盖住真正的错误）。
    #[test]
    fn the_detected_protocol_shows_up_in_a_successful_test() {
        let ok = labelled(AS_CHAT, TestResult {
            ok: true,
            message: "Connection successful".to_string(),
            elapsed_ms: 1,
            detail: String::new(),
        });
        assert!(ok.message.contains("/chat/completions"), "got {}", ok.message);

        let failed = labelled(AS_CHAT, TestResult {
            ok: false,
            message: "Invalid API key".to_string(),
            elapsed_ms: 1,
            detail: String::new(),
        });
        assert_eq!(failed.message, "Invalid API key");
    }
}
