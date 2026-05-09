// 豆包（火山引擎）ASR 供应商
// 使用大模型录音文件极速版 HTTP API：一次请求即返回结果
// 接口：POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash

use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

const RECOGNIZE_URL: &str =
    "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const RESOURCE_ID: &str = "volc.bigasr.auc_turbo";

/// 将 PCM Int16 音频转换为 WAV 格式（火山引擎需要 WAV/MP3/OGG 格式）
fn pcm_to_wav(pcm_data: &[u8], sample_rate: u32) -> Vec<u8> {
    let num_channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * u32::from(num_channels) * u32::from(bits_per_sample) / 8;
    let block_align = num_channels * bits_per_sample / 8;
    let data_size = pcm_data.len() as u32;
    let file_size = 36 + data_size;

    let mut wav = Vec::with_capacity(44 + pcm_data.len());
    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&file_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    // fmt chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    wav.extend_from_slice(&num_channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    // data chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.extend_from_slice(pcm_data);
    wav
}

/// 调用豆包极速版 ASR
pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
) -> Result<AsrResult, String> {
    // 解码 base64 PCM 数据
    let pcm_data = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        audio_pcm_b64,
    )
    .map_err(|e| format!("base64 解码失败: {}", e))?;

    if pcm_data.is_empty() {
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    // 转换为 WAV 格式并 base64 编码
    let wav_data = pcm_to_wav(&pcm_data, sample_rate);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_data);

    let app_id = if config.app_id.is_empty() {
        &config.api_key // 有些用户可能只填一个
    } else {
        &config.app_id
    };

    let body = serde_json::json!({
        "user": {
            "uid": app_id
        },
        "audio": {
            "data": wav_b64
        },
        "request": {
            "model_name": "bigmodel"
        }
    });

    let client = reqwest::Client::new();
    let start = Instant::now();

    let resp = client
        .post(RECOGNIZE_URL)
        .header("X-Api-App-Key", app_id)
        .header("X-Api-Access-Key", &config.api_key)
        .header("X-Api-Resource-Id", RESOURCE_ID)
        .header("X-Api-Request-Id", uuid::Uuid::new_v4().to_string())
        .header("X-Api-Sequence", "-1")
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", e))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // 检查响应头中的状态码
    let status_code = resp
        .headers()
        .get("X-Api-Status-Code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let api_message = resp
        .headers()
        .get("X-Api-Message")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "豆包 ASR 请求失败 HTTP {}: {}",
            status,
            truncate(&body_text, 200)
        ));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    // 检查 API 状态码
    if status_code != "20000000" && !status_code.is_empty() {
        return Err(format!(
            "豆包 ASR 错误 {}: {}",
            status_code, api_message
        ));
    }

    // 提取识别文本
    let text = data
        .get("result")
        .and_then(|r| r.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    Ok(AsrResult { text, elapsed_ms })
}

/// 测试豆包 ASR 连接（发送一段极短的静音音频）
pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    // 生成 0.5 秒静音 PCM（16kHz, 16bit）
    let silence = vec![0u8; 16000]; // 0.5s * 16000 * 2 bytes = 16000 bytes
    let wav = pcm_to_wav(&silence, 16000);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);

    let app_id = if config.app_id.is_empty() {
        &config.api_key
    } else {
        &config.app_id
    };

    let body = serde_json::json!({
        "user": { "uid": app_id },
        "audio": { "data": wav_b64 },
        "request": { "model_name": "bigmodel" }
    });

    let client = reqwest::Client::new();
    let start = Instant::now();

    let result = client
        .post(RECOGNIZE_URL)
        .header("X-Api-App-Key", app_id)
        .header("X-Api-Access-Key", &config.api_key)
        .header("X-Api-Resource-Id", RESOURCE_ID)
        .header("X-Api-Request-Id", uuid::Uuid::new_v4().to_string())
        .header("X-Api-Sequence", "-1")
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) => {
            let status_code = resp
                .headers()
                .get("X-Api-Status-Code")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();

            if status_code == "20000000" || status_code == "20000003" {
                // 20000003 = 静音音频，也算连接成功
                TestResult {
                    ok: true,
                    message: format!("连接成功 ({}ms)", elapsed_ms),
                    elapsed_ms,
                    detail: String::new(),
                }
            } else if resp.status().is_success() {
                TestResult {
                    ok: true,
                    message: format!("连接成功 ({}ms)，状态码: {}", elapsed_ms, status_code),
                    elapsed_ms,
                    detail: String::new(),
                }
            } else {
                let body = resp.text().await.unwrap_or_default();
                TestResult {
                    ok: false,
                    message: format!("API 错误: {}", truncate(&body, 100)),
                    elapsed_ms,
                    detail: String::new(),
                }
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

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}
