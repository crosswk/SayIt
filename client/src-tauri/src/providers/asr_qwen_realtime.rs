// 千问实时语音识别 — qwen3-asr-flash-realtime
// WebSocket 流式：边录边发，OpenAI Realtime 风格协议

use super::types::AsrProviderConfig;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite;

const MODEL: &str = "qwen3-asr-flash-realtime-2026-02-10";

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

static SESSION: once_cell::sync::Lazy<Arc<Mutex<Option<WsStream>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 打开千问实时 ASR 会话
#[tauri::command]
pub async fn qwen_stream_open(config: AsrProviderConfig) -> Result<(), String> {
    // 关闭旧会话
    {
        let mut session = SESSION.lock().await;
        if let Some(mut ws) = session.take() {
            let _ = ws.close(None).await;
        }
    }

    let url = format!("wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={}", MODEL);

    let request = tungstenite::http::Request::builder()
        .uri(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("OpenAI-Beta", "realtime=v1")
        .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Host", "dashscope.aliyuncs.com")
        .body(())
        .map_err(|e| format!("构建请求失败: {}", e))?;

    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {}", e))?;

    // 发送 session.update 配置
    let session_update = serde_json::json!({
        "event_id": "init_session",
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "input_audio_transcription": {
                "language": "zh"
            },
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.0,
                "silence_duration_ms": 400
            }
        }
    });

    ws.send(tungstenite::Message::Text(
        serde_json::to_string(&session_update).unwrap().into(),
    ))
    .await
    .map_err(|e| format!("发送 session.update 失败: {}", e))?;

    // 等待 session.updated 确认
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("接收确认失败: {}", e))?;
        if let tungstenite::Message::Text(text) = msg {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                let event_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if event_type == "session.updated" {
                    break;
                }
                if event_type == "error" {
                    let err_msg = data.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("未知错误");
                    return Err(format!("服务端错误: {}", err_msg));
                }
            }
        }
    }

    let mut session = SESSION.lock().await;
    *session = Some(ws);

    Ok(())
}

/// 发送音频数据
#[tauri::command]
pub async fn qwen_stream_send(pcm_b64: String) -> Result<(), String> {
    let mut session = SESSION.lock().await;
    let ws = session.as_mut().ok_or("会话未建立")?;

    let event = serde_json::json!({
        "event_id": format!("audio_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
        "type": "input_audio_buffer.append",
        "audio": pcm_b64
    });

    ws.send(tungstenite::Message::Text(
        serde_json::to_string(&event).unwrap().into(),
    ))
    .await
    .map_err(|e| format!("发送音频失败: {}", e))?;

    Ok(())
}

/// 结束会话并等待最终结果
#[tauri::command]
pub async fn qwen_stream_finish() -> Result<String, String> {
    let mut session = SESSION.lock().await;
    let ws = session.as_mut().ok_or("会话未建立")?;

    // 发送 session.finish
    let finish_event = serde_json::json!({
        "event_id": "finish",
        "type": "session.finish"
    });

    ws.send(tungstenite::Message::Text(
        serde_json::to_string(&finish_event).unwrap().into(),
    ))
    .await
    .map_err(|e| format!("发送 finish 失败: {}", e))?;

    // 等待 session.finished，收集转录结果
    let mut final_text = String::new();

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("接收结果失败: {}", e))?;
        if let tungstenite::Message::Text(text) = msg {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                let event_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match event_type {
                    "conversation.item.input_audio_transcription.completed" => {
                        if let Some(transcript) = data.get("transcript").and_then(|t| t.as_str()) {
                            if !transcript.is_empty() {
                                if !final_text.is_empty() {
                                    final_text.push_str("，");
                                }
                                final_text.push_str(transcript);
                            }
                        }
                    }
                    "session.finished" => {
                        // 优先用 session.finished 里的 transcript
                        if let Some(transcript) = data.get("transcript").and_then(|t| t.as_str()) {
                            if !transcript.is_empty() {
                                final_text = transcript.to_string();
                            }
                        }
                        break;
                    }
                    "error" => {
                        let err_msg = data.get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("未知错误");
                        let _ = ws.close(None).await;
                        *session = None;
                        return Err(format!("识别错误: {}", err_msg));
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = ws.close(None).await;
    *session = None;

    Ok(final_text)
}

/// 关闭会话
#[tauri::command]
pub async fn qwen_stream_close() -> Result<(), String> {
    let mut session = SESSION.lock().await;
    if let Some(mut ws) = session.take() {
        let _ = ws.close(None).await;
    }
    Ok(())
}
