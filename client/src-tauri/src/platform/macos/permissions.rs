//! macOS 隐私权限：辅助功能、麦克风、安全输入状态，以及打开对应的系统设置页。
//!
//! SayIt 在 mac 上需要两项授权：
//! - **辅助功能**：能吞键的全局热键（CGEventTap）、模拟 ⌘V、读取光标附近文字都靠它。
//!   系统不会弹窗直接授予，只能引导用户去「系统设置 → 隐私与安全性 → 辅助功能」勾选。
//! - **麦克风**：第一次 getUserMedia 时系统自动弹窗（Info.plist 里有用途说明）。

use objc2::rc::autoreleasepool;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use serde::Serialize;

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

/// AVAuthorizationStatus 的取值。
fn describe_av_status(status: isize) -> &'static str {
    match status {
        0 => "not_determined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        _ => "unknown",
    }
}

/// 麦克风授权状态：not_determined / restricted / denied / authorized。
pub fn microphone_status() -> &'static str {
    autoreleasepool(|_| unsafe {
        // AVMediaTypeAudio 的值就是 "soun"
        let media_type = NSString::from_str("soun");
        let status: isize = msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: &*media_type];
        describe_av_status(status)
    })
}

/// 是否有程序打开了「安全输入」（密码框、终端的「安全键盘输入」等）。
/// 打开期间 event tap 收不到键盘事件，键盘热键会失灵（鼠标键不受影响）。
pub fn secure_input_enabled() -> bool {
    unsafe { super::ffi::IsSecureEventInputEnabled() != 0 }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub platform: &'static str,
    /// 辅助功能是否已授权
    pub accessibility: bool,
    /// 全局热键的 event tap 是否已经装上并处于启用状态
    pub hotkey_active: bool,
    pub microphone: &'static str,
    pub secure_input: bool,
    /// App 是否在被「App Translocation」随机路径里运行（直接在 DMG / 下载目录里打开时会这样），
    /// 这种情况下自动更新会失败，应提示用户把 SayIt 拖进「应用程序」。
    pub translocated: bool,
    pub bundle_path: String,
}

pub fn status(hotkey_active: bool) -> PermissionStatus {
    let bundle_path = current_bundle_path().unwrap_or_default();
    PermissionStatus {
        platform: "macos",
        accessibility: super::ax::is_trusted(),
        hotkey_active,
        microphone: microphone_status(),
        secure_input: secure_input_enabled(),
        translocated: bundle_path.contains("/AppTranslocation/"),
        bundle_path,
    }
}

/// 当前运行的 `.app` 包路径（开发模式下是可执行文件所在目录）。
pub fn current_bundle_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let mut path = exe.as_path();
    while let Some(parent) = path.parent() {
        if path.extension().map(|e| e == "app").unwrap_or(false) {
            return Some(path.to_string_lossy().into_owned());
        }
        path = parent;
    }
    exe.parent().map(|p| p.to_string_lossy().into_owned())
}

/// 系统设置里的隐私面板。
pub fn open_privacy_pane(pane: &str) -> Result<(), String> {
    let anchor = match pane {
        "accessibility" => "Privacy_Accessibility",
        "microphone" => "Privacy_Microphone",
        "input_monitoring" => "Privacy_ListenEvent",
        _ => return Err(format!("unknown privacy pane: {pane}")),
    };
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open System Settings: {e}"))
}

/// 请求辅助功能授权：没授权时系统会弹出「SayIt 想控制这台电脑」的对话框，
/// 带「打开系统设置」按钮。返回当前是否已授权。
pub fn request_accessibility() -> bool {
    super::ax::is_trusted_with_prompt(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_reported_without_prompting() {
        let s = status(false);
        assert_eq!(s.platform, "macos");
        assert!(["not_determined", "restricted", "denied", "authorized", "unknown"].contains(&s.microphone));
    }
}
