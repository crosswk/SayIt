// 模型下载器 — 支持断点续传和进度事件

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Emitter};

use crate::error_protocol;

fn download_error(code: &str, detail: impl AsRef<str>) -> String {
    error_protocol::encode(code, detail)
}

fn download_io_error(context: &str, error: std::io::Error) -> String {
    let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
        "download_permission"
    } else if matches!(error.raw_os_error(), Some(28 | 112)) {
        // ENOSPC on Unix and ERROR_DISK_FULL on Windows.
        "download_no_space"
    } else {
        "download_failed"
    };
    download_error(code, format!("{}: {}", context, error))
}

/// 精确判断错误是否为 checksum 不匹配（Fail-Closed 设计）
fn is_checksum_error(err_msg: &str) -> bool {
    err_msg.starts_with("sayit_error:download_checksum:")
}

/// 统一安全删除文件（文件不存在视为成功，其他 I/O 或权限错误显式返回）
fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(download_io_error("Failed to remove temporary/corrupted file", e));
        }
    }
    Ok(())
}

/// 校验落地文件的 SHA-256 哈希值
fn verify_file_sha256(file_path: &Path, expected_sha256: &str) -> Result<(), String> {
    use std::io::Read;
    let mut file = std::fs::File::open(file_path)
        .map_err(|e| download_io_error("Failed to open file for SHA-256 verification", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| download_io_error("Failed to read file during SHA-256 verification", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    let actual_hash = format!("{:x}", hasher.finalize());
    let expected_lower = expected_sha256.to_ascii_lowercase();

    if actual_hash != expected_lower {
        return Err(download_error(
            "download_checksum",
            format!(
                "SHA-256 verification failed: expected {}, got {}",
                expected_lower, actual_hash
            ),
        ));
    }

    Ok(())
}

/// 校验临时文件；仅明确哈希不匹配时删除，I/O 错误保留现场。
fn verify_temp_file_sha256(file_path: &Path, expected_sha256: &str) -> Result<(), String> {
    match verify_file_sha256(file_path, expected_sha256) {
        Ok(()) => Ok(()),
        Err(e) if is_checksum_error(&e) => {
            remove_file_if_exists(file_path)?;
            Err(e)
        }
        Err(e) => Err(e),
    }
}


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
            model_id: model_id.into(),
            file_name: file_name.into(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            percent,
            file_index,
            file_count,
            status: status.into(),
            error: error.map(Into::into),
        },
    );
}

/// 用户自定义的模型存储根目录（进程级）。None = 用默认路径。
/// 启动时由 main.rs 从设置 `localAsr.modelsDir` 灌入；用户在设置里更改时同步更新。
/// 所有取模型路径的地方都走 `models_dir()`，改这一处即全链路生效。
static CUSTOM_MODELS_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

/// 默认模型存储根目录（未自定义时使用）。
pub fn default_models_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.sayit.app")
        .join("models")
}

/// 设置/清除自定义模型根目录。传 None 恢复默认。
pub fn set_custom_models_dir(dir: Option<PathBuf>) {
    if let Ok(mut guard) = CUSTOM_MODELS_DIR.write() {
        *guard = dir;
    }
}

/// 获取模型存储根目录：优先自定义路径，否则默认路径。
pub fn models_dir() -> PathBuf {
    if let Ok(guard) = CUSTOM_MODELS_DIR.read() {
        if let Some(ref dir) = *guard {
            return dir.clone();
        }
    }
    default_models_dir()
}

/// 获取指定模型的目录
pub fn model_dir(model_id: &str) -> PathBuf {
    models_dir().join(model_id)
}

use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use futures_util::stream::{FuturesUnordered, StreamExt};

/// 构建带 User-Agent 与高性能 TCP/连接池配置的 HTTP 客户端
fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("SayIt/1.0")
        .tcp_nodelay(true)
        .pool_max_idle_per_host(16)
        .build()
        .map_err(|e| download_error("download_network", format!("Failed to create HTTP client: {}", e)))
}

/// 探测 URL 是否支持 Range 请求并获取文件大小
async fn probe_url(client: &reqwest::Client, url: &str) -> (u64, bool) {
    let resp = match client.get(url).header("Range", "bytes=0-0").send().await {
        Ok(r) => r,
        Err(_) => return (0, false),
    };

    // 只有当服务端明确返回 206 Partial Content 并解析出有效 total 时，才确认支持 Range。
    // 如果返回 200 OK，即便头里带了 Accept-Ranges 也一律判定为不支持 Range，防止伪支持导致并发写错。
    if resp.status().as_u16() == 206 {
        if let Some(cr) = resp.headers().get("Content-Range").and_then(|v| v.to_str().ok()) {
            if let Some(total_str) = cr.rsplit('/').next() {
                if let Ok(total) = total_str.trim().parse::<u64>() {
                    if total > 0 {
                        return (total, true);
                    }
                }
            }
        }
    }

    let total = resp.content_length().unwrap_or(0);
    (total, false)
}

/// 纯函数校验 Range 响应头（支持零依赖单元测试与生产复用）
fn validate_range_response_parts(
    status: u16,
    content_range_str: Option<&str>,
    content_length: Option<u64>,
    expected_start: u64,
    expected_end: u64,
    expected_total: u64,
) -> Result<(), String> {
    // 1. 严格要求 206 Partial Content，防范 200 OK 误把全量流当分片写入
    if status != 206 {
        return Err(download_error(
            "download_network",
            format!(
                "Server did not return 206 Partial Content (got HTTP {}). Range requests are not supported.",
                status
            ),
        ));
    }

    // 2. 校验 Content-Range 响应头（格式: bytes <start>-<end>/<total>）
    let cr_header = content_range_str.ok_or_else(|| {
        download_error(
            "download_network",
            "Missing Content-Range header in 206 Partial Content response",
        )
    })?;

    let (range_bounds, total_part) = cr_header
        .trim()
        .strip_prefix("bytes ")
        .and_then(|value| value.split_once('/'))
        .ok_or_else(|| download_error("download_network", format!("Invalid Content-Range: {}", cr_header)))?;
    let (start_part, end_part) = range_bounds
        .split_once('-')
        .ok_or_else(|| download_error("download_network", format!("Invalid Content-Range bounds: {}", cr_header)))?;

    let resp_start: u64 = start_part
        .parse()
        .map_err(|_| download_error("download_network", format!("Invalid start byte in Content-Range: {}", cr_header)))?;
    let resp_end: u64 = end_part
        .parse()
        .map_err(|_| download_error("download_network", format!("Invalid end byte in Content-Range: {}", cr_header)))?;
    let resp_total: u64 = total_part
        .parse()
        .map_err(|_| download_error("download_network", format!("Invalid total size in Content-Range: {}", cr_header)))?;

    if resp_start != expected_start || resp_end != expected_end {
        return Err(download_error(
            "download_network",
            format!(
                "Content-Range mismatch: expected bytes {}-{}, but server returned bytes {}-{}",
                expected_start, expected_end, resp_start, resp_end
            ),
        ));
    }

    if resp_total != expected_total {
        return Err(download_error(
            "download_network",
            format!(
                "Total size in Content-Range mismatch: expected {}, but server reported {}",
                expected_total, resp_total
            ),
        ));
    }

    // 3. 校验 Content-Length 与请求区间长度完全匹配
    let expected_len = expected_end - expected_start + 1;
    if let Some(content_len) = content_length {
        if content_len != expected_len {
            return Err(download_error(
                "download_network",
                format!(
                    "Content-Length mismatch: expected {} bytes for range, got {}",
                    expected_len, content_len
                ),
            ));
        }
    }

    Ok(())
}

/// 严格验证 HTTP 206 响应的 Content-Range 和 Content-Length 是否与期望的 Range 完全吻合
fn validate_chunk_response(
    resp: &reqwest::Response,
    expected_start: u64,
    expected_end: u64,
    expected_total: u64,
) -> Result<(), String> {
    let cr_str = resp.headers().get("Content-Range").and_then(|v| v.to_str().ok());
    validate_range_response_parts(
        resp.status().as_u16(),
        cr_str,
        resp.content_length(),
        expected_start,
        expected_end,
        expected_total,
    )
}

struct ChunkSpec {
    index: usize,
    start: u64,
    end: u64,
}

/// 单个分片的并发下载工作函数（支持严格 206 校验、独立重试与零锁定位写入）
async fn download_chunk(
    client: reqwest::Client,
    url: String,
    temp_path: PathBuf,
    chunk: ChunkSpec,
    total_file_size: u64,
    downloaded_total: Arc<AtomicU64>,
) -> Result<(), String> {
    let mut downloaded_in_chunk = 0u64;
    let chunk_total = chunk.end - chunk.start + 1;
    let max_retries = 3;

    for attempt in 1..=max_retries {
        let current_start = chunk.start + downloaded_in_chunk;
        if current_start > chunk.end {
            return Ok(());
        }

        let range_header = format!("bytes={}-{}", current_start, chunk.end);
        let resp_res = client.get(&url).header("Range", range_header).send().await;

        let resp = match resp_res {
            Ok(r) => r,
            Err(e) => {
                if attempt == max_retries {
                    return Err(download_error(
                        "download_network",
                        format!("Chunk {} failed after {} retries: {}", chunk.index, max_retries, e),
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
                continue;
            }
        };

        // 严格校验响应头（拒绝 200，只收严格匹配的 206 Partial Content）
        if let Err(e) = validate_chunk_response(&resp, current_start, chunk.end, total_file_size) {
            log::warn!("Chunk {} validation failed on attempt {}: {}", chunk.index, attempt, e);
            if attempt == max_retries {
                return Err(e);
            }
            tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
            continue;
        }

        let mut file = match std::fs::OpenOptions::new().write(true).open(&temp_path) {
            Ok(f) => f,
            Err(e) => return Err(download_io_error("Failed to open temp file for chunk", e)),
        };

        if let Err(e) = file.seek(SeekFrom::Start(current_start)) {
            return Err(download_io_error("Failed to seek temp file", e));
        }

        let mut stream = resp.bytes_stream();
        let mut failed = false;

        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    let len = bytes.len() as u64;
                    // 防止写入超出分片边界
                    if downloaded_in_chunk + len > chunk_total {
                        log::error!(
                            "Chunk {} received overflow data (expected max {} bytes, got +{})",
                            chunk.index,
                            chunk_total,
                            len
                        );
                        failed = true;
                        break;
                    }

                    if let Err(e) = file.write_all(&bytes) {
                        return Err(download_io_error("Failed to write chunk data", e));
                    }
                    downloaded_in_chunk += len;
                    downloaded_total.fetch_add(len, Ordering::Relaxed);
                }
                Err(e) => {
                    log::warn!(
                        "Chunk {} stream interrupted: {}, retrying (attempt {})",
                        chunk.index,
                        e,
                        attempt
                    );
                    failed = true;
                    break;
                }
            }
        }

        file.flush()
            .map_err(|e| download_io_error("Failed to flush chunk data", e))?;

        if !failed && downloaded_in_chunk == chunk_total {
            return Ok(());
        }

        tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
    }

    if downloaded_in_chunk != chunk_total {
        return Err(download_error(
            "download_network",
            format!(
                "Chunk {} incomplete (expected {} bytes, got {})",
                chunk.index, chunk_total, downloaded_in_chunk
            ),
        ));
    }

    Ok(())
}

/// 根据总大小计算合理的分片规划
fn calculate_chunks(total_size: u64) -> Vec<ChunkSpec> {
    if total_size == 0 {
        return vec![];
    }
    let num_chunks = (total_size / (32 * 1024 * 1024)).clamp(4, 16) as usize;
    let chunk_size = (total_size + num_chunks as u64 - 1) / (num_chunks as u64);

    let mut chunks = Vec::with_capacity(num_chunks);
    for i in 0..num_chunks {
        let start = i as u64 * chunk_size;
        if start >= total_size {
            break;
        }
        let end = ((i as u64 + 1) * chunk_size - 1).min(total_size - 1);
        chunks.push(ChunkSpec { index: i, start, end });
    }
    chunks
}

/// 并发多分片高速下载（突破 CDN 单连接限速，使用独立 .par.part 隔离临时文件）
async fn download_file_parallel(
    app: &AppHandle,
    model_id: &str,
    file_name: &str,
    url: &str,
    total_size: u64,
    expected_sha256: Option<&str>,
    temp_path: &Path,
    dest_path: &Path,
    file_index: u32,
    file_count: u32,
) -> Result<(), String> {
    // 1. 预分配文件大小（避免碎片化）
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(temp_path)
        .map_err(|e| download_io_error("Failed to preallocate temp file", e))?;
    file.set_len(total_size)
        .map_err(|e| download_io_error("Failed to set file length", e))?;
    drop(file);

    // 2. 切分分片（8~16 并发分块）
    let chunks = calculate_chunks(total_size);
    let chunk_count = chunks.len();
    let completed_chunks = Arc::new(
        (0..chunk_count)
            .map(|_| std::sync::atomic::AtomicBool::new(false))
            .collect::<Vec<_>>(),
    );

    let client = build_http_client()?;
    let downloaded_total = Arc::new(AtomicU64::new(0));

    // 3. 启动并发分片任务
    let mut futures = FuturesUnordered::new();
    for chunk in chunks {
        let client_clone = client.clone();
        let url_str = url.to_string();
        let path_buf = temp_path.to_path_buf();
        let total_counter = Arc::clone(&downloaded_total);
        let completed_flag = Arc::clone(&completed_chunks);
        let chunk_idx = chunk.index;
        futures.push(async move {
            let res = download_chunk(
                client_clone,
                url_str,
                path_buf,
                chunk,
                total_size,
                total_counter,
            )
            .await;
            if res.is_ok() {
                completed_flag[chunk_idx].store(true, Ordering::SeqCst);
            }
            res
        });
    }

    emit_progress(app, model_id, file_name, 0, total_size, "downloading", None, file_index, file_count);

    // 4. 定时发射进度事件（150ms 节流）
    let mut progress_interval = tokio::time::interval(std::time::Duration::from_millis(150));
    let mut completed_tasks = 0;
    let total_tasks = futures.len();

    loop {
        tokio::select! {
            _ = progress_interval.tick() => {
                let current = downloaded_total.load(Ordering::Relaxed);
                emit_progress(app, model_id, file_name, current, total_size, "downloading", None, file_index, file_count);
            }
            res = futures.next() => {
                match res {
                    Some(Ok(())) => {
                        completed_tasks += 1;
                        if completed_tasks >= total_tasks {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        remove_file_if_exists(temp_path)?;
                        return Err(e);
                    }
                    None => break,
                }
            }
        }
    }

    // 5. 校验所有分片完成状态与总写入字节数（完整性证明闭环）
    let all_completed = completed_chunks.iter().all(|b| b.load(Ordering::SeqCst));
    let final_downloaded = downloaded_total.load(Ordering::SeqCst);

    if !all_completed || final_downloaded != total_size {
        remove_file_if_exists(temp_path)?;
        let err = download_error(
            "download_parallel_verify_failed",
            format!(
                "Parallel download verification failed: all_chunks_ok={}, bytes={}/{}",
                all_completed, final_downloaded, total_size
            ),
        );
        return Err(err);
    }

    // 6. 如果提供了 SHA-256 校验和，在 rename 之前严格校验
    if let Some(expected_hash) = expected_sha256 {
        if let Err(e) = verify_temp_file_sha256(temp_path, expected_hash) {
            emit_progress(app, model_id, file_name, final_downloaded, total_size, "failed", Some(&e), file_index, file_count);
            return Err(e);
        }
    }

    std::fs::rename(temp_path, dest_path)
        .map_err(|e| download_io_error("Failed to finalize downloaded file", e))?;

    emit_progress(app, model_id, file_name, total_size, total_size, "completed", None, file_index, file_count);
    log::info!("Parallel download verified and completed: {} ({} bytes)", file_name, total_size);

    Ok(())
}

/// 精确判断错误是否允许降级为单流下载（Fail-Closed 设计）
/// 仅允许网络、分片对账或 checksum 错误；本地 I/O、权限、磁盘满等错误直接返回。
fn is_recoverable_network_error(err_msg: &str) -> bool {
    err_msg.starts_with("sayit_error:download_network:")
        || err_msg.starts_with("sayit_error:download_parallel_verify_failed:")
        || is_checksum_error(err_msg)
}

/// 纯函数校验断点续传响应（严格遵循 RFC 9110 §14.1.2）
/// 规则：
/// 1. 必须提供明确的 Content-Range 响应头（格式: bytes <start>-<end>/<total>）。
/// 2. start 必须严格等于 expected_downloaded。
/// 3. total 必须是明确合法的十进制数字（严禁 *，未知 total 必须拒绝 resume 并从头全量下载）。
/// 4. 如果 expected_total > 0，total 必须等于 expected_total。
/// 5. 对于 Range: bytes=N- 的请求，响应必须覆盖到文件最后一个字节，即 end == total - 1。
/// 6. 如果提供了 content_length，必须满足 content_length == end - start + 1（即 total - start）。
fn is_valid_resume_content_range(
    content_range_opt: Option<&str>,
    content_length_opt: Option<u64>,
    expected_downloaded: u64,
    expected_total: u64,
) -> bool {
    let cr = match content_range_opt {
        Some(s) => s.trim(),
        None => return false,
    };

    let range_part = match cr.strip_prefix("bytes ") {
        Some(p) => p,
        None => return false,
    };

    let parts: Vec<&str> = range_part.split('/').collect();
    if parts.len() != 2 {
        return false;
    }

    let bounds: Vec<&str> = parts[0].split('-').collect();
    if bounds.len() != 2 {
        return false;
    }

    let start: u64 = match bounds[0].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };

    let end: u64 = match bounds[1].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };

    let total: u64 = match parts[1].trim().parse() {
        Ok(v) => v,
        Err(_) => return false,
    };

    if total == 0 || end != total - 1 || start != expected_downloaded || end < start {
        return false;
    }

    if expected_total > 0 && total != expected_total {
        return false;
    }

    if let Some(cl) = content_length_opt {
        if cl != end - start + 1 {
            return false;
        }
    }

    true
}

#[derive(Debug, PartialEq, Eq)]
enum ResumeDecision {
    /// 完整文件已存在且校验通过，直接 finalize 入库
    Finalize,
    /// 文件损坏或超出预期大小，删除并从头开始
    Restart,
    /// 正常续传，携带起始偏移
    Resume(u64),
}

/// 纯函数预检断点续传状态（覆盖 416 防范、EOF 完整性与异常处理）
fn inspect_resume_state(
    current_bytes: u64,
    total_size: u64,
    sha_verify_result: Option<Result<(), String>>,
) -> Result<ResumeDecision, String> {
    if total_size == 0 || current_bytes < total_size {
        return Ok(ResumeDecision::Resume(current_bytes));
    }
    if current_bytes > total_size {
        return Ok(ResumeDecision::Restart);
    }

    match sha_verify_result {
        Some(Err(e)) if is_checksum_error(&e) => Ok(ResumeDecision::Restart),
        Some(Err(e)) => Err(e),
        Some(Ok(())) | None => Ok(ResumeDecision::Finalize),
    }
}

/// 单流下载（用于小文件、不支持 Range 的服务端或并发失败时的 Fallback）
async fn download_file_single_stream(
    app: &AppHandle,
    model_id: &str,
    file_name: &str,
    url: &str,
    total_size: u64,
    expected_sha256: Option<&str>,
    temp_path: &Path,
    dest_path: &Path,
    file_index: u32,
    file_count: u32,
) -> Result<(), String> {
    let raw_initial: u64 = match std::fs::metadata(temp_path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => {
            return Err(download_io_error("Failed to read partial download metadata", e));
        }
    };

    // 完整 .part 先校验；超长或明确哈希不匹配才重置，I/O 错误直接返回。
    let sha_result = if total_size > 0 && raw_initial == total_size {
        expected_sha256.map(|hash| verify_file_sha256(temp_path, hash))
    } else {
        None
    };
    let downloaded_initial = match inspect_resume_state(raw_initial, total_size, sha_result)? {
        ResumeDecision::Finalize => {
            std::fs::rename(temp_path, dest_path)
                .map_err(|e| download_io_error("Failed to finalize completed partial download", e))?;
            emit_progress(app, model_id, file_name, total_size, total_size, "completed", None, file_index, file_count);
            log::info!("Partial download was already complete, verified and finalized: {} ({} bytes)", file_name, total_size);
            return Ok(());
        }
        ResumeDecision::Restart => {
            log::warn!("Partial file {} cannot be resumed safely ({}/{} bytes); restarting from 0", file_name, raw_initial, total_size);
            remove_file_if_exists(temp_path)?;
            0
        }
        ResumeDecision::Resume(offset) => offset,
    };

    let client = build_http_client()?;

    // 严密处理断点续传与重新发起的请求流
    let (resp, mut downloaded, is_resume) = if downloaded_initial > 0 {
        let request = client.get(url).header("Range", format!("bytes={}-", downloaded_initial));
        log::info!("Requesting resume for {} from {} bytes", file_name, downloaded_initial);
        emit_progress(app, model_id, file_name, downloaded_initial, total_size, "downloading", None, file_index, file_count);

        let resp = request
            .send()
            .await
            .map_err(|e| download_error("download_network", format!("Download request failed: {}", e)))?;

        let status = resp.status();
        if status.as_u16() == 206 {
            let cr_str = resp.headers().get("Content-Range").and_then(|v| v.to_str().ok());
            let cl_val = resp.content_length();
            if is_valid_resume_content_range(cr_str, cl_val, downloaded_initial, total_size) {
                (resp, downloaded_initial, true)
            } else {
                // 收到 206 但 Content-Range 缺失/畸形/错位/未到末尾！绝不消费当前 206 body，重发无 Range GET
                log::warn!("Invalid 206 Content-Range for resume. Dropping response and refetching full file from 0.");
                drop(resp);
                remove_file_if_exists(temp_path)?;
                let full_resp = client
                    .get(url)
                    .send()
                    .await
                    .map_err(|e| download_error("download_network", format!("Full restart request failed: {}", e)))?;
                if full_resp.status().as_u16() != 200 {
                    let msg = download_error("download_network", format!("Download restart failed with HTTP {}", full_resp.status()));
                    emit_progress(app, model_id, file_name, 0, total_size, "failed", Some(&msg), file_index, file_count);
                    return Err(msg);
                }
                (full_resp, 0u64, false)
            }
        } else if status.as_u16() == 200 {
            // 服务端忽略 Range 返回 200 OK，全量流覆盖重置
            log::info!("Server returned 200 OK instead of 206. Truncating .part and downloading full stream.");
            (resp, 0u64, false)
        } else {
            let msg = download_error("download_network", format!("Download failed with HTTP {}", status));
            emit_progress(app, model_id, file_name, downloaded_initial, total_size, "failed", Some(&msg), file_index, file_count);
            return Err(msg);
        }
    } else {
        emit_progress(app, model_id, file_name, 0, total_size, "downloading", None, file_index, file_count);
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| download_error("download_network", format!("Download request failed: {}", e)))?;
        if resp.status().as_u16() != 200 {
            let msg = download_error("download_network", format!("Download failed with HTTP {}", resp.status()));
            emit_progress(app, model_id, file_name, 0, total_size, "failed", Some(&msg), file_index, file_count);
            return Err(msg);
        }
        (resp, 0u64, false)
    };

    let content_len = resp.content_length().unwrap_or(0);
    let final_total = if total_size > 0 {
        total_size
    } else {
        downloaded + content_len
    };

    let mut file = if is_resume {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(temp_path)
            .map_err(|e| download_io_error("Failed to open partial download for append", e))?
    } else {
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(temp_path)
            .map_err(|e| download_io_error("Failed to truncate partial download for write", e))?
    };

    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| download_error("download_network", format!("Download interrupted: {}", e)))?;
        file.write_all(&chunk)
            .map_err(|e| download_io_error("Failed to write partial download", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 200 {
            emit_progress(app, model_id, file_name, downloaded, final_total, "downloading", None, file_index, file_count);
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().map_err(|e| download_io_error("Failed to flush partial download", e))?;
    drop(file);

    // 严密校验总大小：若不一致直接报错且不执行 rename
    if final_total > 0 && downloaded != final_total {
        let err = download_error(
            "download_failed",
            format!(
                "Single-stream download incomplete for {}: received {}/{} bytes",
                file_name, downloaded, final_total
            ),
        );
        emit_progress(app, model_id, file_name, downloaded, final_total, "failed", Some(&err), file_index, file_count);
        return Err(err);
    }

    // 如果提供了 SHA-256 校验和，在 rename 之前严格校验
    if let Some(expected_hash) = expected_sha256 {
        if let Err(e) = verify_temp_file_sha256(temp_path, expected_hash) {
            emit_progress(app, model_id, file_name, downloaded, final_total, "failed", Some(&e), file_index, file_count);
            return Err(e);
        }
    }

    std::fs::rename(temp_path, dest_path)
        .map_err(|e| download_io_error("Failed to finalize downloaded file", e))?;

    emit_progress(app, model_id, file_name, downloaded, final_total, "completed", None, file_index, file_count);
    log::info!("Single-stream download verified and completed: {} ({} bytes)", file_name, downloaded);

    Ok(())
}

/// 下载单个文件，支持智能并发分片、临时文件隔离、SHA-256 完整性验证与安全 Fallback 降级
pub async fn download_file(
    app: AppHandle,
    model_id: &str,
    file_name: &str,
    url: &str,
    expected_size: u64,
    expected_sha256: Option<&str>,
    dest_dir: &Path,
    file_index: u32,
    file_count: u32,
) -> Result<(), String> {
    let dest_path = dest_dir.join(file_name);

    // 确保目录存在
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| download_io_error("Failed to create model directory", e))?;
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| download_io_error("Failed to create model subdirectory", e))?;
    }

    // 检查目标路径已存在的文件（直接 match metadata，避免 Path::exists() 静默吞掉 I/O 错误）
    match std::fs::metadata(&dest_path) {
        Ok(meta) => {
            let size = meta.len();
            let size_ok = size > 0 && (expected_size == 0 || size == expected_size);

            if size_ok {
                if let Some(hash) = expected_sha256 {
                    match verify_file_sha256(&dest_path, hash) {
                        Ok(()) => {
                            emit_progress(&app, model_id, file_name, size, size, "completed", None, file_index, file_count);
                            return Ok(());
                        }
                        Err(ref e) if is_checksum_error(e) => {
                            log::warn!("Corrupted model file {} detected; removing before redownload", file_name);
                            remove_file_if_exists(&dest_path)?;
                        }
                        Err(e) => {
                            log::error!("Failed to verify existing {}: {}", file_name, e);
                            return Err(e);
                        }
                    }
                } else {
                    emit_progress(&app, model_id, file_name, size, size, "completed", None, file_index, file_count);
                    return Ok(());
                }
            } else {
                log::warn!("Existing {} size mismatch ({}/{}); removing before redownload", file_name, size, expected_size);
                remove_file_if_exists(&dest_path)?;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(download_io_error("Failed to read existing model metadata", e)),
    }

    let client = build_http_client()?;
    let (probed_size, supports_range) = probe_url(&client, url).await;
    let total_size = if expected_size > 0 { expected_size } else { probed_size };

    if supports_range && total_size >= 16 * 1024 * 1024 {
        log::info!("Starting parallel chunked download for {} ({} bytes, Range verified)", file_name, total_size);
        let parallel_temp = dest_dir.join(format!("{}.par.part", file_name));
        let res = download_file_parallel(
            &app,
            model_id,
            file_name,
            url,
            total_size,
            expected_sha256,
            &parallel_temp,
            &dest_path,
            file_index,
            file_count,
        )
        .await;

        match res {
            Ok(()) => Ok(()),
            Err(e) => {
                if !is_recoverable_network_error(&e) {
                    log::error!("Unrecoverable error during parallel download: {}", e);
                    emit_progress(&app, model_id, file_name, 0, total_size, "failed", Some(&e), file_index, file_count);
                    return Err(e);
                }

                log::warn!("Parallel download failed for {}: {}. Automatically falling back to single-stream download.", file_name, e);
                remove_file_if_exists(&parallel_temp)?;
                let stream_temp = dest_dir.join(format!("{}.part", file_name));
                download_file_single_stream(
                    &app,
                    model_id,
                    file_name,
                    url,
                    total_size,
                    expected_sha256,
                    &stream_temp,
                    &dest_path,
                    file_index,
                    file_count,
                )
                .await
            }
        }
    } else {
        log::info!("Starting single-stream download for {} ({} bytes)", file_name, total_size);
        let stream_temp = dest_dir.join(format!("{}.part", file_name));
        download_file_single_stream(
            &app,
            model_id,
            file_name,
            url,
            total_size,
            expected_sha256,
            &stream_temp,
            &dest_path,
            file_index,
            file_count,
        )
        .await
    }
}

/// 下载 tar.bz2 压缩包并解压到模型目录
/// 解压时会跳过顶层目录（如 sherpa-onnx-funasr-nano-int8-2025-12-30/）
/// 并跳过 test_wavs/ 目录和 README.md
/// 为 GitHub Release 地址生成候选下载列表：国内加速代理优先，直连兜底。
/// 非 GitHub 地址（如 ModelScope）原样返回。
fn build_archive_candidates(url: &str) -> Vec<String> {
    if url.starts_with("https://github.com/") {
        vec![
            format!("https://gh-proxy.com/{}", url),
            format!("https://ghfast.top/{}", url),
            url.to_string(),
        ]
    } else {
        vec![url.to_string()]
    }
}

/// 从单个 URL 下载压缩包到 temp_path（支持断点续传）。下载完整返回 Ok。
async fn download_archive_once(
    app: &AppHandle,
    model_id: &str,
    url: &str,
    temp_path: &Path,
) -> Result<(), String> {
    let mut downloaded: u64 = if temp_path.exists() {
        std::fs::metadata(temp_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let client = build_http_client()?;
    let mut request = client.get(url);
    if downloaded > 0 {
        request = request.header("Range", format!("bytes={}-", downloaded));
        log::info!("Resuming archive download from {} bytes ({})", downloaded, url);
    }

    emit_progress(app, model_id, "archive", downloaded, 0, "downloading", None, 1, 1);

    let resp = request
        .send()
        .await
        .map_err(|e| download_error("download_network", format!("Download request failed: {}", e)))?;

    if !resp.status().is_success() && resp.status().as_u16() != 206 {
        return Err(download_error("download_network", format!("Download failed with HTTP {}", resp.status())));
    }

    let content_length = resp.content_length().unwrap_or(0);
    let total = downloaded + content_length;

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(temp_path)
        .map_err(|e| download_io_error("Failed to open partial archive", e))?;

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| download_error("download_network", format!("Download interrupted: {}", e)))?;
        file.write_all(&chunk).map_err(|e| download_io_error("Failed to write partial archive", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 300 {
            emit_progress(app, model_id, "archive", downloaded, total, "downloading", None, 1, 1);
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().map_err(|e| download_io_error("Failed to flush partial archive", e))?;
    drop(file);
    Ok(())
}

pub async fn download_and_extract_tar_bz2(
    app: AppHandle,
    model_id: &str,
    url: &str,
) -> Result<(), String> {
    let dest_dir = model_dir(model_id);
    let archive_path = dest_dir.with_extension("tar.bz2");
    let temp_path = dest_dir.with_extension("tar.bz2.part");

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| download_io_error("Failed to create model directory", e))?;

    // 如果已经解压过（目录中有 onnx 文件），跳过下载
    // funasr-nano: encoder_adaptor.int8.onnx / paraformer: model.int8.onnx / qwen3-asr: encoder.int8.onnx
    if dest_dir.join("encoder_adaptor.int8.onnx").exists()
        || dest_dir.join("model.int8.onnx").exists()
        || dest_dir.join("encoder.int8.onnx").exists()
    {
        emit_progress(&app, model_id, "archive", 1, 1, "completed", None, 1, 1);
        return Ok(());
    }

    // 多源下载：GitHub 地址自动优先走国内加速代理，失败再回退直连。
    // 各镜像内容一致，可跨源断点续传（沿用已有 .part）。
    let candidates = build_archive_candidates(url);
    let mut last_err = download_error("download_network", "No download source is available");
    let mut ok = false;
    for (idx, cand) in candidates.iter().enumerate() {
        match download_archive_once(&app, model_id, cand, &temp_path).await {
            Ok(()) => { ok = true; break; }
            Err(e) => {
                log::warn!("Archive source {}/{} failed: {}", idx + 1, candidates.len(), e);
                last_err = e;
            }
        }
    }
    if !ok {
        emit_progress(&app, model_id, "archive", 0, 0, "failed", Some(&last_err), 1, 1);
        return Err(last_err);
    }

    std::fs::rename(&temp_path, &archive_path)
        .map_err(|e| download_io_error("Failed to finalize downloaded archive", e))?;

    log::info!("Archive downloaded: {}", model_id);
    emit_progress(&app, model_id, "extracting", 0, 0, "downloading", None, 1, 1);

    // 解压 tar.bz2
    let archive_file = std::fs::File::open(&archive_path)
        .map_err(|e| download_io_error("Failed to open downloaded archive", e))?;
    let bz_decoder = bzip2::read::BzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(bz_decoder);

    for entry in archive.entries().map_err(|e| download_error("download_failed", format!("Failed to read archive: {}", e)))? {
        let mut entry = entry.map_err(|e| download_error("download_failed", format!("Failed to read archive entry: {}", e)))?;
        let path = entry.path().map_err(|e| download_error("download_failed", format!("Failed to read archive path: {}", e)))?;
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
                .map_err(|e| download_io_error(&format!("Failed to create extracted file {:?}", relative), e))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| download_io_error(&format!("Failed to extract file {:?}", relative), e))?;
        }
    }

    // 删除压缩包
    std::fs::remove_file(&archive_path).ok();

    emit_progress(&app, model_id, "archive", 1, 1, "completed", None, 1, 1);
    log::info!("Archive extracted: {}", model_id);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_chunks_edge_cases() {
        assert!(calculate_chunks(0).is_empty());

        let chunks = calculate_chunks(100);
        assert!(!chunks.is_empty());
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, 99);

        // 验证各分片连续且无遗漏无重叠
        for i in 1..chunks.len() {
            assert_eq!(chunks[i].start, chunks[i - 1].end + 1);
        }
    }

    #[test]
    fn test_calculate_chunks_large_model() {
        // 500MB 模型
        let total_size = 500 * 1024 * 1024;
        let chunks = calculate_chunks(total_size);
        assert!(chunks.len() >= 4 && chunks.len() <= 16);
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, total_size - 1);

        let mut sum_bytes = 0u64;
        for i in 0..chunks.len() {
            if i > 0 {
                assert_eq!(chunks[i].start, chunks[i - 1].end + 1);
            }
            sum_bytes += chunks[i].end - chunks[i].start + 1;
        }
        assert_eq!(sum_bytes, total_size);
    }

    #[test]
    fn test_validate_range_response_parts_cases() {
        // 1. 标准有效 206 匹配通过
        assert!(validate_range_response_parts(
            206,
            Some("bytes 0-99/1000"),
            Some(100),
            0,
            99,
            1000
        ).is_ok());

        // 2. HTTP 200 OK 必须被严格拒绝
        assert!(validate_range_response_parts(
            200,
            Some("bytes 0-99/1000"),
            Some(100),
            0,
            99,
            1000
        ).is_err());

        // 7. 已知文件大小时，未知、畸形或不匹配的 total 必须拒绝
        for header in ["bytes 0-99/*", "bytes 0-99/garbage", "bytes 0-99/999"] {
            assert!(validate_range_response_parts(206, Some(header), Some(100), 0, 99, 1000).is_err());
        }

        // 3. Content-Range 缺失必须拒绝
        assert!(validate_range_response_parts(
            206,
            None,
            Some(100),
            0,
            99,
            1000
        ).is_err());

        // 4. 起始 offset 错位必须拒绝
        assert!(validate_range_response_parts(
            206,
            Some("bytes 10-99/1000"),
            Some(90),
            0,
            99,
            1000
        ).is_err());

        // 5. 结束 offset 错位必须拒绝
        assert!(validate_range_response_parts(
            206,
            Some("bytes 0-199/1000"),
            Some(200),
            0,
            99,
            1000
        ).is_err());

        // 6. Content-Length 与区间不符必须拒绝
        assert!(validate_range_response_parts(
            206,
            Some("bytes 0-99/1000"),
            Some(99),
            0,
            99,
            1000
        ).is_err());
    }

    #[test]
    fn test_is_valid_resume_content_range_rfc9110() {
        // 1. 标准有效匹配（bytes 100-999/1000，请求 100-，覆盖到末尾 999，长度 900）
        assert!(is_valid_resume_content_range(
            Some("bytes 100-999/1000"),
            Some(900),
            100,
            1000
        ));

        // 2. 拒绝未覆盖到文件末尾的响应（例如 bytes 100-199/1000，end != total - 1）
        assert!(!is_valid_resume_content_range(
            Some("bytes 100-199/1000"),
            Some(100),
            100,
            1000
        ));

        // 3. 拒绝缺少 Content-Range 或畸形
        assert!(!is_valid_resume_content_range(None, Some(900), 100, 1000));
        assert!(!is_valid_resume_content_range(Some("invalid-header"), Some(900), 100, 1000));
        assert!(!is_valid_resume_content_range(Some("bytes 100-garbage/1000"), Some(900), 100, 1000));
        assert!(!is_valid_resume_content_range(Some("bytes 100-999/garbage"), Some(900), 100, 1000));

        // 4. 拒绝 total 为 *（断点续传未知 total 时强制全量重传）
        assert!(!is_valid_resume_content_range(Some("bytes 100-999/*"), Some(900), 100, 0));

        // 5. 拒绝 start 错位
        assert!(!is_valid_resume_content_range(Some("bytes 0-999/1000"), Some(1000), 100, 1000));
        assert!(!is_valid_resume_content_range(Some("bytes 50-999/1000"), Some(950), 100, 1000));

        // 6. 拒绝 Content-Length 与区间不符
        assert!(!is_valid_resume_content_range(
            Some("bytes 100-999/1000"),
            Some(899), // 应该是 900
            100,
            1000
        ));
    }

    #[test]
    fn test_is_recoverable_network_error_strict() {
        // 允许降级的网络、分片对账与 checksum 错误（必须是前缀开头）
        assert!(is_recoverable_network_error("sayit_error:download_network: connection reset"));
        assert!(is_recoverable_network_error("sayit_error:download_parallel_verify_failed: bytes mismatch"));
        assert!(is_recoverable_network_error("sayit_error:download_checksum: SHA-256 mismatch"));

        // 包含在中间（非前缀）必须被拒绝
        assert!(!is_recoverable_network_error("local_io: sayit_error:download_network: wrapped"));

        // 严格拒绝降级的本地 I/O 错误
        assert!(!is_recoverable_network_error("sayit_error:download_failed: Failed to rename file"));
        assert!(!is_recoverable_network_error("sayit_error:download_no_space: No space on disk"));
        assert!(!is_recoverable_network_error("sayit_error:download_permission: Access denied"));
    }

    #[test]
    fn test_verify_file_sha256() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("sayit_test_sha256.tmp");

        // 写入测试数据 "hello world\n" (SHA-256: a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447)
        std::fs::write(&test_file, b"hello world\n").unwrap();

        // 匹配成功
        assert!(verify_file_sha256(&test_file, "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447").is_ok());
        // 大小写不敏感匹配
        assert!(verify_file_sha256(&test_file, "A948904F2F0F479B8F8197694B30184B0D2ED1C1CD2A1EC0FB85D299A192A447").is_ok());

        // hash 不匹配生成前端可识别的 sayit_error:download_checksum: 错误代码
        let mismatch_err = verify_file_sha256(&test_file, "0000000000000000000000000000000000000000000000000000000000000000").unwrap_err();
        assert!(is_checksum_error(&mismatch_err));

        // 验证非前缀的文本（即便是包含关键字）不会被生产分类器误判
        let wrapped_err = format!("other_wrapper: {}", mismatch_err);
        assert!(!is_checksum_error(&wrapped_err));

        let mismatch_err = verify_temp_file_sha256(&test_file, "0").unwrap_err();
        assert!(is_checksum_error(&mismatch_err));
        assert!(!test_file.exists());
    }

    #[test]
    fn test_verify_temp_file_sha256_preserves_io_error() {
        let test_dir = std::env::temp_dir().join(format!("sayit_sha256_dir_{}", std::process::id()));
        std::fs::create_dir(&test_dir).unwrap();

        let err = verify_temp_file_sha256(&test_dir, "0").unwrap_err();
        assert!(!is_checksum_error(&err));
        assert!(test_dir.is_dir());

        std::fs::remove_dir(test_dir).unwrap();
    }

    #[test]
    fn test_inspect_resume_state() {
        let ok_res = Ok(());
        let hash_err = Err("sayit_error:download_checksum: bad hash".to_string());
        let io_err = Err("sayit_error:download_permission: Access denied".to_string());

        // 1. 完整文件且 SHA-256 匹配（或无预期 hash） -> Finalize
        assert_eq!(inspect_resume_state(1000, 1000, Some(ok_res)).unwrap(), ResumeDecision::Finalize);
        assert_eq!(inspect_resume_state(1000, 1000, None).unwrap(), ResumeDecision::Finalize);

        // 2. 完整文件但明确 SHA-256 不匹配 -> Restart
        assert_eq!(inspect_resume_state(1000, 1000, Some(hash_err)).unwrap(), ResumeDecision::Restart);

        // 3. 完整文件但由于 I/O 错误无法校验 -> 原样返回，生产保留文件现场
        assert_eq!(inspect_resume_state(1000, 1000, Some(io_err)).unwrap_err(), "sayit_error:download_permission: Access denied");

        // 4. 文件尺寸超出 total_size -> Restart
        assert_eq!(inspect_resume_state(1200, 1000, None).unwrap(), ResumeDecision::Restart);

        // 5. 正常断点续传（部分文件） -> Resume(downloaded)
        assert_eq!(inspect_resume_state(500, 1000, None).unwrap(), ResumeDecision::Resume(500));

        // 6. 首次下载（无已有文件） -> Resume(0)
        assert_eq!(inspect_resume_state(0, 1000, None).unwrap(), ResumeDecision::Resume(0));
    }
}




