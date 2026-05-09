// OpenAI 兼容 AI 供应商
// 覆盖所有支持 /v1/chat/completions 的服务：DeepSeek、通义、豆包（火山方舟）等

use super::types::{AiProviderConfig, AiResult, TestResult};
use std::time::Instant;

/// 调用 OpenAI 兼容接口进行文本校对
pub async fn polish(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: Option<&str>,
) -> Result<AiResult, String> {
    if text.trim().is_empty() {
        return Ok(AiResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let base_url = normalize_base_url(&config.api_url);
    let url = format!("{}/chat/completions", base_url);

    let sys_prompt = system_prompt.unwrap_or("你是语音转文本的校对助手。");
    let user_content = format!("请处理以下语音转写文本：\n\n{}", text);

    let mut body = serde_json::json!({
        "model": config.model,
        "temperature": 0.2,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": sys_prompt },
            { "role": "user", "content": user_content },
        ]
    });

    // 通义千问 Qwen3 系列默认开启思考模式，校对场景不需要
    if config.provider == "qwen" {
        body.as_object_mut().unwrap().insert(
            "enable_thinking".to_string(),
            serde_json::Value::Bool(false),
        );
    }

    // DeepSeek V4 Flash 默认开启 thinking，校对场景关闭以降低延迟
    if config.provider == "deepseek" {
        body.as_object_mut().unwrap().insert(
            "thinking".to_string(),
            serde_json::json!({"type": "disabled"}),
        );
    }

    let client = reqwest::Client::new();
    let start = Instant::now();

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", describe_reqwest_error(&e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("API 返回错误 {}: {}", status, truncate(&body_text, 200)));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let result_text = extract_chat_completion_text(&data)
        .unwrap_or_else(|| text.to_string());

    // 去除 <think>...</think> 标签（部分模型如 Qwen3 会输出思考过程）
    let cleaned = strip_thinking(&result_text);

    Ok(AiResult {
        text: if cleaned.is_empty() { text.to_string() } else { cleaned },
        elapsed_ms,
    })
}

/// 测试 AI 连接 — 发送一个简短的聊天请求，验证地址、Key、模型是否都可用
pub async fn test_connection(config: &AiProviderConfig) -> TestResult {
    let base_url = normalize_base_url(&config.api_url);
    let url = format!("{}/chat/completions", base_url);

    let system_prompt = "只回复「连接正常」四个字，不要输出任何其他内容。";
    let user_prompt = "测试";

    let mut body = serde_json::json!({
        "model": config.model,
        "temperature": 0,
        "max_tokens": 10,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });

    if config.provider == "qwen" {
        body.as_object_mut().unwrap().insert(
            "enable_thinking".to_string(),
            serde_json::Value::Bool(false),
        );
    }

    if config.provider == "deepseek" {
        body.as_object_mut().unwrap().insert(
            "thinking".to_string(),
            serde_json::json!({"type": "disabled"}),
        );
    }

    let client = reqwest::Client::new();
    let start = Instant::now();

    let result = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            let raw_reply = data
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let reply = strip_thinking(&raw_reply);
            let detail = format!(
                "耗时: {}ms\n模型: {}\n发送: system=\"{}\" user=\"{}\"\n回复: {}",
                elapsed_ms, config.model, system_prompt, user_prompt,
                if reply.is_empty() { "(空)" } else { &reply }
            );
            TestResult {
                ok: true,
                message: format!("连接成功 ({}ms)", elapsed_ms),
                elapsed_ms,
                detail,
            }
        }
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: format!("API 返回 {}: {}", status, truncate(&body, 100)),
                elapsed_ms,
                detail: format!("模型: {}\n请求地址: {}", config.model, url),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: format!("连接失败: {}", describe_reqwest_error(&e)),
            elapsed_ms,
            detail: format!("模型: {}\n请求地址: {}", config.model, url),
        },
    }
}

/// 将 reqwest 错误转为用户友好的中文描述
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let raw = format!("{}", e);
    if e.is_timeout() {
        return "请求超时，请检查网络或 API 地址是否正确".to_string();
    }
    if e.is_connect() {
        // 尝试区分 DNS / TLS / 连接拒绝
        let lower = raw.to_lowercase();
        if lower.contains("dns") || lower.contains("resolve") || lower.contains("getaddrinfo") {
            return format!("DNS 解析失败，域名可能不存在或网络不通: {}", raw);
        }
        if lower.contains("ssl") || lower.contains("tls") || lower.contains("certificate")
            || lower.contains("handshake") || lower.contains("schannel")
        {
            return format!("TLS/SSL 握手失败，可能是证书问题: {}", raw);
        }
        if lower.contains("refused") {
            return format!("连接被拒绝，服务可能未启动: {}", raw);
        }
        return format!("无法连接到服务器: {}", raw);
    }
    raw
}

/// 规范化 base URL
fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    // 已经以 /v1 或 /v3 等版本路径结尾
    if trimmed.ends_with("/v1") || trimmed.ends_with("/v3") {
        trimmed.to_string()
    } else if trimmed.ends_with("/api") {
        // 豆包等：https://ark.cn-beijing.volces.com/api → 加 /v3
        format!("{}/v3", trimmed)
    } else {
        format!("{}/v1", trimmed)
    }
}

/// 从 chat completion 响应中提取文本
fn extract_chat_completion_text(data: &serde_json::Value) -> Option<String> {
    let content = data
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?;

    match content {
        serde_json::Value::String(s) => Some(s.trim().to_string()),
        serde_json::Value::Array(arr) => {
            let text: String = arr
                .iter()
                .filter_map(|item| {
                    if item.get("type")?.as_str()? == "text" {
                        item.get("text")?.as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("");
            Some(text.trim().to_string())
        }
        _ => None,
    }
}

/// 去除 <think>...</think> 标签
fn strip_thinking(text: &str) -> String {
    let re = regex::Regex::new(r"(?is)<think>.*?</think>").unwrap_or_else(|_| {
        // fallback: 不做处理
        regex::Regex::new(r"^$").unwrap()
    });
    let cleaned = re.replace_all(text, "");
    let cleaned = cleaned.trim();

    // 如果有"最终答案"标记，取其后面的内容
    if let Some(pos) = cleaned.find("最终答案") {
        let after = &cleaned[pos + "最终答案".len()..];
        let after = after.trim_start_matches(|c: char| c == ':' || c == '：' || c.is_whitespace());
        return after.trim().to_string();
    }

    cleaned.to_string()
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}
