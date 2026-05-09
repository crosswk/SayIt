// 标准测试音频 — 生成一段包含正弦波的 PCM 音频用于 ASR 速度测试
// 实际使用时应该用真实的语音录音，这里先用静音+提示

use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct AsrBenchmarkResult {
    pub text: String,
    pub elapsed_ms: u64,
    pub audio_duration_sec: f64,
    pub model_id: String,
    pub rtf: f64, // Real-Time Factor: elapsed / audio_duration (越小越快)
}

/// 运行 ASR 速度测试（Tauri command）
/// 使用内置的中文测试音频或用户提供的音频
#[tauri::command]
pub async fn run_asr_benchmark(
    app_handle: tauri::AppHandle,
    model_id: String,
    language: Option<String>,
    audio_b64: Option<String>,
) -> Result<AsrBenchmarkResult, String> {
    let pcm_bytes = if let Some(b64) = audio_b64 {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64)
            .map_err(|e| format!("base64 解码失败: {}", e))?
    } else {
        // 读取内置测试音频（WAV 格式，需要跳过 44 字节 header 提取 PCM）
        let resource_path = app_handle.path()
            .resolve("resources/test_zh.wav", tauri::path::BaseDirectory::Resource)
            .map_err(|e| format!("找不到测试音频: {}", e))?;
        let wav_bytes = std::fs::read(&resource_path)
            .map_err(|e| format!("读取测试音频失败: {}", e))?;
        // 跳过 WAV header（44 字节）
        if wav_bytes.len() > 44 {
            wav_bytes[44..].to_vec()
        } else {
            return Err("测试音频文件无效".into());
        }
    };

    let audio_duration_sec = (pcm_bytes.len() as f64) / 2.0 / 16000.0;

    let samples: Vec<f32> = pcm_bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();

    let lang = language.unwrap_or_else(|| "auto".into());

    tokio::task::spawn_blocking(move || {
        super::local_asr::ensure_loaded_pub(&model_id, &lang)?;

        let start = std::time::Instant::now();
        let mut cache = super::local_asr::get_cache_lock()?;
        let entry = cache.as_mut().ok_or("模型未加载")?;

        let text = entry.transcribe(16000, &samples);
        let elapsed_ms = start.elapsed().as_millis() as u64;
        let rtf = if audio_duration_sec > 0.0 {
            (elapsed_ms as f64 / 1000.0) / audio_duration_sec
        } else {
            0.0
        };

        Ok(AsrBenchmarkResult {
            text,
            elapsed_ms,
            audio_duration_sec,
            model_id,
            rtf,
        })
    })
    .await
    .map_err(|e| format!("测试异常: {}", e))?
}

/// 获取内置测试音频的 base64 WAV 数据（供前端播放）
#[tauri::command]
pub async fn get_test_audio_b64(app_handle: tauri::AppHandle) -> Result<String, String> {
    let resource_path = app_handle.path()
        .resolve("resources/test_zh.wav", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("找不到测试音频: {}", e))?;
    let wav_bytes = std::fs::read(&resource_path)
        .map_err(|e| format!("读取测试音频失败: {}", e))?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_bytes))
}
