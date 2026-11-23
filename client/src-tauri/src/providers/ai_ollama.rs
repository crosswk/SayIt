// Ollama AI 供应商
// 调用本地 Ollama 的 /api/generate 接口

use super::diag;
use super::prompt::wrap_user_text;
use super::types::{AiProviderConfig, AiResult, TestResult, TextContext};
use std::time::Instant;

const SCOPE: &str = "ai/ollama";

/// /api/generate 请求体。始终带 `"think": false`（issue #97）。
///
/// 不传时 Qwen3.5 这类模型按自己的默认先思考，口述整理要多等好几秒，而改错字、去口头禅
/// 用不着思考。OpenAI 兼容那一路也是默认关思考（见 ai_openai_compat::thinking_overrides），
/// 这里同一个口径，不另设开关。Ollama 文档：本来不思考的模型不受影响；关不掉思考的
/// （如 gpt-oss）自动用最低一档；不认识这个字段的老版本 Ollama 会忽略它。
fn request_body(model: &str, prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "stream": false,
        "think": false,
        "prompt": prompt
    })
}

/// 调用 Ollama 进行文本校对
pub async fn polish(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: Option<&str>,
    text_context: Option<&TextContext>,
) -> Result<AiResult, String> {
    if text.trim().is_empty() {
        return Ok(AiResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let url = normalize_url(&config.api_url);
    let sys_prompt = system_prompt.unwrap_or("你是语音转文本的校对助手。");
    // Ollama /api/generate 是单一 prompt 字符串，没有 system/user 角色区分，
    // 这里手动拼接：system prompt 在前，user 消息（中性标签包裹）在后。
    let combined = format!("{}\n\n{}", sys_prompt, wrap_user_text(text, text_context));

    let model = if config.model.is_empty() {
        "qwen2.5:7b"
    } else {
        &config.model
    };

    let body = request_body(model, &combined);

    let client = super::http_client::shared();
    let start = Instant::now();

    diag::log(
        SCOPE,
        "start",
        &format!("model={} chars={} url={}", model, text.chars().count(), url),
    );

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| diag::fail(SCOPE, "http_send", format!("Ollama request failed: {}", e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let http_summary = diag::http_summary(resp.status(), resp.headers());

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!(
                "Ollama returned error {} [{}]: {}",
                status,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        ));
    }

    let body_text = resp.text().await.map_err(|e| {
        diag::fail(
            SCOPE,
            "read_body",
            format!("Failed to read response: {}", e),
        )
    })?;
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        diag::fail(
            SCOPE,
            "parse_json",
            format!(
                "Failed to parse Ollama response: {} response excerpt: {}",
                e,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;

    let result_text = data
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    // 空回复会静默回落成原文 —— 用户以为校对跑过了，其实没有。留证。
    if result_text.is_empty() {
        diag::log(
            SCOPE,
            "empty_response_fallback_to_input",
            &format!(
                "Ollama returned no content; returned the original text model={} {}",
                model,
                diag::describe_json(&body_text)
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, result_text.chars().count());
    }

    Ok(AiResult {
        text: if result_text.is_empty() {
            text.to_string()
        } else {
            result_text
        },
        elapsed_ms,
    })
}

/// 测试 Ollama 连接 — 实际调用模型，验证模型是否可用
pub async fn test_connection(config: &AiProviderConfig) -> TestResult {
    let url = normalize_url(&config.api_url);

    let model = if config.model.is_empty() {
        "qwen2.5:7b"
    } else {
        &config.model
    };

    let prompt = "Reply with OK only. Do not output anything else.";

    // 和整理用同一个请求体：测试通过就说明实际整理的参数也被接受
    let body = request_body(model, prompt);

    let client = super::http_client::shared();
    let start = Instant::now();

    let result = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            let reply = data
                .get("response")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let detail = format!(
                "Elapsed: {}ms\nModel: {}\nSent: \"{}\"\nReply: {}",
                elapsed_ms,
                model,
                prompt,
                if reply.is_empty() { "(empty)" } else { &reply }
            );
            TestResult {
                ok: true,
                message: format!("Connection successful ({}ms)", elapsed_ms),
                elapsed_ms,
                detail,
            }
        }
        Ok(resp) => {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: diag::fail(
                    "ai/ollama-test",
                    "http_status",
                    format!(
                        "Ollama returned {}: {}",
                        status,
                        diag::truncate(&body_text, 100)
                    ),
                ),
                elapsed_ms,
                detail: format!("Model: {}\nRequest URL: {}", model, url),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/ollama-test",
                "http_send",
                format!("Connection failed: {}", e),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", model, url),
        },
    }
}

pub(super) fn normalize_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.ends_with("/api/generate") {
        trimmed.to_string()
    } else if trimmed.ends_with("/api") {
        format!("{}/generate", trimmed)
    } else {
        format!("{}/api/generate", trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::request_body;

    /// issue #97：`think` 必须是顶层的布尔 false，放进 options 里 Ollama 不认
    #[test]
    fn request_disables_thinking_at_top_level() {
        let body = request_body("qwen3.5:4b", "hi");
        assert_eq!(body["think"], serde_json::json!(false));
        assert_eq!(body["stream"], serde_json::json!(false));
        assert!(body.get("options").is_none());
    }
}
