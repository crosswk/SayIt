use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use crate::storage::Storage;
use std::io::Write;
use std::sync::Mutex;
use std::sync::OnceLock;
use base64::Engine;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Persistent log file writer — opened once, reused across calls.
static LOG_FILE: std::sync::LazyLock<Mutex<Option<std::fs::File>>> =
    std::sync::LazyLock::new(|| {
        let file = open_log_file();
        Mutex::new(file)
    });

/// Max log file size before rotation (5 MB)
const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;
/// Number of rotated files to keep
const ROTATED_FILES_KEEP: usize = 3;

fn log_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("logs")
}

fn log_file_path() -> std::path::PathBuf {
    log_dir().join("sayit.log")
}

fn open_log_file() -> Option<std::fs::File> {
    let dir = log_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[log] failed to create log dir {:?}: {}", dir, e);
        return None;
    }
    let path = log_file_path();
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

fn rotate_if_needed() {
    let path = log_file_path();
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size < MAX_LOG_SIZE {
        return;
    }
    // Rotate: sayit.log -> sayit.1.log, sayit.1.log -> sayit.2.log, etc.
    let dir = log_dir();
    for i in (1..ROTATED_FILES_KEEP).rev() {
        let from = dir.join(format!("sayit.{}.log", i));
        let to = dir.join(format!("sayit.{}.log", i + 1));
        let _ = std::fs::rename(&from, &to);
    }
    let rotated = dir.join("sayit.1.log");
    let _ = std::fs::rename(&path, &rotated);
}

pub fn write_log_line(line: &str) {
    // 用 unwrap_or_else 而非 unwrap()：即使这个 Mutex 曾在某次 panic 中被"污染"
    // （poisoned），日志功能也不能跟着永久失效——否则会形成"一次意外 panic 导致
    // 之后所有诊断日志都写不出来"的雪崩，恰恰是排查间歇性问题最怕遇到的情况。
    let mut guard = LOG_FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Rotate check — reopen file if needed
    rotate_if_needed();
    if guard.is_none() {
        *guard = open_log_file();
    }
    if let Some(ref mut f) = *guard {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{}] {}", ts, line);
        let _ = f.flush();
    }
}

fn get_os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        // 从注册表读取，不弹窗口
        use std::process::Command;
        Command::new("cmd")
            .args(["/C", "ver"])
            .creation_flags(0x08000000)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s: String| s.trim().to_string())
            .unwrap_or_else(|| "Windows".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        whoami::distro()
    }
}

fn get_local_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn get_system_locale() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("powershell")
            .args(["-NoProfile", "-Command", "(Get-Culture).Name"])
            .creation_flags(0x08000000)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s: String| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("LANG").unwrap_or_else(|_| "unknown".to_string())
    }
}

fn get_total_memory_mb() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("powershell")
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB"])
            .creation_flags(0x08000000)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s: String| s.trim().parse::<f64>().ok())
            .map(|v| v as u64)
            .unwrap_or(0)
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

#[derive(Serialize, Clone)]
pub struct ClientRuntimeInfo {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "userName")]
    pub user_name: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub hostname: String,
    #[serde(rename = "clientVersion")]
    pub client_version: String,
    pub platform: String,
    #[serde(rename = "osVersion")]
    pub os_version: String,
    #[serde(rename = "localIp")]
    pub local_ip: String,
    #[serde(rename = "systemLocale")]
    pub system_locale: String,
    #[serde(rename = "cpuCores")]
    pub cpu_cores: usize,
    #[serde(rename = "memoryMb")]
    pub memory_mb: u64,
}

static RUNTIME_INFO_CACHE: OnceLock<ClientRuntimeInfo> = OnceLock::new();

#[tauri::command]
pub fn get_client_runtime_info(storage: State<Storage>) -> Result<ClientRuntimeInfo, String> {
    if let Some(cached) = RUNTIME_INFO_CACHE.get() {
        return Ok(cached.clone());
    }

    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let user_name = whoami::username();

    // Persist device_id so it stays stable across restarts
    let existing = storage.get("deviceId", None);
    let device_id = if let Some(id) = existing.as_str() {
        if !id.is_empty() {
            id.to_string()
        } else {
            let new_id = format!("sayit-{}", uuid::Uuid::new_v4());
            let _ = storage.set("deviceId", &serde_json::json!(new_id));
            new_id
        }
    } else {
        let new_id = format!("sayit-{}", uuid::Uuid::new_v4());
        let _ = storage.set("deviceId", &serde_json::json!(new_id));
        new_id
    };

    let info = ClientRuntimeInfo {
        user_id: user_name.clone(),
        user_name,
        device_id,
        hostname,
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        os_version: get_os_version(),
        local_ip: get_local_ip(),
        system_locale: get_system_locale(),
        cpu_cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        memory_mb: get_total_memory_mb(),
    };
    let _ = RUNTIME_INFO_CACHE.set(info.clone());
    Ok(info)
}

#[tauri::command]
pub fn get_auto_launch(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_auto_launch(app: AppHandle, _enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if _enable {
        autostart.enable().map_err(|e| e.to_string())
    } else {
        autostart.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn get_update_status() -> Result<Value, String> {
    Ok(serde_json::json!({
        "enabled": true,
        "phase": "idle",
        "currentVersion": env!("CARGO_PKG_VERSION"),
    }))
}

#[tauri::command]
pub fn check_for_updates() -> Result<Value, String> {
    // 版本检查由前端 updateChecker.ts 完成，这里只返回当前版本
    Ok(serde_json::json!({
        "enabled": true,
        "phase": "idle",
        "currentVersion": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Serialize, Clone)]
struct UpdateDownloadProgress {
    #[serde(rename = "downloadedBytes")]
    downloaded_bytes: u64,
    #[serde(rename = "totalBytes")]
    total_bytes: u64,
    percent: f64,
    status: String,
    error: Option<String>,
}

fn emit_update_progress(app: &AppHandle, downloaded: u64, total: u64, status: &str, error: Option<&str>) {
    let percent = if total > 0 {
        (downloaded as f64 / total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };
    let _ = app.emit(
        "update-download-progress",
        UpdateDownloadProgress {
            downloaded_bytes: downloaded,
            total_bytes: total,
            percent,
            status: status.to_string(),
            error: error.map(String::from),
        },
    );
}

/// 下载更新安装包到临时目录，下载过程中通过 update-download-progress 事件上报真实字节进度
#[tauri::command]
pub async fn download_update(app: AppHandle, url: String) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    // 必须带 User-Agent：生产环境 AWS WAF 的 NoUserAgent_HEADER 规则会拦截无 UA 的请求（403）
    let client = reqwest::Client::builder()
        .user_agent(concat!("SayIt/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("初始化下载客户端失败: {}", e))?;

    emit_update_progress(&app, 0, 0, "downloading", None);

    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| {
            let msg = format!("下载失败: {}", e);
            emit_update_progress(&app, 0, 0, "failed", Some(&msg));
            msg
        })?;

    if !resp.status().is_success() {
        let msg = format!("下载失败: HTTP {}", resp.status());
        emit_update_progress(&app, 0, 0, "failed", Some(&msg));
        return Err(msg);
    }

    let total = resp.content_length().unwrap_or(0);

    // 从 URL 提取文件名
    let filename = url.split('/').last().unwrap_or("SayIt-Setup.exe").to_string();
    let temp_dir = std::env::temp_dir().join("sayit-update");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let file_path = temp_dir.join(&filename);

    let mut file = std::fs::File::create(&file_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let msg = format!("下载中断: {}", e);
            emit_update_progress(&app, downloaded, total, "failed", Some(&msg));
            msg
        })?;
        file.write_all(&chunk).map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;

        // 每 200ms 发送一次进度，避免刷屏
        if last_emit.elapsed().as_millis() >= 200 {
            emit_update_progress(&app, downloaded, total, "downloading", None);
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().map_err(|e| format!("flush 失败: {}", e))?;
    drop(file);

    emit_update_progress(&app, downloaded, total.max(downloaded), "completed", None);

    Ok(file_path.to_string_lossy().to_string())
}

/// 启动安装程序并退出当前应用
#[tauri::command]
pub fn install_downloaded_update(file_path: String, app: AppHandle) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err("安装包文件不存在".to_string());
    }

    // 启动 NSIS 安装程序（/S 静默安装）。静默模式下 NSIS 不会像交互式安装那样
    // 提供"安装完成后运行"的选项，所以需要自己接管：起一个不依赖当前进程存活的
    // "看门人" cmd 进程 —— 等安装进程真正退出（文件覆盖完成）后，再拉起新版本
    // exe（同一路径，currentUser 安装模式下更新会装到原目录）。
    // 必须等旧进程完全退出后才能让安装程序覆盖 exe 文件（Windows 文件锁），
    // 所以看门人进程要在本进程之外独立存活，用 cmd /c 包一层 + start /wait。
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let current_exe = std::env::current_exe()
            .map_err(|e| format!("获取当前程序路径失败: {}", e))?;
        let exe_str = current_exe.to_string_lossy().to_string();

        // 用一个临时 .bat 脚本接管"等安装完成再拉起新版本"。
        // 关键：不要把带引号、含 && 的复合命令直接塞给 `cmd /C`——Rust 会把这个
        // 含空格的参数整体再套引号并把内部 " 转义成 \"，而 cmd.exe 不认识 \" 转义，
        // 导致路径被啃坏（历史 bug：装完自动重启报「找不到 \ 文件」）。
        // 脚本文件里的引号是文件字面量，不经过参数转义层，最稳；给 cmd /C 传单个
        // 脚本路径是 cmd 唯一能干净处理的情形。
        //   - ping 兜 ~1s，等旧进程完全退出，避免安装程序覆盖 exe 时撞文件锁
        //   - start /wait 等静默安装结束，再拉起新 exe（--open-about 跳转关于页）
        //   - del "%~f0" 让脚本运行完自删
        let script = format!(
            "@echo off\r\n\
             ping -n 2 127.0.0.1 >nul\r\n\
             start /wait \"\" \"{installer}\" /S\r\n\
             start \"\" \"{exe}\" --open-about\r\n\
             del \"%~f0\"\r\n",
            installer = file_path,
            exe = exe_str,
        );
        let script_path = std::env::temp_dir().join("sayit-update-relaunch.bat");
        std::fs::write(&script_path, script)
            .map_err(|e| format!("写入更新重启脚本失败: {}", e))?;

        Command::new("cmd")
            .args(["/C", &script_path.to_string_lossy()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动安装看门人进程失败: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Err("当前平台不支持自动安装".to_string());
    }

    // 退出当前应用，让安装程序能够覆盖 exe 文件
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn append_debug_log(payload: Value) -> Result<(), String> {
    // Format a compact single-line representation for the log file
    let line = match payload {
        Value::Object(ref map) => {
            let kind = map.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
            match kind {
                "runtime" => {
                    let level = map.get("level").and_then(|v| v.as_str()).unwrap_or("info");
                    let source = map.get("source").and_then(|v| v.as_str()).unwrap_or("");
                    let message = map.get("message").and_then(|v| v.as_str()).unwrap_or("");
                    let detail = map.get("detail");
                    if let Some(d) = detail {
                        format!("[{}] [{}] {} {}", level.to_uppercase(), source, message, d)
                    } else {
                        format!("[{}] [{}] {}", level.to_uppercase(), source, message)
                    }
                }
                "session_start" => {
                    let sid = map.get("sessionId").and_then(|v| v.as_str()).unwrap_or("?");
                    format!("[SESSION] start id={}", sid)
                }
                "session_end" => {
                    let sid = map.get("sessionId").and_then(|v| v.as_str()).unwrap_or("?");
                    let dur = map.get("durationMs").and_then(|v| v.as_i64()).unwrap_or(0);
                    let msgs = map.get("messageCount").and_then(|v| v.as_i64()).unwrap_or(0);
                    format!("[SESSION] end id={} duration={}ms messages={}", sid, dur, msgs)
                }
                "ws_message" => {
                    let dir = map.get("direction").and_then(|v| v.as_str()).unwrap_or("?");
                    let typ = map.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                    let data = map.get("data");
                    if let Some(d) = data {
                        format!("[WS] {} {} {}", dir, typ, d)
                    } else {
                        format!("[WS] {} {}", dir, typ)
                    }
                }
                _ => {
                    serde_json::to_string(&payload).unwrap_or_else(|_| format!("{:?}", payload))
                }
            }
        }
        _ => {
            serde_json::to_string(&payload).unwrap_or_else(|_| format!("{:?}", payload))
        }
    };

    write_log_line(&line);
    Ok(())
}

#[tauri::command]
pub fn save_audio_to_downloads(base64_data: String, filename: String) -> Result<String, String> {
    let downloads = dirs::download_dir()
        .ok_or_else(|| "无法获取下载目录".to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let dest = downloads.join(&filename);
    std::fs::write(&dest, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;

    let path_str = dest.to_string_lossy().to_string();
    write_log_line(&format!("[INFO] [audio] 音频已保存到 {}", path_str));
    Ok(path_str)
}

/// 打开文件所在的文件夹（并选中文件）
#[tauri::command]
pub fn reveal_file_in_folder(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // explorer /select, 会打开文件夹并高亮选中文件
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let path = std::path::PathBuf::from(&file_path);
        let dir = path.parent().unwrap_or(&path);
        std::process::Command::new("xdg-open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    Ok(())
}
