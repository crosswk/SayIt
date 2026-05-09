// 模型管理 Tauri commands

use super::catalog::{self, LocalModelInfo, ModelInfo};
use super::downloader;
use tauri::AppHandle;

/// 列出所有可用模型
#[tauri::command]
pub fn list_available_models() -> Vec<ModelInfo> {
    catalog::get_available_models()
}

/// 列出已下载的本地模型
#[tauri::command]
pub fn list_downloaded_models() -> Vec<LocalModelInfo> {
    let models_root = downloader::models_dir();
    if !models_root.exists() {
        return vec![];
    }

    let catalog = catalog::get_available_models();
    let mut result = vec![];

    for model in &catalog {
        let model_path = downloader::model_dir(&model.id);
        if !model_path.exists() {
            continue;
        }

        // 检查所有文件是否都已下载
        let mut complete = true;
        let mut actual_size: u64 = 0;

        if model.archive_url.is_some() {
            // archive 模型：检查目录中的 onnx 文件
            if model_path.exists() {
                for entry in std::fs::read_dir(&model_path).into_iter().flatten() {
                    if let Ok(entry) = entry {
                        let path = entry.path();
                        if path.is_file() {
                            actual_size += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        } else if path.is_dir() {
                            // 递归计算子目录大小（如 Qwen3-0.6B/）
                            for sub in std::fs::read_dir(&path).into_iter().flatten().flatten() {
                                if sub.path().is_file() {
                                    actual_size += std::fs::metadata(sub.path()).map(|m| m.len()).unwrap_or(0);
                                }
                            }
                        }
                    }
                }
                // 检查关键文件是否存在
                if model.model_type == "funasr-nano" {
                    complete = model_path.join("encoder_adaptor.int8.onnx").exists()
                        && model_path.join("llm.int8.onnx").exists()
                        && model_path.join("embedding.int8.onnx").exists()
                        && model_path.join("Qwen3-0.6B").exists();
                } else if model.model_type == "fire-red-ctc" {
                    complete = model_path.join("model.int8.onnx").exists()
                        && model_path.join("tokens.txt").exists();
                } else if model.model_type == "fire-red-aed" {
                    complete = model_path.join("encoder.int8.onnx").exists()
                        && model_path.join("decoder.int8.onnx").exists()
                        && model_path.join("tokens.txt").exists();
                }
            }
        } else {
            for source in &model.sources {
                for file in &source.files {
                    let file_path = model_path.join(&file.name);
                    if file_path.exists() {
                        actual_size += std::fs::metadata(&file_path)
                            .map(|m| m.len())
                            .unwrap_or(0);
                    } else {
                        complete = false;
                    }
                }
                break; // 只检查第一个 source
            }
        }

        if actual_size > 0 {
            result.push(LocalModelInfo {
                id: model.id.clone(),
                name: model.name.clone(),
                model_type: model.model_type.clone(),
                total_size_bytes: actual_size,
                path: model_path.to_string_lossy().to_string(),
                complete,
            });
        }
    }

    result
}

/// 下载模型
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    model_id: String,
    source: String,
) -> Result<(), String> {
    let catalog = catalog::get_available_models();
    let model = catalog
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("未知模型: {}", model_id))?;

    let dest_dir = downloader::model_dir(&model_id);

    // 如果模型有 archive_url，使用 tar.bz2 下载+解压
    if let Some(ref archive_url) = model.archive_url {
        downloader::download_and_extract_tar_bz2(
            app.clone(),
            &model_id,
            archive_url,
        )
        .await?;
    } else {
        let download_source = model
            .sources
            .iter()
            .find(|s| s.source == source)
            .or_else(|| model.sources.first())
            .ok_or_else(|| format!("模型 {} 没有可用的下载源", model_id))?;

        let file_count = download_source.files.len() as u32;
        for (i, file) in download_source.files.iter().enumerate() {
            downloader::download_file(
                app.clone(),
                &model_id,
                &file.name,
                &file.url,
                file.size_bytes,
                &dest_dir,
                (i + 1) as u32,
                file_count,
            )
            .await?;
        }
    }

    // 写入 meta.json
    let meta = serde_json::json!({
        "id": model.id,
        "name": model.name,
        "model_type": model.model_type,
        "source": if model.archive_url.is_some() { "archive" } else { &source },
        "downloaded_at": chrono::Utc::now().to_rfc3339(),
    });
    let meta_path = dest_dir.join("meta.json");
    std::fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default())
        .map_err(|e| format!("写入 meta.json 失败: {}", e))?;

    Ok(())
}

/// 删除已下载的模型
#[tauri::command]
pub fn delete_model(model_id: String) -> Result<(), String> {
    let model_path = downloader::model_dir(&model_id);
    if model_path.exists() {
        std::fs::remove_dir_all(&model_path)
            .map_err(|e| format!("删除模型失败: {}", e))?;
        log::info!("Deleted model: {}", model_id);
    }
    Ok(())
}

/// 打开模型存储目录
#[tauri::command]
pub fn open_models_folder() -> Result<String, String> {
    let dir = downloader::models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let path = dir.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    }
    Ok(path)
}

/// 打开指定模型的存储目录（不存在则创建）
#[tauri::command]
pub fn open_model_folder(model_id: String) -> Result<String, String> {
    let dir = downloader::model_dir(&model_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let path = dir.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    }
    Ok(path)
}
