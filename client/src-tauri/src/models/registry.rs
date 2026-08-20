// 模型管理 Tauri commands

use super::catalog::{self, LocalModelInfo, ModelInfo};
use super::downloader;
use crate::storage::Storage;
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

use crate::error_protocol;

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
                } else if model.model_type == "qwen3-asr" {
                    complete = model_path.join("conv_frontend.onnx").exists()
                        && model_path.join("encoder.int8.onnx").exists()
                        && model_path.join("decoder.int8.onnx").exists()
                        && model_path.join("tokenizer").exists();
                } else if model.model_type == "paraformer" {
                    complete = model_path.join("model.int8.onnx").exists()
                        && model_path.join("tokens.txt").exists();
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
        .ok_or_else(|| error_protocol::encode("download_failed", format!("Unknown model: {}", model_id)))?;

    let dest_dir = downloader::model_dir(&model_id);
    let _download_lease = downloader::acquire_model_path(&dest_dir)?;

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
            .ok_or_else(|| error_protocol::encode("download_network", format!("Model {} has no available download source", model_id)))?;

        let file_count = download_source.files.len() as u32;
        for (i, file) in download_source.files.iter().enumerate() {
            downloader::download_file(
                app.clone(),
                &model_id,
                &file.name,
                &file.url,
                file.size_bytes,
                file.sha256.as_deref(),
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
        .map_err(|e| error_protocol::encode("download_failed", format!("Failed to write meta.json: {}", e)))?;

    Ok(())
}

/// 删除已下载的模型
#[tauri::command]
pub fn delete_model(model_id: String) -> Result<(), String> {
    let model_path = downloader::model_dir(&model_id);
    let _delete_lease = downloader::acquire_model_path(&model_path)?;
    if model_path.exists() {
        std::fs::remove_dir_all(&model_path)
            .map_err(|e| format!("Failed to delete model: {}", e))?;
        log::info!("Deleted model: {}", model_id);
    }
    Ok(())
}

/// 打开模型存储目录
#[tauri::command]
pub fn open_models_folder() -> Result<String, String> {
    let dir = downloader::models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create directory: {}", e))?;
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

/// 模型存储位置信息（供设置页展示）
#[derive(Debug, Clone, Serialize)]
pub struct ModelsDirInfo {
    /// 当前生效的模型根目录
    pub current: String,
    /// 默认模型根目录
    pub default_dir: String,
    /// 当前是否为用户自定义（非默认）
    pub is_custom: bool,
}

/// 查询当前模型存储位置
#[tauri::command]
pub fn get_models_dir() -> ModelsDirInfo {
    let current = downloader::models_dir();
    let default_dir = downloader::default_models_dir();
    ModelsDirInfo {
        is_custom: current != default_dir,
        current: current.to_string_lossy().to_string(),
        default_dir: default_dir.to_string_lossy().to_string(),
    }
}

/// 递归复制目录/文件（跨盘 rename 失败时的兜底）。
fn copy_path_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| format!("Failed to create directory: {}", e))?;
        for entry in std::fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            copy_path_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(src, dst).map_err(|e| format!("Failed to copy file: {}", e))?;
    }
    Ok(())
}

/// 把旧模型根目录下的每个条目移动到新根目录。
/// 优先 rename（同盘瞬时）；跨盘失败则递归复制后删除源。
/// 目标已存在同名条目则跳过（不覆盖新目录已有内容）。
fn move_dir_contents(from: &Path, to: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(from).map_err(|e| format!("Failed to read old directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if dst.exists() {
            continue;
        }
        if std::fs::rename(&src, &dst).is_ok() {
            continue;
        }
        // 跨盘：递归复制后删除源
        copy_path_recursive(&src, &dst)?;
        if src.is_dir() {
            let _ = std::fs::remove_dir_all(&src);
        } else {
            let _ = std::fs::remove_file(&src);
        }
    }
    Ok(())
}

/// 设置模型存储位置。
/// - `dir`：新目录（绝对路径）；传 None 或空串 = 恢复默认路径。
/// - `move_existing`：为 true 时把旧目录下已下载的模型一并移动到新目录。
///
/// 会校验新目录可创建且可写；随后更新进程内生效路径并持久化到设置，
/// 使重启后仍生效（main.rs 启动时会读取 `localAsr.modelsDir`）。
#[tauri::command]
pub async fn set_models_dir(
    storage: tauri::State<'_, Storage>,
    dir: Option<String>,
    move_existing: bool,
) -> Result<String, String> {
    let trimmed = dir
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let old_dir = downloader::models_dir();
    let new_dir = match &trimmed {
        Some(d) => std::path::PathBuf::from(d),
        None => downloader::default_models_dir(),
    };

    // 迁移、切换生效路径和持久化必须作为一个整体与下载/删除互斥。
    let _storage_lease = if new_dir != old_dir {
        Some(downloader::acquire_model_storage()?)
    } else {
        None
    };

    // 目标与当前一致：仅确保持久化的设置与之同步，不做迁移。
    if new_dir != old_dir {
        let old_for_task = old_dir.clone();
        let new_for_task = new_dir.clone();
        // fs 操作（可能是跨盘大文件复制）放到阻塞线程池，避免占用异步运行时线程。
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            std::fs::create_dir_all(&new_for_task)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
            // 可写性探测
            let probe = new_for_task.join(".sayit_write_test");
            std::fs::write(&probe, b"ok").map_err(|e| format!("Directory is not writable: {}", e))?;
            let _ = std::fs::remove_file(&probe);
            if move_existing && old_for_task.exists() {
                move_dir_contents(&old_for_task, &new_for_task)?;
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("Model migration task failed: {}", e))??;
    }

    // 更新进程内生效路径：自定义 → Some，恢复默认 → None
    downloader::set_custom_models_dir(trimmed.as_ref().map(|_| new_dir.clone()));

    // 持久化（重启后由 main.rs 读回）。恢复默认时存空串。
    let value = match &trimmed {
        Some(d) => serde_json::json!(d),
        None => serde_json::json!(""),
    };
    storage
        .set("localAsr.modelsDir", &value)
        .map_err(|e| format!("Failed to save setting: {}", e))?;

    Ok(new_dir.to_string_lossy().to_string())
}

/// 打开指定模型的存储目录（不存在则创建）
#[tauri::command]
pub fn open_model_folder(model_id: String) -> Result<String, String> {
    let dir = downloader::model_dir(&model_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create directory: {}", e))?;
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
