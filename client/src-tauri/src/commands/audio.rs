use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use std::path::PathBuf;

fn audio_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.sayit.app").join("audio")
}

#[tauri::command]
pub fn save_audio_file(id: String, wav_base64: String) -> Result<String, String> {
    let dir = audio_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let bytes = STANDARD.decode(&wav_base64).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.wav", id));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

/// 接收 PCM Int16 LE 原始数据（base64），在 Rust 侧编码 WAV header 并写入文件。
/// 避免前端拼 WAV + base64 编码的开销。
#[tauri::command]
pub fn save_pcm_as_wav(id: String, pcm_base64: String, sample_rate: Option<u32>) -> Result<String, String> {
    let dir = audio_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let pcm = STANDARD.decode(&pcm_base64).map_err(|e| e.to_string())?;
    let sr = sample_rate.unwrap_or(16000);
    let data_len = pcm.len() as u32;

    // Build 44-byte WAV header + PCM data
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());   // chunk size
    wav.extend_from_slice(&1u16.to_le_bytes());    // PCM format
    wav.extend_from_slice(&1u16.to_le_bytes());    // mono
    wav.extend_from_slice(&sr.to_le_bytes());      // sample rate
    wav.extend_from_slice(&(sr * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes());    // block align
    wav.extend_from_slice(&16u16.to_le_bytes());   // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(&pcm);

    let path = dir.join(format!("{}.wav", id));
    fs::write(&path, &wav).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_audio_file(file_path: String) -> Result<Option<String>, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(STANDARD.encode(&bytes)))
}

#[tauri::command]
pub fn delete_audio_file(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
