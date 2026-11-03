//! 系统权限状态与引导（主要给 macOS 用）。
//!
//! macOS 上热键吞键、模拟 ⌘V、读光标上下文都要「辅助功能」授权，录音要麦克风授权；
//! 前端用这几个命令显示授权状态、带用户去系统设置。Windows 上不需要额外授权，
//! 返回固定的「已授权」，前端据此不显示引导。

use serde_json::{json, Value};

/// 当前平台的权限状态。
#[tauri::command]
pub fn get_platform_permissions() -> Value {
    #[cfg(target_os = "macos")]
    {
        let status = crate::platform::macos::permissions::status(crate::keyboard::tap_active());
        serde_json::to_value(status).unwrap_or_else(|_| json!({ "platform": "macos" }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        json!({
            "platform": std::env::consts::OS,
            "accessibility": true,
            "hotkeyActive": true,
            "microphone": "authorized",
            "secureInput": false,
            "translocated": false,
            "bundlePath": "",
        })
    }
}

/// 请求「辅助功能」授权：还没授权时系统会弹出引导对话框。返回当前是否已授权。
#[tauri::command]
pub fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::platform::macos::permissions::request_accessibility()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// 打开系统设置里的隐私面板：accessibility / microphone / input_monitoring。
#[tauri::command]
pub fn open_privacy_settings(pane: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::platform::macos::permissions::open_privacy_pane(&pane)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        Err("Privacy settings are only needed on macOS".to_string())
    }
}
