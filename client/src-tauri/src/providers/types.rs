// ASR / AI 供应商的公共类型和 trait 定义

use serde::{Deserialize, Serialize};

/// ASR 识别结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrResult {
    pub text: String,
    /// 识别耗时（毫秒）
    pub elapsed_ms: u64,
}

/// AI 校对结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResult {
    pub text: String,
    /// 校对耗时（毫秒）
    pub elapsed_ms: u64,
}

/// 连接测试结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub elapsed_ms: u64,
    /// 测试详情（模型名、发送的 prompt、回复内容等）
    #[serde(default)]
    pub detail: String,
}

/// ASR 供应商配置（前端传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrProviderConfig {
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub app_id: String,
    /// 供应商特定的额外配置
    #[serde(default)]
    pub extra: serde_json::Value,
}

/// AI 供应商配置（前端传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderConfig {
    pub provider: String,
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    /// 供应商特定的额外配置
    #[serde(default)]
    pub extra: serde_json::Value,
}

/// 云端转写请求（前端传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudTranscribeRequest {
    /// base64 编码的 PCM Int16 音频
    pub audio_b64: String,
    pub sample_rate: u32,
    pub asr_config: AsrProviderConfig,
}

/// 云端 AI 校对请求（前端传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPolishRequest {
    pub text: String,
    pub ai_config: AiProviderConfig,
    #[serde(default)]
    pub system_prompt: Option<String>,
}
