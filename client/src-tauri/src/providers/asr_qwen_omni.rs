// Qwen-Omni-Realtime ASR+AI — 通过 WebSocket 实时接口
// 使用 Manual 模式：发送音频 → commit → create_response → 接收文本
// 同时充当 ASR 和 AI，输出模态设为仅文本

use super::types::{AsrProviderConfig, AsrResult, TestResult};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use std::time::Instant;
use tokio_tungstenite::tungstenite;

/// 默认模型
const DEFAULT_MODEL: &str = "qwen3-omni-flash-realtime";

fn ws_url(model: &str) -> String {
    format!(
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={}",
        model
    )
}

#[allow(dead_code)]
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

/// 获取模型 ID（从 extra 字段或使用默认值）
fn get_model(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string()
}

/// 获取 system prompt（从 extra 字段）
fn get_instructions(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("instructions")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("你是一个语音转文字助手。请将用户的语音内容准确转写为文字，保持原意，适当添加标点符号，不要添加任何额外的解释或评论。")
        .to_string()
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    _sample_rate: u32,
    config: &AsrProviderConfig,
) -> Result<AsrResult, String> {
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(audio_pcm_b64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    if pcm.is_empty() {
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let model = get_model(config);
    let instructions = get_instructions(config);
    let url = ws_url(&model);

    // 构建 WebSocket 请求
    let request = tungstenite::http::Request::builder()
        .uri(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Host", "dashscope.aliyuncs.com")
        .body(())
        .map_err(|e| format!("构建请求失败: {}", e))?;

    let start = Instant::now();

    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {}", e))?;

    // 等待 session.created
    wait_for_event(&mut ws, "session.created").await?;

    // 发送 session.update — 仅输出文本，禁用 VAD（Manual 模式）
    let session_update = serde_json::json!({
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "instructions": instructions,
            "input_audio_format": "pcm",
            "turn_detection": null
        }
    });
    ws.send(tungstenite::Message::Text(session_update.to_string().into()))
        .await
        .map_err(|e| format!("发送 session.update 失败: {}", e))?;

    // 等待 session.updated
    wait_for_event(&mut ws, "session.updated").await?;

    // 发送音频数据（PCM 16kHz 16bit mono，分块发送）
    // Qwen Omni 接受原始 PCM，不需要 WAV 头
    // 但如果采样率不是 16kHz，需要注意
    let chunk_size = 3200; // 100ms @ 16kHz 16bit mono
    for chunk in pcm.chunks(chunk_size) {
        let audio_b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
        let append_event = serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": audio_b64
        });
        ws.send(tungstenite::Message::Text(append_event.to_string().into()))
            .await
            .map_err(|e| format!("发送音频失败: {}", e))?;
    }

    // 提交音频并请求响应
    let commit = serde_json::json!({ "type": "input_audio_buffer.commit" });
    ws.send(tungstenite::Message::Text(commit.to_string().into()))
        .await
        .map_err(|e| format!("发送 commit 失败: {}", e))?;

    let create_response = serde_json::json!({ "type": "response.create" });
    ws.send(tungstenite::Message::Text(create_response.to_string().into()))
        .await
        .map_err(|e| format!("发送 response.create 失败: {}", e))?;

    // 收集响应文本
    let mut result_text = String::new();
    let mut input_transcript = String::new();
    let timeout = tokio::time::Duration::from_secs(60);

    loop {
        let msg = match tokio::time::timeout(timeout, ws.next()).await {
            Err(_) => {
                let _ = ws.close(None).await;
                return Err("等待响应超时 (60s)".to_string());
            }
            Ok(None) => break, // 连接已关闭
            Ok(Some(Err(e))) => {
                // 连接错误（包括对方关闭后仍发消息），跳出循环用已有结果
                if !result_text.is_empty() || !input_transcript.is_empty() {
                    break;
                }
                return Err(format!("接收消息失败: {}", e));
            }
            Ok(Some(Ok(m))) => m,
        };

        match msg {
            tungstenite::Message::Text(text) => {
                let event: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let event_type = event
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("");

                match event_type {
                    "response.text.delta" => {
                        if let Some(delta) = event.get("delta").and_then(|d| d.as_str()) {
                            result_text.push_str(delta);
                        }
                    }
                    "response.audio_transcript.delta" => {
                        if let Some(delta) = event.get("delta").and_then(|d| d.as_str()) {
                            result_text.push_str(delta);
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        if let Some(t) = event.get("transcript").and_then(|t| t.as_str()) {
                            input_transcript = t.to_string();
                        }
                    }
                    "response.text.done" | "response.audio_transcript.done" => {
                        if let Some(t) = event.get("text").and_then(|t| t.as_str()) {
                            if !t.is_empty() {
                                result_text = t.to_string();
                            }
                        }
                        if let Some(t) = event.get("transcript").and_then(|t| t.as_str()) {
                            if !t.is_empty() {
                                result_text = t.to_string();
                            }
                        }
                    }
                    "response.done" => {
                        break;
                    }
                    "error" => {
                        let err_msg = event
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("未知错误");
                        let _ = ws.close(None).await;
                        return Err(format!("Qwen Omni 错误: {}", err_msg));
                    }
                    _ => {}
                }
            }
            tungstenite::Message::Close(_) => break,
            _ => {}
        }
    }

    let _ = ws.close(None).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    // 如果 AI 没有输出文本但有输入转录，使用输入转录
    let final_text = if result_text.trim().is_empty() && !input_transcript.is_empty() {
        input_transcript
    } else {
        result_text
    };

    Ok(AsrResult {
        text: final_text,
        elapsed_ms,
    })
}

/// 等待指定类型的事件
async fn wait_for_event(
    ws: &mut (impl StreamExt<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin),
    expected_type: &str,
) -> Result<serde_json::Value, String> {
    let timeout = tokio::time::Duration::from_secs(10);
    loop {
        let msg = match tokio::time::timeout(timeout, ws.next()).await {
            Err(_) => return Err(format!("等待 {} 超时", expected_type)),
            Ok(None) => return Err(format!("等待 {} 时连接关闭", expected_type)),
            Ok(Some(Err(e))) => return Err(format!("接收消息失败: {}", e)),
            Ok(Some(Ok(m))) => m,
        };

        match msg {
            tungstenite::Message::Text(text) => {
                let event: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| format!("解析事件失败: {}", e))?;

                let event_type = event
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("");

                if event_type == "error" {
                    let err_msg = event
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("未知错误");
                    return Err(format!("Qwen Omni 错误: {}", err_msg));
                }

                if event_type == expected_type {
                    return Ok(event);
                }
            }
            tungstenite::Message::Close(frame) => {
                let reason = frame
                    .map(|f| format!("code={}, reason={}", f.code, f.reason))
                    .unwrap_or_else(|| "无详情".to_string());
                return Err(format!("等待 {} 时服务端关闭了连接 ({})", expected_type, reason));
            }
            _ => {}
        }
    }
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let model = get_model(config);
    let url = ws_url(&model);

    let request = tungstenite::http::Request::builder()
        .uri(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Host", "dashscope.aliyuncs.com")
        .body(())
        .unwrap();

    let start = Instant::now();

    match tokio_tungstenite::connect_async(request).await {
        Ok((mut ws, _)) => {
            // 尝试等待 session.created
            let result = wait_for_event(&mut ws, "session.created").await;
            let _ = ws.close(None).await;
            let elapsed_ms = start.elapsed().as_millis() as u64;
            match result {
                Ok(_) => TestResult {
                    ok: true,
                    message: format!("连接成功，模型: {} ({}ms)", model, elapsed_ms),
                    elapsed_ms,
                    detail: String::new(),
                },
                Err(e) => TestResult {
                    ok: false,
                    message: format!("连接后握手失败: {} ({}ms)", e, elapsed_ms),
                    elapsed_ms,
                    detail: String::new(),
                },
            }
        }
        Err(e) => {
            let elapsed_ms = start.elapsed().as_millis() as u64;
            TestResult {
                ok: false,
                message: format!("连接失败: {}", e),
                elapsed_ms,
                detail: String::new(),
            }
        }
    }
}
