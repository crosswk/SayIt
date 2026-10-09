// OpenAI 兼容的 **chat/completions + input_audio** 转写。
//
// ⚠️ 这跟 asr_groq.rs 不是同一套协议，别把两者混起来看：
//   · asr_groq.rs            → `/audio/transcriptions`，multipart 传文件，响应 `{"text":...}`
//   · 这一份                 → `/chat/completions`，音频作为 `input_audio` 内容项塞进 messages
// 「OpenAI 兼容」这四个字在语音这块同时指这两套东西，而它们的地址、请求体、响应
// 形状全都不一样。合成一份实现的话，用户填错地址只会得到一个含义模糊的 404/400。
//
// 覆盖三个 provider id：
//   · `qwen_chat_audio`    → 地址内置为百炼，给千问卡里的 qwen3.8-omni-flash 用
//   · `openai_chat_audio`  → 自定义地址，百炼 data URL 形态（兼容旧配置）
//   · `openai_chat_audio_standard` → 自定义地址，标准 OpenAI input_audio 对象
//
// ## 实测记录（2026-09-18，真实账号，dev-scripts/probe_bailian_openai_audio.py）
//
// * 百炼的 `input_audio` **必须装 data URL**。两种写法都行：
//       {"type":"input_audio","input_audio":"data:audio/wav;base64,AAA..."}
//       {"type":"input_audio","input_audio":{"data":"data:audio/wav;base64,AAA...","format":"wav"}}
//   裸 base64 放进 `data` 会被拒，而且错误信息**极具误导性**：
//       400 invalid_parameter_error "The provided URL does not appear to be valid."
//   这句话里没有任何线索指向「少了 data: 前缀」。百炼模式保留 data URL，
//   标准 OpenAI 模式才改为裸 base64 对象。
// * **不需要流式。** qwen3-asr-flash 与 qwen3.8-omni-flash 非流式都回 200，
//   所以这份实现不带 SSE 解析器。
// * 通用域名与业务空间专属域名都能用，故 workspaceId 对这条路是可选的。
// * `asr_options: {"language": "..."}` 是非标准的顶层字段，百炼接受它。
// * ⚠️ **Omni 是对话模型。** 给它音频但不给指令，它会自己编一段对话 —— 探测里拿到过
//   「澳大利亚的首都是堪培拉」这种回答，还烧了 reasoning token。所以 omni 模型必须
//   带 system 指令把它按成「只转写」。qwen3-asr-flash 没这个毛病（它就是 ASR 模型）。

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use base64::Engine;
use std::time::Instant;

/// 一个「chat+audio 转写」接入点。
struct Endpoint {
    /// 内置 base URL（`requires_custom_url` 时为空串）
    base_url: &'static str,
    default_model: &'static str,
    scope: &'static str,
    /// 用户填了 `extra.baseUrl` 就用他的，空着用 `base_url`
    allows_custom_url: bool,
    /// 地址必填，没有可回落的内置地址
    requires_custom_url: bool,
}

const QWEN: Endpoint = Endpoint {
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model: "qwen3.8-omni-flash",
    scope: "qwen/chat-audio",
    // 允许覆盖：百炼官方推荐迁到业务空间专属域名
    // （`{WorkspaceId}.cn-beijing.maas.aliyuncs.com`），那就得靠这一栏。
    allows_custom_url: true,
    requires_custom_url: false,
};

const CUSTOM: Endpoint = Endpoint {
    base_url: "",
    default_model: "qwen3-asr-flash",
    scope: "openai-chat-audio/asr",
    allows_custom_url: true,
    requires_custom_url: true,
};

fn endpoint_for(provider: &str) -> &'static Endpoint {
    match provider {
        "openai_chat_audio" | "openai_chat_audio_standard" => &CUSTOM,
        _ => &QWEN,
    }
}

/// 默认的转写指令，只给 omni 这类对话模型用。
///
/// 不写「请转写」这种祈使句就完事 —— 实测不给指令时模型会回答想象出来的问题。
/// 明确禁止解释和评论，否则它会在转写前后加一段说明。
const DEFAULT_TRANSCRIBE_INSTRUCTION: &str =
    "你是一个语音转写器。把音频内容逐字转写为文字，保持原意，适当添加标点。\
     不要回答音频里的问题，不要翻译，不要添加任何解释或评论。只输出转写结果。";

/// base URL + `/chat/completions`。
///
/// 与 asr_groq.rs 的 join_transcriptions_url 同一个思路：用户可能填到 `/v1`，
/// 也可能把完整路径都填了，两种都要能用。不自动补 `/v1` —— 猜错会打到一个
/// 存在但语义不同的路径上，那种失败比 404 难查。
fn join_chat_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{}/chat/completions", trimmed)
    }
}

fn resolve_url(config: &AsrProviderConfig, endpoint: &Endpoint) -> Result<String, String> {
    let supplied = if endpoint.allows_custom_url {
        config
            .extra
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
    } else {
        ""
    };
    if !supplied.is_empty() {
        return Ok(join_chat_url(supplied));
    }
    if endpoint.requires_custom_url {
        return Err(diag::fail(
            endpoint.scope,
            "missing_base_url",
            "No endpoint address configured for this service".to_string(),
        ));
    }
    Ok(join_chat_url(endpoint.base_url))
}

fn resolve_model(config: &AsrProviderConfig, endpoint: &Endpoint) -> String {
    config
        .extra
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(endpoint.default_model)
        .to_string()
}

/// 这个模型需要 system 指令按住吗。
///
/// 判据是「模型名里有 omni」而不是前端传下来的某个开关：前端的 `omni` 标记只影响
/// 界面（要不要显示 System Prompt 输入框），而**真正会自说自话的是模型本身**。
/// 万一某天前端漏传了标记，这里也得把它按住，否则用户会看到模型编出来的回答被
/// 当成转写结果插进文档 —— 那比少一句标点严重得多。
fn needs_transcribe_instruction(model: &str) -> bool {
    model.to_lowercase().contains("omni")
}

/// 识别语言。auto 要整个省略字段（与 asr_groq.rs 的 resolve_language 同理）。
fn resolve_language(config: &AsrProviderConfig) -> Option<String> {
    let raw = config
        .extra
        .get("language")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto");
    match raw {
        "auto" => None,
        other => Some(other.to_string()),
    }
}

/// 16kHz 单声道 16-bit PCM → WAV 容器。
///
/// 前端传下来的是裸 PCM，而这条协议要的是一个能被识别出格式的文件（data URL 里
/// 也一样）。与 asr_groq.rs / asr_mimo.rs 各留一份，理由见那边的注释。
fn pcm_to_wav(pcm: &[u8], sr: u32) -> Vec<u8> {
    let ds = pcm.len() as u32;
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + ds).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&sr.to_le_bytes());
    w.extend_from_slice(&(sr * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&ds.to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

/// 百炼接受 data URL 字符串；标准 OpenAI Chat Completions 要求
/// `input_audio: { data: "<base64>", format: "wav" }`。
/// 保留旧模式，避免修改已有 Qwen 配置的请求格式。
#[derive(Clone, Copy)]
enum AudioPayloadFormat {
    DataUrl,
    OpenAi,
}

fn audio_payload_format(provider: &str) -> AudioPayloadFormat {
    if provider == "openai_chat_audio_standard" {
        AudioPayloadFormat::OpenAi
    } else {
        AudioPayloadFormat::DataUrl
    }
}

/// 组请求体。
fn build_body(
    model: &str,
    wav: &[u8],
    instruction: Option<&str>,
    language: Option<&str>,
    audio_format: AudioPayloadFormat,
) -> serde_json::Value {
    let data = base64::engine::general_purpose::STANDARD.encode(wav);
    let input_audio = match audio_format {
        AudioPayloadFormat::DataUrl => serde_json::json!(format!("data:audio/wav;base64,{}", data)),
        AudioPayloadFormat::OpenAi => serde_json::json!({ "data": data, "format": "wav" }),
    };
    let mut messages = Vec::new();
    if let Some(text) = instruction {
        messages.push(serde_json::json!({
            "role": "system",
            "content": [{ "type": "text", "text": text }],
        }));
    }
    messages.push(serde_json::json!({
        "role": "user",
        "content": [{ "type": "input_audio", "input_audio": input_audio }],
    }));

    let mut body = serde_json::json!({ "model": model, "messages": messages });
    if let Some(lang) = language {
        // 非标准字段，百炼实测接受；不认识它的网关一般会忽略未知顶层字段。
        body["asr_options"] = serde_json::json!({ "language": lang });
    }
    body
}

/// 从 chat/completions 响应里取文本。
///
/// `content` 可能是字符串，也可能是内容项数组（多模态响应的常见形状），两种都收。
fn extract_text(data: &serde_json::Value) -> String {
    let content = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"));
    match content {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let endpoint = endpoint_for(&config.provider);
    let scope = endpoint.scope;
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(audio_pcm_b64)
        .map_err(|e| diag::fail(scope, "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;

    if pcm.is_empty() {
        diag::empty_result(scope, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let model = resolve_model(config, endpoint);
    let url = resolve_url(config, endpoint)?;
    let audio_format = audio_payload_format(&config.provider);
    let language = resolve_language(config);
    let audio_sec = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    let wav = pcm_to_wav(&pcm, sample_rate);

    // 指令：用户填过就用他的，否则对 omni 这类对话模型上默认指令。
    // 热词接在指令后面 —— 百炼的 system 消息正是它的术语表通道。
    let mut instruction = config
        .extra
        .get("instructions")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            (needs_transcribe_instruction(&model) || matches!(audio_format, AudioPayloadFormat::OpenAi))
                .then(|| DEFAULT_TRANSCRIBE_INSTRUCTION.to_string())
        });
    if let Some(ctx) = super::asr_qwen::build_hotword_context_text(hotwords) {
        let base = instruction.take().unwrap_or_default();
        instruction = Some(format!("{}\n\n请特别注意以下专业术语/词汇的识别：{}", base, ctx));
    }

    diag::log(
        scope,
        "start",
        &format!(
            "model={} url={} audio_sec={:.1} language={} instruction={} hotwords={}",
            model,
            url,
            audio_sec,
            language.as_deref().unwrap_or("auto(omitted)"),
            instruction.is_some(),
            hotwords.len(),
        ),
    );

    let body = build_body(&model, &wav, instruction.as_deref(), language.as_deref(), audio_format);
    let client = super::http_client::shared();
    let start = Instant::now();

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| diag::fail(scope, "http_send", format!("Request failed: {}", e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let http_summary = diag::http_summary(resp.status(), resp.headers());

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(diag::fail(
            scope,
            "http_status",
            format!(
                "Transcription error {} [{}]: {}",
                status,
                http_summary,
                diag::truncate(&body_text, 300)
            ),
        ));
    }

    let body_text = resp
        .text()
        .await
        .map_err(|e| diag::fail(scope, "read_body", format!("Failed to read response: {}", e)))?;
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        diag::fail(
            scope,
            "parse_json",
            format!(
                "Failed to parse response: {} [{}] response excerpt: {}",
                e,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;

    let text = extract_text(&data);
    if text.is_empty() {
        // 空结果走成功路径，前端只显示「未检测到有效声音」。没有这条日志就分不出
        // 「真没说话」和「这次调用其实失败了」（见 pitfalls #15）。
        diag::empty_result(
            scope,
            &format!(
                "Response contained no transcript audio_sec={:.1} elapsed={}ms model={} [{}] {}",
                audio_sec,
                elapsed_ms,
                model,
                http_summary,
                diag::describe_json(&body_text)
            ),
        );
    } else {
        diag::ok(scope, elapsed_ms, text.chars().count());
    }

    Ok(AsrResult { text, elapsed_ms })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let endpoint = endpoint_for(&config.provider);
    let model = resolve_model(config, endpoint);
    let audio_format = audio_payload_format(&config.provider);
    let url = match resolve_url(config, endpoint) {
        Ok(u) => u,
        Err(e) => {
            return TestResult { ok: false, message: e, elapsed_ms: 0, detail: String::new() }
        }
    };

    // 0.5s 静音：够过服务端的「音频太短」门槛，又几乎不花钱。
    let wav = pcm_to_wav(&vec![0u8; 16000], 16000);
    let instruction = (needs_transcribe_instruction(&model) || matches!(audio_format, AudioPayloadFormat::OpenAi))
        .then_some(DEFAULT_TRANSCRIBE_INSTRUCTION);
    let body = build_body(&model, &wav, instruction, None, audio_format);

    let client = super::http_client::shared();
    let start = Instant::now();
    let result = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => TestResult {
            ok: true,
            message: format!("Connection successful, model: {} ({}ms)", model, elapsed_ms),
            elapsed_ms,
            detail: String::new(),
        },
        Ok(resp) => {
            let status = resp.status();
            let summary = diag::http_summary(status, resp.headers());
            let body_text = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: diag::fail(
                    endpoint.scope,
                    "http_status",
                    format!("Connection failed {} [{}]: {}", status, summary, diag::truncate(&body_text, 300)),
                ),
                elapsed_ms,
                detail: String::new(),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: diag::fail(endpoint.scope, "http_send", format!("Request failed: {}", e)),
            elapsed_ms,
            detail: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_for(provider: &str, extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: provider.to_string(),
            api_key: String::new(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn base_url_is_joined_into_a_chat_completions_path() {
        let expected = "https://example.com/compatible-mode/v1/chat/completions";
        assert_eq!(join_chat_url("https://example.com/compatible-mode/v1"), expected);
        assert_eq!(join_chat_url("https://example.com/compatible-mode/v1/"), expected);
        assert_eq!(join_chat_url(expected), expected);
    }

    /// 千问那一档：空着用百炼通用域名，填了用用户的（业务空间专属域名就靠这个）。
    #[test]
    fn the_qwen_endpoint_defaults_to_bailian_and_honors_an_override() {
        let endpoint = endpoint_for("qwen_chat_audio");

        let bare = config_for("qwen_chat_audio", serde_json::json!({}));
        assert_eq!(
            resolve_url(&bare, endpoint).unwrap(),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        );

        let workspace = config_for("qwen_chat_audio", serde_json::json!({
            "baseUrl": "https://ws-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        }));
        assert_eq!(
            resolve_url(&workspace, endpoint).unwrap(),
            "https://ws-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
        );
    }

    #[test]
    fn the_custom_endpoint_requires_an_address() {
        let missing = config_for("openai_chat_audio", serde_json::json!({}));
        assert!(resolve_url(&missing, endpoint_for("openai_chat_audio")).is_err());
    }

    /// 音频必须是 data URL。裸 base64 会被服务端拒，而报错说的是「URL 无效」，
    /// 完全看不出少了前缀 —— 所以这条得钉住。
    #[test]
    fn legacy_audio_is_sent_as_a_data_url() {
        let body = build_body("qwen3-asr-flash", &pcm_to_wav(&[0, 0, 0, 0], 16000), None, None, AudioPayloadFormat::DataUrl);
        let audio = body["messages"][0]["content"][0]["input_audio"]
            .as_str()
            .expect("input_audio must be a string");
        assert!(audio.starts_with("data:audio/wav;base64,"), "got {}", &audio[..40.min(audio.len())]);
    }

    #[test]
    fn standard_audio_is_sent_as_an_openai_object_with_raw_base64() {
        let wav = pcm_to_wav(&[1, 2, 3, 4], 16000);
        let body = build_body("gemini-example", &wav, Some(DEFAULT_TRANSCRIBE_INSTRUCTION), None, AudioPayloadFormat::OpenAi);
        let audio = &body["messages"][1]["content"][0]["input_audio"];
        assert_eq!(audio["format"], "wav");
        let data = audio["data"].as_str().expect("input_audio.data must be a string");
        assert!(!data.starts_with("data:"), "OpenAI input_audio.data needs raw base64");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(data).unwrap(), wav);
        assert_eq!(body["messages"][0]["role"], "system");
    }

    #[test]
    fn payload_format_is_selected_by_provider() {
        assert!(matches!(audio_payload_format("openai_chat_audio_standard"), AudioPayloadFormat::OpenAi));
        assert!(matches!(audio_payload_format("openai_chat_audio"), AudioPayloadFormat::DataUrl));
        assert!(matches!(audio_payload_format("qwen_chat_audio"), AudioPayloadFormat::DataUrl));
    }

    /// Omni 是对话模型，不给指令它会回答想象出来的问题（实测拿到过
    /// 「澳大利亚的首都是堪培拉」）。这条防的就是那种输出被当成转写插进文档。
    #[test]
    fn omni_models_get_a_transcribe_instruction() {
        assert!(needs_transcribe_instruction("qwen3.8-omni-flash"));
        assert!(needs_transcribe_instruction("qwen3.5-omni-plus"));
        assert!(needs_transcribe_instruction("Qwen3-Omni-Flash"));
        // 纯 ASR 模型不需要，给了反而多花 token
        assert!(!needs_transcribe_instruction("qwen3-asr-flash"));
        assert!(!needs_transcribe_instruction("whisper-1"));

        let omni = build_body("qwen3.8-omni-flash", &[], Some(DEFAULT_TRANSCRIBE_INSTRUCTION), None, AudioPayloadFormat::DataUrl);
        assert_eq!(omni["messages"][0]["role"], "system");
        assert_eq!(omni["messages"][1]["role"], "user");

        let asr = build_body("qwen3-asr-flash", &[], None, None, AudioPayloadFormat::DataUrl);
        assert_eq!(asr["messages"][0]["role"], "user");
        assert!(asr["messages"].as_array().unwrap().len() == 1);
    }

    #[test]
    fn auto_language_is_omitted_and_explicit_language_is_passed() {
        let auto = config_for("qwen_chat_audio", serde_json::json!({}));
        assert_eq!(resolve_language(&auto), None);
        let explicit = config_for("qwen_chat_audio", serde_json::json!({ "language": "zh" }));
        assert_eq!(resolve_language(&explicit).as_deref(), Some("zh"));

        let body = build_body("qwen3-asr-flash", &[], None, Some("zh"), AudioPayloadFormat::DataUrl);
        assert_eq!(body["asr_options"]["language"], "zh");
        let without = build_body("qwen3-asr-flash", &[], None, None, AudioPayloadFormat::DataUrl);
        assert!(without.get("asr_options").is_none());
    }

    /// content 两种形状都要收：字符串，和多模态的内容项数组。
    #[test]
    fn text_is_extracted_from_both_content_shapes() {
        let as_string = serde_json::json!({
            "choices": [{ "message": { "content": "  语音输入法测试成功。 " } }]
        });
        assert_eq!(extract_text(&as_string), "语音输入法测试成功。");

        let as_array = serde_json::json!({
            "choices": [{ "message": { "content": [
                { "type": "text", "text": "语音输入" },
                { "type": "text", "text": "法测试成功。" },
            ] } }]
        });
        assert_eq!(extract_text(&as_array), "语音输入法测试成功。");

        assert_eq!(extract_text(&serde_json::json!({})), "");
        assert_eq!(extract_text(&serde_json::json!({ "choices": [] })), "");
    }
}
