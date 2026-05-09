// 供应商注册表 — Tauri commands 入口

use super::types::*;
use super::{ai_openai_compat, ai_ollama, asr_doubao, asr_doubao_stream, asr_qwen, asr_qwen_omni};

/// 云端 AI 校对（Tauri command）
#[tauri::command]
pub async fn cloud_polish(request: CloudPolishRequest) -> Result<AiResult, String> {
    let config = &request.ai_config;
    match config.provider.as_str() {
        "openai_compat" | "deepseek" | "doubao" | "qwen" => {
            ai_openai_compat::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
            )
            .await
        }
        "ollama" => {
            ai_ollama::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
            )
            .await
        }
        other => Err(format!("未知的 AI 供应商: {}", other)),
    }
}

/// 测试 AI 连接（Tauri command）
#[tauri::command]
pub async fn test_ai_connection(config: AiProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "openai_compat" | "deepseek" | "doubao" | "qwen" => {
            Ok(ai_openai_compat::test_connection(&config).await)
        }
        "ollama" => {
            Ok(ai_ollama::test_connection(&config).await)
        }
        other => Err(format!("未知的 AI 供应商: {}", other)),
    }
}

/// 云端 ASR 转写（Tauri command）
#[tauri::command]
pub async fn cloud_transcribe(request: CloudTranscribeRequest) -> Result<AsrResult, String> {
    let config = &request.asr_config;
    match config.provider.as_str() {
        "doubao" => {
            asr_doubao::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
            )
            .await
        }
        "doubao_v2" => {
            asr_doubao_stream::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
            )
            .await
        }
        "qwen" | "aliyun" | "qwen_realtime" => {
            asr_qwen::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
            )
            .await
        }
        "qwen_omni" => {
            asr_qwen_omni::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
            )
            .await
        }
        // TODO: "aliyun" => 阿里云 Paraformer（需要文件 URL + 异步轮询，暂未实现）
        other => Err(format!("ASR 供应商 \"{}\" 尚未实现", other)),
    }
}

/// 测试 ASR 连接（Tauri command）
#[tauri::command]
pub async fn test_asr_connection(config: AsrProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "doubao" => Ok(asr_doubao::test_connection(&config).await),
        "doubao_v2" => Ok(asr_doubao_stream::test_connection(&config).await),
        "qwen" | "aliyun" | "qwen_realtime" => Ok(asr_qwen::test_connection(&config).await),
        "qwen_omni" => Ok(asr_qwen_omni::test_connection(&config).await),
        other => Err(format!("ASR 供应商 \"{}\" 尚未实现", other)),
    }
}
