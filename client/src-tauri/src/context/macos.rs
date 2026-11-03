//! macOS 前台应用与焦点元素采集（对应 Windows 的 GetGUIThreadInfo + UI Automation）。
//!
//! 字段沿用 Windows 的 AppContext，含义按 mac 填：
//! - `hwnd`：前台应用的 pid（不透明 token，前端只会原样传回 paste_text）
//! - `processName`：可执行文件名；`exePath`：可执行文件路径；`bundleId`：Bundle ID
//! - `windowClass`：Bundle ID（mac 没有窗口类，借这个字段让日志/诊断能看到是哪个应用）
//! - `controlType` / `focusClass` / `automationId`：AXRole / AXSubrole / AXIdentifier
//! - `hasCaret`：焦点元素有没有 AXSelectedTextRange

use super::{sanitize_uia_text, tail_chars, AppContext, MonitorBounds, TextContext};
use crate::platform::macos::appkit;
use crate::platform::macos::ax::{self, AxElement};
use crate::platform::macos::ffi::CFRange;

const TEXT_BEFORE_LIMIT: usize = 500;
const TEXT_AFTER_LIMIT: usize = 300;
const SELECTED_TEXT_LIMIT: usize = 6000;
/// 退回读整个 AXValue 时的上限（UTF-16 单元）。超大的文档不读，免得把编辑器卡住。
const VALUE_FALLBACK_LIMIT: usize = 200_000;

pub fn capture_context_with_text(reason: &str, include_text_context: bool) -> AppContext {
    let mut ctx = AppContext {
        reason: reason.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        is_enabled: true,
        ..Default::default()
    };

    let Some(app) = appkit::frontmost_app() else {
        return ctx;
    };
    ctx.hwnd = app.pid.to_string();
    ctx.pid = app.pid.max(0) as u32;
    ctx.process_name = app.executable_name();
    ctx.exe_path = app.executable_path.clone();
    ctx.window_class = app.bundle_id.clone();
    ctx.bundle_id = app.bundle_id.clone();
    if ctx.process_name.is_empty() {
        ctx.process_name = app.name.clone();
    }

    // 没有辅助功能授权时只能拿到应用级信息；可编辑判据会退回 bundle 白名单。
    if !ax::is_trusted() {
        return ctx;
    }
    let Some(app_element) = AxElement::application(app.pid) else {
        return ctx;
    };
    app_element.set_timeout(ax::DEFAULT_TIMEOUT_SECS);

    // Electron 应用默认不建无障碍树，只有真要读正文时才打开（会让对方多耗一点 CPU/内存）。
    if include_text_context {
        let _ = app_element.set_bool("AXManualAccessibility", true);
    }

    if let Some(window) = app_element.attr_element("AXFocusedWindow") {
        window.set_timeout(ax::DEFAULT_TIMEOUT_SECS);
        ctx.window_title = window.attr_string("AXTitle").unwrap_or_default();
    }

    let Some(focused) = app_element.attr_element("AXFocusedUIElement") else {
        return ctx;
    };
    focused.set_timeout(ax::DEFAULT_TIMEOUT_SECS);
    ctx.focus_hwnd = ctx.hwnd.clone();
    ctx.control_type = focused.attr_string("AXRole").unwrap_or_default();
    ctx.focus_class = focused.attr_string("AXSubrole").unwrap_or_default();
    ctx.automation_id = focused.attr_string("AXIdentifier").unwrap_or_default();
    ctx.is_enabled = focused.attr_bool("AXEnabled").unwrap_or(true);
    ctx.is_keyboard_focusable = focused.attr_bool("AXFocused").unwrap_or(false);
    ctx.is_password = ctx.focus_class == "AXSecureTextField";

    let selection = focused.attr_range("AXSelectedTextRange");
    ctx.has_caret = selection.is_some();
    ctx.is_text_pattern_available = selection.is_some();
    let value_settable = focused.is_settable("AXValue");
    ctx.is_value_pattern_available = value_settable.is_some();
    ctx.is_read_only = value_settable.map(|settable| !settable);

    // 密码框是硬边界：即使开了上下文感知也绝不读取。
    if include_text_context && !ctx.is_password && ctx.is_enabled {
        ctx.text_context = selection.and_then(|range| capture_text_context(&focused, range));
    }
    ctx
}

fn utf16_slice(units: &[u16], start: usize, end: usize) -> String {
    let start = start.min(units.len());
    let end = end.clamp(start, units.len());
    String::from_utf16_lossy(&units[start..end])
}

/// 光标前 500 字、选区（超过 6000 字不发）、光标后 300 字。
/// 优先用 AXStringForRange 只取需要的那一小段；不支持的控件退回读 AXValue 再切。
fn capture_text_context(element: &AxElement, selection: CFRange) -> Option<TextContext> {
    if selection.location < 0 || selection.length < 0 {
        return None;
    }
    let location = selection.location as usize;
    let length = selection.length as usize;
    let total = element.attr_i64("AXNumberOfCharacters").map(|n| n.max(0) as usize);

    // AX 的区间以 UTF-16 为单位；限额按字符数近似，前后各多取一点再按字符截。
    let before_start = location.saturating_sub(TEXT_BEFORE_LIMIT);
    let after_start = location + length;
    let after_len = match total {
        Some(total) => total.saturating_sub(after_start).min(TEXT_AFTER_LIMIT),
        None => TEXT_AFTER_LIMIT,
    };

    let mut text_before = element
        .string_for_range(CFRange { location: before_start as isize, length: (location - before_start) as isize })
        .map(|s| sanitize_uia_text(&s));
    let mut text_after = if after_len > 0 {
        element
            .string_for_range(CFRange { location: after_start as isize, length: after_len as isize })
            .map(|s| sanitize_uia_text(&s))
    } else {
        Some(String::new())
    };

    let mut selection_truncated = false;
    let mut selected_text = String::new();
    if length > SELECTED_TEXT_LIMIT {
        selection_truncated = true;
    } else if length > 0 {
        let raw = element
            .attr_string("AXSelectedText")
            .or_else(|| element.string_for_range(selection))
            .map(|s| sanitize_uia_text(&s))
            .unwrap_or_default();
        if raw.chars().count() > SELECTED_TEXT_LIMIT {
            selection_truncated = true;
        } else if !raw.trim().is_empty() {
            selected_text = raw;
        }
    }

    // 控件不支持按区间取字：退回读整个值（太大的不读）
    if text_before.is_none() || text_after.is_none() {
        if total.map(|t| t <= VALUE_FALLBACK_LIMIT).unwrap_or(true) {
            if let Some(value) = element.attr_string("AXValue") {
                let units: Vec<u16> = value.encode_utf16().collect();
                if units.len() <= VALUE_FALLBACK_LIMIT {
                    if text_before.is_none() {
                        text_before = Some(sanitize_uia_text(&utf16_slice(&units, before_start, location)));
                    }
                    if text_after.is_none() {
                        text_after = Some(sanitize_uia_text(&utf16_slice(&units, after_start, after_start + TEXT_AFTER_LIMIT)));
                    }
                }
            }
        }
    }

    let text_before = tail_chars(&text_before.unwrap_or_default(), TEXT_BEFORE_LIMIT);
    let text_after: String = text_after.unwrap_or_default().chars().take(TEXT_AFTER_LIMIT).collect();
    if text_before.is_empty() && selected_text.is_empty() && text_after.is_empty() && !selection_truncated {
        return None;
    }
    Some(TextContext {
        source: "ax_selected_text_range".to_string(),
        text_before,
        selected_text,
        text_after,
        selection_truncated,
    })
}

/// 前台应用焦点窗口的位置（**逻辑点**，左上角为原点的全局坐标）。
///
/// 与 Windows 不同，这里返回的不是显示器工作区，而是窗口矩形本身：mac 上各显示器缩放
/// 可以不同，物理像素坐标不能跨屏比较，悬浮窗定位改在 window 模块里按逻辑坐标找显示器、
/// 取它的工作区（见 window::macos_overlay_bounds）。
pub fn capture_foreground_monitor() -> Option<MonitorBounds> {
    if !ax::is_trusted() {
        return None;
    }
    let app = appkit::frontmost_app()?;
    let app_element = AxElement::application(app.pid)?;
    app_element.set_timeout(ax::DEFAULT_TIMEOUT_SECS);
    let window = app_element.attr_element("AXFocusedWindow")?;
    window.set_timeout(ax::DEFAULT_TIMEOUT_SECS);
    let position = window.attr_point("AXPosition")?;
    let size = window.attr_size("AXSize")?;
    if size.width <= 0.0 || size.height <= 0.0 {
        return None;
    }
    Some(MonitorBounds {
        left: position.x.round() as i32,
        top: position.y.round() as i32,
        right: (position.x + size.width).round() as i32,
        bottom: (position.y + size.height).round() as i32,
        source: "ax_focused_window".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_slice_is_bounds_safe() {
        let units: Vec<u16> = "你好世界".encode_utf16().collect();
        assert_eq!(utf16_slice(&units, 1, 3), "好世");
        assert_eq!(utf16_slice(&units, 3, 99), "界");
        assert_eq!(utf16_slice(&units, 9, 2), "");
    }

    #[test]
    fn capture_never_panics_without_permission() {
        let ctx = capture_context_with_text("test", false);
        assert_eq!(ctx.reason, "test");
    }
}
