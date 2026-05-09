// 本地 ASR 推理 — 使用 sherpa-onnx 官方 Rust crate
// 模型加载后缓存在内存中，避免每次推理都重新初始化

use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use sherpa_onnx::{
    OfflineFireRedAsrCtcModelConfig,
    OfflineFireRedAsrModelConfig,
    OfflineFunASRNanoModelConfig,
    OfflineRecognizer,
    OfflineRecognizerConfig,
    OfflineSenseVoiceModelConfig,
    OfflineWhisperModelConfig,
};

use super::downloader::model_dir;

#[derive(Debug, Clone, Serialize)]
pub struct LocalAsrResult {
    pub text: String,
    pub elapsed_ms: u64,
}

pub(crate) struct RecognizerCache {
    model_id: String,
    language: String,
    recognizer: OfflineRecognizer,
}

// sherpa-onnx 的 OfflineRecognizer 内部使用 C 指针，但实际是线程安全的
// （sherpa-onnx C API 文档确认 recognizer 可跨线程使用）
unsafe impl Send for RecognizerCache {}

static CACHE: Mutex<Option<RecognizerCache>> = Mutex::new(None);

fn ensure_loaded(model_id: &str, language: &str) -> Result<(), String> {
    let mut cache = CACHE.lock().map_err(|e| format!("锁获取失败: {}", e))?;

    if let Some(ref c) = *cache {
        if c.model_id == model_id && c.language == language {
            return Ok(());
        }
    }

    let dir = model_dir(model_id);
    if !dir.exists() {
        return Err(format!("模型 \"{}\" 尚未下载", model_id));
    }

    log::info!("Loading ASR model: {}", model_id);
    let start = Instant::now();

    let recognizer = create_recognizer(&dir, model_id, language)?;

    log::info!(
        "ASR model loaded in {}ms: {} (lang={})",
        start.elapsed().as_millis(),
        model_id,
        language
    );
    *cache = Some(RecognizerCache {
        model_id: model_id.to_string(),
        language: language.to_string(),
        recognizer,
    });
    Ok(())
}

/// 根据 model_id 前缀选择模型类型并创建 recognizer
fn create_recognizer(
    dir: &Path,
    model_id: &str,
    language: &str,
) -> Result<OfflineRecognizer, String> {
    if model_id.starts_with("whisper-") {
        create_whisper(dir, model_id, language)
    } else if model_id.starts_with("funasr-nano") {
        create_funasr_nano(dir, language)
    } else if model_id.starts_with("fire-red-asr2-ctc") {
        create_fire_red_ctc(dir)
    } else if model_id.starts_with("fire-red-asr2-aed") {
        create_fire_red_aed(dir)
    } else {
        create_sensevoice(dir, model_id, language)
    }
}

fn create_sensevoice(
    dir: &Path,
    model_id: &str,
    language: &str,
) -> Result<OfflineRecognizer, String> {
    let model_path = dir.join("model.int8.onnx");
    let model_path = if model_path.exists() {
        model_path
    } else {
        let fp32 = dir.join("model.onnx");
        if fp32.exists() { fp32 } else { return Err("模型文件不存在".into()); }
    };
    let tokens_path = dir.join("tokens.txt");
    if !tokens_path.exists() {
        return Err("tokens.txt 不存在".into());
    }

    let use_itn = !model_id.contains("funasr-nano");

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = 4;
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(model_path.to_string_lossy().to_string()),
        language: Some(language.to_string()),
        use_itn,
    };
    config.model_config.tokens = Some(tokens_path.to_string_lossy().to_string());

    OfflineRecognizer::create(&config)
        .ok_or_else(|| "SenseVoice 初始化失败".to_string())
}

fn create_whisper(
    dir: &Path,
    model_id: &str,
    language: &str,
) -> Result<OfflineRecognizer, String> {
    let size = model_id.split('-').last().unwrap_or("small");
    let encoder = dir.join(format!("{}-encoder.int8.onnx", size));
    let decoder = dir.join(format!("{}-decoder.int8.onnx", size));
    let tokens = dir.join(format!("{}-tokens.txt", size));

    if !encoder.exists() || !decoder.exists() {
        return Err(format!(
            "Whisper 模型文件不完整: 需要 {}-encoder/decoder.int8.onnx",
            size
        ));
    }

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = 4;
    config.model_config.whisper = OfflineWhisperModelConfig {
        encoder: Some(encoder.to_string_lossy().to_string()),
        decoder: Some(decoder.to_string_lossy().to_string()),
        language: Some(if language == "auto" { "".into() } else { language.to_string() }),
        ..Default::default()
    };
    config.model_config.tokens = Some(tokens.to_string_lossy().to_string());

    OfflineRecognizer::create(&config)
        .ok_or_else(|| "Whisper 初始化失败".to_string())
}

fn create_funasr_nano(
    dir: &Path,
    language: &str,
) -> Result<OfflineRecognizer, String> {
    let encoder_adaptor = dir.join("encoder_adaptor.int8.onnx");
    let llm = dir.join("llm.int8.onnx");
    let embedding = dir.join("embedding.int8.onnx");
    let tokenizer = dir.join("Qwen3-0.6B");

    if !encoder_adaptor.exists() || !llm.exists() || !embedding.exists() {
        return Err("FunASR Nano 模型文件不完整".into());
    }
    if !tokenizer.exists() {
        return Err("FunASR Nano tokenizer 目录不存在 (Qwen3-0.6B/)".into());
    }

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = 4;
    config.model_config.funasr_nano = OfflineFunASRNanoModelConfig {
        encoder_adaptor: Some(encoder_adaptor.to_string_lossy().to_string()),
        llm: Some(llm.to_string_lossy().to_string()),
        embedding: Some(embedding.to_string_lossy().to_string()),
        tokenizer: Some(tokenizer.to_string_lossy().to_string()),
        language: Some(if language == "auto" { "".into() } else { language.to_string() }),
        max_new_tokens: 200,
        ..Default::default()
    };

    OfflineRecognizer::create(&config)
        .ok_or_else(|| "FunASR Nano 初始化失败".to_string())
}

fn create_fire_red_ctc(dir: &Path) -> Result<OfflineRecognizer, String> {
    let model = dir.join("model.int8.onnx");
    if !model.exists() {
        return Err("FireRedASR2-CTC 模型文件不存在 (model.int8.onnx)".into());
    }
    let tokens = dir.join("tokens.txt");
    if !tokens.exists() {
        return Err("tokens.txt 不存在".into());
    }

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = 4;
    config.model_config.fire_red_asr_ctc = OfflineFireRedAsrCtcModelConfig {
        model: Some(model.to_string_lossy().to_string()),
    };
    config.model_config.tokens = Some(tokens.to_string_lossy().to_string());

    OfflineRecognizer::create(&config)
        .ok_or_else(|| "FireRedASR2-CTC 初始化失败".to_string())
}

fn create_fire_red_aed(dir: &Path) -> Result<OfflineRecognizer, String> {
    let encoder = dir.join("encoder.int8.onnx");
    let decoder = dir.join("decoder.int8.onnx");
    if !encoder.exists() || !decoder.exists() {
        return Err("FireRedASR2-AED 模型文件不完整 (需要 encoder.int8.onnx + decoder.int8.onnx)".into());
    }
    let tokens = dir.join("tokens.txt");
    if !tokens.exists() {
        return Err("tokens.txt 不存在".into());
    }

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = 4;
    config.model_config.fire_red_asr = OfflineFireRedAsrModelConfig {
        encoder: Some(encoder.to_string_lossy().to_string()),
        decoder: Some(decoder.to_string_lossy().to_string()),
    };
    config.model_config.tokens = Some(tokens.to_string_lossy().to_string());

    OfflineRecognizer::create(&config)
        .ok_or_else(|| "FireRedASR2-AED 初始化失败".to_string())
}

/// 使用缓存的 recognizer 进行转录
fn transcribe_with_cache(samples: &[f32]) -> Result<String, String> {
    let cache = CACHE.lock().map_err(|e| format!("锁获取失败: {}", e))?;
    let entry = cache.as_ref().ok_or("模型未加载")?;

    let stream = entry.recognizer.create_stream();
    stream.accept_waveform(16000, samples);
    entry.recognizer.decode(&stream);
    let result = stream
        .get_result()
        .ok_or_else(|| "获取识别结果失败".to_string())?;

    Ok(result.text.trim().to_string())
}

#[tauri::command]
pub async fn preload_local_model(model_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let start = Instant::now();
        ensure_loaded(&model_id, "auto")?;
        Ok(format!("模型已加载 ({}ms)", start.elapsed().as_millis()))
    })
    .await
    .map_err(|e| format!("预加载异常: {}", e))?
}

#[tauri::command]
pub async fn local_transcribe(
    audio_b64: String,
    model_id: String,
    language: Option<String>,
) -> Result<LocalAsrResult, String> {
    let pcm_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &audio_b64,
    )
    .map_err(|e| format!("base64 解码失败: {}", e))?;

    if pcm_bytes.len() < 2 {
        return Ok(LocalAsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let samples: Vec<f32> = pcm_bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();

    tokio::task::spawn_blocking(move || {
        let lang = language.as_deref().unwrap_or("auto");
        ensure_loaded(&model_id, lang)?;

        let start = Instant::now();
        let text = transcribe_with_cache(&samples)?;

        Ok(LocalAsrResult {
            text,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| format!("推理异常: {}", e))?
}

// ── 供 benchmark / test_audio 模块使用的公开接口 ──

pub fn ensure_loaded_pub(model_id: &str, language: &str) -> Result<(), String> {
    ensure_loaded(model_id, language)
}

pub fn get_cache_lock() -> Result<std::sync::MutexGuard<'static, Option<RecognizerCache>>, String> {
    CACHE.lock().map_err(|e| format!("锁获取失败: {}", e))
}

impl RecognizerCache {
    pub fn transcribe(&self, _sample_rate: u32, samples: &[f32]) -> String {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(16000, samples);
        self.recognizer.decode(&stream);
        stream
            .get_result()
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default()
    }
}
