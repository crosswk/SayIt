// 模型下载器 — 支持断点续传和进度事件

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub file_name: String,
    /// 当前文件已下载字节
    pub downloaded_bytes: u64,
    /// 当前文件总字节（从 Content-Length 获取，0 表示未知）
    pub total_bytes: u64,
    /// 整体进度百分比（跨所有文件）
    pub percent: f64,
    /// 当前文件索引（从 1 开始）
    pub file_index: u32,
    /// 总文件数
    pub file_count: u32,
    pub status: String,
    pub error: Option<String>,
}

/// 获取模型存储根目录
pub fn models_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.sayit.app")
        .join("models")
}

/// 获取指定模型的目录
pub fn model_dir(model_id: &str) -> PathBuf {
    models_dir().join(model_id)
}

/// 构建带 User-Agent 的 HTTP 客户端（魔搭等平台要求）
fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("SayIt/1.0")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

/// 下载单个文件，支持进度回调
pub async fn download_file(
    app: AppHandle,
    model_id: &str,
    file_name: &str,
    url: &str,
    expected_size: u64,
    dest_dir: &Path,
    file_index: u32,
    file_count: u32,
) -> Result<(), String> {
    let dest_path = dest_dir.join(file_name);
    let temp_path = dest_dir.join(format!("{}.part", file_name));

    // 确保目录存在
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    // 检查是否已有部分下载（断点续传）
    let mut downloaded: u64 = 0;
    if temp_path.exists() {
        downloaded = std::fs::metadata(&temp_path)
            .map(|m| m.len())
            .unwrap_or(0);
    }

    // 如果已完成下载
    if dest_path.exists() {
        let size = std::fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
        if expected_size == 0 || size == expected_size || size > 0 {
            emit_progress(&app, model_id, file_name, size, size, "completed", None, file_index, file_count);
            return Ok(());
        }
    }

    let client = build_http_client()?;
    let mut request = client.get(url);

    // 断点续传：设置 Range header
    if downloaded > 0 {
        request = request.header("Range", format!("bytes={}-", downloaded));
        log::info!(
            "Resuming download {} from {} bytes",
            file_name,
            downloaded
        );
    }

    emit_progress(
        &app,
        model_id,
        file_name,
        downloaded,
        expected_size,
        "downloading",
        None,
        file_index,
        file_count,
    );

    let resp = request
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;

    if !resp.status().is_success() && resp.status().as_u16() != 206 {
        let msg = format!("下载失败 HTTP {}", resp.status());
        emit_progress(&app, model_id, file_name, downloaded, expected_size, "failed", Some(&msg), file_index, file_count);
        return Err(msg);
    }

    // 获取实际总大小
    let content_length = resp.content_length().unwrap_or(0);
    let total = if expected_size > 0 {
        expected_size
    } else {
        downloaded + content_length
    };

    // 打开文件（追加模式）
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&temp_path)
        .map_err(|e| format!("打开文件失败: {}", e))?;

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;

    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;

        // 每 200ms 发送一次进度
        if last_emit.elapsed().as_millis() >= 200 {
            emit_progress(&app, model_id, file_name, downloaded, total, "downloading", None, file_index, file_count);
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().map_err(|e| format!("flush 失败: {}", e))?;
    drop(file);

    // 下载完成，重命名 .part → 最终文件名
    std::fs::rename(&temp_path, &dest_path)
        .map_err(|e| format!("重命名文件失败: {}", e))?;

    emit_progress(&app, model_id, file_name, downloaded, total, "completed", None, file_index, file_count);
    log::info!("Download completed: {} ({} bytes)", file_name, downloaded);

    Ok(())
}

fn emit_progress(
    app: &AppHandle,
    model_id: &str,
    file_name: &str,
    downloaded: u64,
    total: u64,
    status: &str,
    error: Option<&str>,
    file_index: u32,
    file_count: u32,
) {
    let percent = if total > 0 {
        (downloaded as f64 / total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };

    let _ = app.emit(
        "model-download-progress",
        DownloadProgress {
            model_id: model_id.to_string(),
            file_name: file_name.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            percent,
            file_index,
            file_count,
            status: status.to_string(),
            error: error.map(String::from),
        },
    );
}

/// 下载 tar.bz2 压缩包并解压到模型目录
/// 解压时会跳过顶层目录（如 sherpa-onnx-funasr-nano-int8-2025-12-30/）
/// 并跳过 test_wavs/ 目录和 README.md
pub async fn download_and_extract_tar_bz2(
    app: AppHandle,
    model_id: &str,
    url: &str,
) -> Result<(), String> {
    let dest_dir = model_dir(model_id);
    let archive_path = dest_dir.with_extension("tar.bz2");
    let temp_path = dest_dir.with_extension("tar.bz2.part");

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    // 下载压缩包（支持断点续传）
    let mut downloaded: u64 = 0;
    if temp_path.exists() {
        downloaded = std::fs::metadata(&temp_path)
            .map(|m| m.len())
            .unwrap_or(0);
    }

    // 如果已经解压过（目录中有 onnx 文件），跳过下载
    if dest_dir.join("encoder_adaptor.int8.onnx").exists()
        || dest_dir.join("model.int8.onnx").exists()
    {
        emit_progress(&app, model_id, "archive", 1, 1, "completed", None, 1, 1);
        return Ok(());
    }

    let client = build_http_client()?;
    let mut request = client.get(url);
    if downloaded > 0 {
        request = request.header("Range", format!("bytes={}-", downloaded));
        log::info!("Resuming archive download from {} bytes", downloaded);
    }

    emit_progress(&app, model_id, "archive", downloaded, 0, "downloading", None, 1, 1);

    let resp = request.send().await
        .map_err(|e| format!("下载请求失败: {}", e))?;

    if !resp.status().is_success() && resp.status().as_u16() != 206 {
        let msg = format!("下载失败 HTTP {}", resp.status());
        emit_progress(&app, model_id, "archive", 0, 0, "failed", Some(&msg), 1, 1);
        return Err(msg);
    }

    let content_length = resp.content_length().unwrap_or(0);
    let total = downloaded + content_length;

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&temp_path)
        .map_err(|e| format!("打开文件失败: {}", e))?;

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {}", e))?;
        file.write_all(&chunk).map_err(|e| format!("写入失败: {}", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 300 {
            emit_progress(&app, model_id, "archive", downloaded, total, "downloading", None, 1, 1);
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().map_err(|e| format!("flush 失败: {}", e))?;
    drop(file);

    std::fs::rename(&temp_path, &archive_path)
        .map_err(|e| format!("重命名失败: {}", e))?;

    log::info!("Archive downloaded: {} ({} bytes)", model_id, downloaded);
    emit_progress(&app, model_id, "extracting", 0, 0, "downloading", None, 1, 1);

    // 解压 tar.bz2
    let archive_file = std::fs::File::open(&archive_path)
        .map_err(|e| format!("打开压缩包失败: {}", e))?;
    let bz_decoder = bzip2::read::BzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(bz_decoder);

    for entry in archive.entries().map_err(|e| format!("读取压缩包失败: {}", e))? {
        let mut entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path().map_err(|e| format!("读取路径失败: {}", e))?;
        let path_str = path.to_string_lossy().to_string();

        // 跳过 test_wavs/ 和 README.md
        if path_str.contains("test_wavs/") || path_str.ends_with("README.md") {
            continue;
        }

        // 去掉顶层目录（如 sherpa-onnx-funasr-nano-int8-2025-12-30/）
        let components: Vec<_> = path.components().collect();
        if components.len() <= 1 {
            continue; // 跳过顶层目录本身
        }
        let relative: std::path::PathBuf = components[1..].iter().collect();
        let dest = dest_dir.join(&relative);

        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&dest).ok();
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| format!("创建文件失败 {:?}: {}", relative, e))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("解压文件失败 {:?}: {}", relative, e))?;
        }
    }

    // 删除压缩包
    std::fs::remove_file(&archive_path).ok();

    emit_progress(&app, model_id, "archive", total, total, "completed", None, 1, 1);
    log::info!("Archive extracted: {}", model_id);

    Ok(())
}
