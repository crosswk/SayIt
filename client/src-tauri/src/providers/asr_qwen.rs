// 阿里云千问 ASR — qwen3-asr-flash
// DashScope 多模态接口，支持 Base64 data URL 音频

use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

const API_URL: &str = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

/// 将热词列表拼接为千问 ASR 的上下文偏置文本。
///
/// Qwen3-ASR 支持通过上下文文本（context/corpus）提升专业术语、人名等识别准确率，
/// 最多 10000 tokens。非流式接口放在 system 消息文本里，实时接口放在
/// session.input_audio_transcription.corpus.text 里。
///
/// 词表用「空格」拼接（与本项目自建后端本地 qwen3 的 context 用法一致：
/// `" ".join(hotwords)` 传给 model.transcribe(context=...)，实测偏置效果更好）。
pub fn build_hotword_context_text(hotwords: &[String]) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    let words: Vec<&str> = hotwords
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .filter(|w| seen.insert(w.to_string()))
        .collect();
    if words.is_empty() {
        return None;
    }
    Some(words.join(" "))
}

/// 去掉分隔符/标点/空白并转小写，用于回显比较。
fn normalize_for_echo(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !"、,，;；。.·/|\\".contains(*c))
        .collect::<String>()
        .to_lowercase()
}

/// 热词回显检测：音频短/不清晰时，模型可能把传入的热词表整串吐出来。
/// 做法：结果去标点/空白/常见连接词后，逐个扣掉命中的热词；若最终无残余
/// 且命中的「不同热词」≥3，判为回显幻觉，返回空串。
/// 门槛 ≥3 是为了不误伤真实的单/双热词短句（如只说了 "Typeless 和 SayIt"）。
fn strip_hotword_echo(text: String, hotwords: &[&str]) -> String {
    if hotwords.is_empty() {
        return text;
    }
    let mut rest = normalize_for_echo(&text);
    if rest.is_empty() {
        return text;
    }
    // 去掉常见连接词，避免它们残留导致误判为"有额外内容"
    for conn in ["和", "与", "跟", "及", "以及", "还有", "and"] {
        rest = rest.replace(conn, "");
    }
    // 长词优先，避免子串误配（如 LiteLLM 含 LLM）
    let mut hw: Vec<String> = hotwords
        .iter()
        .map(|w| normalize_for_echo(w))
        .filter(|w| !w.is_empty())
        .collect();
    hw.sort_by(|a, b| b.len().cmp(&a.len()));
    let mut distinct = 0usize;
    for w in &hw {
        if rest.contains(w.as_str()) {
            distinct += 1;
            while let Some(pos) = rest.find(w.as_str()) {
                rest.replace_range(pos..pos + w.len(), "");
            }
        }
    }
    if rest.is_empty() && distinct >= 3 {
        return String::new();
    }
    text
}

fn pcm_to_wav(pcm: &[u8], sr: u32) -> Vec<u8> {
    let ds = pcm.len() as u32;
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + ds).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&sr.to_le_bytes());
    w.extend_from_slice(&(sr * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&ds.to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let pcm = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD, audio_pcm_b64,
    ).map_err(|e| format!("base64 解码失败: {}", e))?;

    if pcm.is_empty() {
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let wav = pcm_to_wav(&pcm, sample_rate);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);
    let data_url = format!("data:audio/wav;base64,{}", wav_b64);

    // 热词上下文偏置：用「逗号词表」作为 system 上下文。实测逗号分隔最稳
    // （空格会给结果加引号；带"请识别以下术语"引导语则容易让模型把整串热词吐出来=回显）。
    let mut seen = std::collections::HashSet::new();
    let words: Vec<&str> = hotwords
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .filter(|w| seen.insert(w.to_string()))
        .collect();
    let system_text = words.join(", ");

    let body = serde_json::json!({
        "model": "qwen3-asr-flash",
        "input": {
            "messages": [
                { "role": "system", "content": [{ "text": system_text }] },
                { "role": "user", "content": [{ "audio": data_url }] }
            ]
        },
        "parameters": {
            "asr_options": { "enable_itn": true }
        }
    });

    let client = reqwest::Client::new();
    let start = Instant::now();

    let resp = client
        .post(API_URL)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("千问 ASR 错误 {}: {}", status, &body[..body.len().min(300)]));
    }

    let data: serde_json::Value = resp.json().await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    // 响应格式：output.choices[0].message.content[0].text
    let text = data.get("output")
        .and_then(|o| o.get("choices"))
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    // 防热词回显：短/不清晰音频下，模型可能把整串热词吐出来。命中≥3个且无其它内容则清空。
    let text = strip_hotword_echo(text, &words);

    Ok(AsrResult { text, elapsed_ms })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let silence = vec![0u8; 16000];
    let wav = pcm_to_wav(&silence, 16000);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);

    let body = serde_json::json!({
        "model": "qwen3-asr-flash",
        "input": {
            "messages": [
                { "role": "system", "content": [{ "text": "" }] },
                { "role": "user", "content": [{ "audio": format!("data:audio/wav;base64,{}", wav_b64) }] }
            ]
        }
    });

    let client = reqwest::Client::new();
    let start = Instant::now();

    let result = client
        .post(API_URL)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => TestResult {
            ok: true,
            message: format!("连接成功 ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: String::new(),
        },
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: format!("API 错误 {}: {}", status, &body[..body.len().min(100)]),
                elapsed_ms,
                detail: String::new(),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: format!("连接失败: {}", e),
            elapsed_ms,
            detail: String::new(),
        },
    }
}
