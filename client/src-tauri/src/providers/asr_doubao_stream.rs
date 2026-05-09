// 豆包流式语音识别 2.0 — 使用流式输入模式（bigmodel_nostream）
// 录完后一次性发送 PCM 音频，等最终结果返回

use super::doubao_protocol;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use futures_util::{SinkExt, StreamExt};
use std::time::Instant;
use tokio_tungstenite::tungstenite;

const WS_URL: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
const RESOURCE_ID: &str = "volc.seedasr.sauc.duration";

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
) -> Result<AsrResult, String> {
    let pcm_data = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        audio_pcm_b64,
    )
    .map_err(|e| format!("base64 解码失败: {}", e))?;

    if pcm_data.is_empty() {
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let app_id = if config.app_id.is_empty() { &config.api_key } else { &config.app_id };
    let connect_id = uuid::Uuid::new_v4().to_string();

    // 构建 WebSocket 请求
    let request = tungstenite::http::Request::builder()
        .uri(WS_URL)
        .header("Host", "openspeech.bytedance.com")
        .header("X-Api-App-Key", app_id)
        .header("X-Api-Access-Key", &config.api_key)
        .header("X-Api-Resource-Id", RESOURCE_ID)
        .header("X-Api-Connect-Id", &connect_id)
        .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .body(())
        .map_err(|e| format!("构建请求失败: {}", e))?;

    let start = Instant::now();

    // 连接 WebSocket
    let (mut ws, _response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {}", e))?;

    // 1. 发送 full client request
    let client_request = serde_json::json!({
        "user": { "uid": app_id },
        "audio": {
            "format": "pcm",
            "rate": sample_rate,
            "bits": 16,
            "channel": 1
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": true,
            "enable_punc": true,
            "result_type": "full",
            "show_utterances": true
        }
    });

    let request_frame = doubao_protocol::build_full_client_request(
        &serde_json::to_string(&client_request).unwrap(),
    );
    ws.send(tungstenite::Message::Binary(request_frame.into()))
        .await
        .map_err(|e| format!("发送请求失败: {}", e))?;

    // 等待服务端确认
    if let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("接收确认失败: {}", e))?;
        if let tungstenite::Message::Binary(data) = msg {
            let resp = doubao_protocol::parse_server_response(&data)?;
            if resp.is_error {
                return Err(format!("服务端错误: {}", resp.payload));
            }
        }
    }

    // 2. 发送音频数据（直接发 PCM，不转 WAV）
    // nostream 模式下服务端等最后一包才处理，一次性发完最快
    let audio_frame = doubao_protocol::build_audio_request(&pcm_data, true);
    ws.send(tungstenite::Message::Binary(audio_frame.into()))
        .await
        .map_err(|e| format!("发送音频失败: {}", e))?;

    // 3. 接收结果（bigmodel_async 双向流式：每包输入对应一包返回，取最终结果）
    let mut final_text = String::new();

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("接收结果失败: {}", e))?;
        match msg {
            tungstenite::Message::Binary(data) => {
                let resp = doubao_protocol::parse_server_response(&data)?;
                if resp.is_error {
                    return Err(format!("识别错误: {}", resp.payload));
                }

                // 解析 JSON 结果，持续更新 final_text
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&resp.payload) {
                    if let Some(text) = json.get("result").and_then(|r| r.get("text")).and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            final_text = text.to_string();
                        }
                    }
                }

                if resp.is_last {
                    break;
                }
            }
            tungstenite::Message::Close(_) => break,
            _ => {}
        }
    }

    // 关闭连接
    let _ = ws.close(None).await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    Ok(AsrResult {
        text: final_text,
        elapsed_ms,
    })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let app_id = if config.app_id.is_empty() { &config.api_key } else { &config.app_id };

    let request = tungstenite::http::Request::builder()
        .uri(WS_URL)
        .header("Host", "openspeech.bytedance.com")
        .header("X-Api-App-Key", app_id)
        .header("X-Api-Access-Key", &config.api_key)
        .header("X-Api-Resource-Id", RESOURCE_ID)
        .header("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string())
        .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .body(())
        .unwrap();

    let start = Instant::now();

    match tokio_tungstenite::connect_async(request).await {
        Ok((mut ws, _)) => {
            let _ = ws.close(None).await;
            let elapsed_ms = start.elapsed().as_millis() as u64;
            TestResult {
                ok: true,
                message: format!("连接成功 ({}ms)", elapsed_ms),
                elapsed_ms,
                detail: String::new(),
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
