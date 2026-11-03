//! macOS 文字插入：写 NSPasteboard → 模拟 ⌘V → 延时还原剪贴板。
//!
//! 与 Windows 的对应关系：
//! - Windows 先试 `WM_PASTE` 直发控件、再退 `SendInput` Ctrl+V；mac 没有跨进程直发粘贴消息的
//!   通道，统一用 `CGEventPost` 发 ⌘V（终端里的 TUI 也能用：⌘V 由终端程序自己处理，
//!   不需要 conhost 那条特殊路径）。
//! - 剪贴板保护：插入前给剪贴板拍全类型快照，粘贴后 500 ms 若剪贴板仍是我们写的那份就还原。
//!   「是否被改过」看 changeCount（对应 GetClipboardSequenceNumber）。
//! - 剪贴板历史排除：写入时附带 `org.nspasteboard.TransientType`。
//! - 没有「抢前台」：悬浮窗不激活，焦点一直在目标程序。插入前若前台程序已经不是录音开始时
//!   那个（用户切走了），不硬往新窗口里插，交给兜底卡片。

use super::InjectResult;
use crate::commands::system::write_log_line;
use crate::platform::macos::{appkit, ax, ffi::*, keycodes};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// 每次粘贴递增。旧的还原线程看到新一代粘贴就放弃，避免覆盖新内容。
static PASTE_GENERATION: AtomicU64 = AtomicU64::new(0);

const CLIPBOARD_SNAPSHOT_BUDGET: Duration = Duration::from_millis(150);
const CLIPBOARD_SNAPSHOT_MAX_BYTES: usize = 64 * 1024 * 1024;
/// 还原前等多久。比 Windows 的 400 ms 稍长：mac 上目标程序是在处理 ⌘V 事件时才去读剪贴板，
/// Electron / 浏览器还是异步读，太早还原会让它读到旧内容。
const RESTORE_DELAY: Duration = Duration::from_millis(500);

fn result(ok: bool, strategy: &str, reason: Option<&str>, detail: String) -> InjectResult {
    InjectResult {
        ok,
        strategy: Some(strategy.to_string()),
        reason: reason.map(str::to_string),
        detail: Some(detail),
        uncertain: false,
    }
}

/// 当前键盘布局下打出「v」的那个键码。Dvorak 等布局里 ⌘V 不在 QWERTY 的 V 位置上。
/// 中文输入法激活时取它底下的 ASCII 布局。找不到就用 ANSI V。
fn keycode_for_v() -> CGKeyCode {
    unsafe {
        let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
        if source.is_null() {
            return keycodes::KVK_ANSI_V;
        }
        let layout_data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) as CFDataRef;
        let mut found = None;
        if !layout_data.is_null() {
            let layout = CFDataGetBytePtr(layout_data) as *const std::ffi::c_void;
            let kbd_type = LMGetKbdType() as u32;
            for keycode in 0u16..128 {
                let mut dead_key_state: u32 = 0;
                let mut chars = [0u16; 4];
                let mut len: usize = 0;
                let status = UCKeyTranslate(
                    layout,
                    keycode,
                    kUCKeyActionDisplay,
                    0,
                    kbd_type,
                    kUCKeyTranslateNoDeadKeysMask,
                    &mut dead_key_state,
                    chars.len(),
                    &mut len,
                    chars.as_mut_ptr(),
                );
                if status == 0 && len == 1 && (chars[0] == 'v' as u16 || chars[0] == 'V' as u16) {
                    found = Some(keycode);
                    break;
                }
            }
        }
        CFRelease(source as CFTypeRef);
        found.unwrap_or(keycodes::KVK_ANSI_V)
    }
}

/// 发 ⌘V。flags 显式只带 ⌘：用户此刻还按着的 ⌥（按住说话键）不会混进来。
/// 事件带 SayIt 标记，自己的 event tap 会放行、不当成用户按键。
fn post_command_v() -> Result<(), String> {
    unsafe {
        let source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        let keycode = keycode_for_v();
        let down = CGEventCreateKeyboardEvent(source, keycode, true);
        let up = CGEventCreateKeyboardEvent(source, keycode, false);
        if down.is_null() || up.is_null() {
            for e in [down, up] {
                if !e.is_null() {
                    CFRelease(e as CFTypeRef);
                }
            }
            if !source.is_null() {
                CFRelease(source as CFTypeRef);
            }
            return Err("CGEventCreateKeyboardEvent returned NULL".to_string());
        }
        for e in [down, up] {
            CGEventSetFlags(e, kCGEventFlagMaskCommand);
            CGEventSetIntegerValueField(e, kCGEventSourceUserData, crate::keyboard::SAYIT_EVENT_MARKER);
        }
        CGEventPost(kCGHIDEventTap, down);
        std::thread::sleep(Duration::from_millis(8));
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(down as CFTypeRef);
        CFRelease(up as CFTypeRef);
        if !source.is_null() {
            CFRelease(source as CFTypeRef);
        }
    }
    Ok(())
}

/// 粘贴后延时还原剪贴板（在独立线程里，不拖慢插字）。
fn schedule_restore(paste_id: u64, written_change_count: isize, snapshot: Option<appkit::PasteboardSnapshot>, previous_text: Option<String>) {
    let scheduled_at = Instant::now();
    std::thread::spawn(move || {
        std::thread::sleep(RESTORE_DELAY);
        let elapsed_ms = scheduled_at.elapsed().as_millis();
        let current_generation = PASTE_GENERATION.load(Ordering::Acquire);
        if current_generation != paste_id {
            write_log_line(&format!(
                "[RUST] [inject] clipboard restore skipped pasteId={paste_id} reason=superseded currentGeneration={current_generation} elapsedMs={elapsed_ms}"
            ));
            return;
        }
        // 用户或目标程序已经改写过剪贴板：不拿旧内容覆盖它
        let change_count = appkit::pasteboard_change_count();
        if change_count != written_change_count {
            write_log_line(&format!(
                "[RUST] [inject] clipboard restore skipped pasteId={paste_id} reason=clipboard_changed changeCount={change_count} written={written_change_count} elapsedMs={elapsed_ms}"
            ));
            return;
        }
        let (restored, mode, formats) = match &snapshot {
            Some(s) if !s.items.is_empty() => (appkit::pasteboard_restore(s, true), "all_formats", s.type_count()),
            Some(_) => (appkit::pasteboard_clear(), "was_empty", 0),
            None => match &previous_text {
                Some(text) => (appkit::pasteboard_set_text(text, true).is_ok(), "text_only", 1),
                None => (appkit::pasteboard_clear(), "text_only_empty", 0),
            },
        };
        write_log_line(&format!(
            "[RUST] [inject] clipboard restore finished pasteId={paste_id} restored={restored} mode={mode} formats={formats} elapsedMs={elapsed_ms}"
        ));
    });
}

fn do_inject(text: &str, target_pid: i32, restore_clipboard: bool) -> InjectResult {
    let paste_id = PASTE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;

    // 模拟按键需要「辅助功能」授权；没有授权时 CGEventPost 会被系统静默丢弃，
    // 那样会「显示成功、其实没插进去」。先判掉，交给兜底卡片（用户可以手动复制）。
    if !ax::is_trusted() {
        write_log_line(&format!("[RUST] [inject] accessibility not granted pasteId={paste_id}"));
        return result(false, "cmd_v", Some("accessibility_not_granted"), format!("pasteId={paste_id}"));
    }

    // 焦点还在不在录音开始时那个程序。target_pid=0 表示没探测到，不校验。
    let frontmost = appkit::frontmost_app();
    let frontmost_pid = frontmost.as_ref().map(|a| a.pid).unwrap_or(0);
    if target_pid > 0 && frontmost_pid > 0 && frontmost_pid != target_pid {
        write_log_line(&format!(
            "[RUST] [inject] foreground changed pasteId={paste_id} target_pid={target_pid} frontmost_pid={frontmost_pid} frontmost={}",
            frontmost.as_ref().map(|a| a.bundle_id.as_str()).unwrap_or("")
        ));
        return result(
            false,
            "cmd_v",
            Some("foreground_changed"),
            format!("pasteId={paste_id} targetPid={target_pid} frontmostPid={frontmost_pid}"),
        );
    }

    let previous_text = if restore_clipboard { appkit::pasteboard_get_text() } else { None };
    let snapshot = if restore_clipboard {
        appkit::pasteboard_snapshot(CLIPBOARD_SNAPSHOT_BUDGET, CLIPBOARD_SNAPSHOT_MAX_BYTES)
    } else {
        None
    };

    let written_change_count = match appkit::pasteboard_set_text(text, true) {
        Ok(count) => count,
        Err(why) => {
            write_log_line(&format!("[RUST] [inject] clipboard write failed pasteId={paste_id} {why}"));
            return result(false, "clipboard", Some("clipboard_blocked"), format!("pasteId={paste_id} {why}"));
        }
    };
    let clipboard_matches = appkit::pasteboard_get_text().as_deref() == Some(text);
    write_log_line(&format!(
        "[RUST] [inject] clipboard write ok pasteId={paste_id} utf8Len={} utf16Len={} clipboardMatches={clipboard_matches} restoreRequested={restore_clipboard} snapshotFormats={}",
        text.len(),
        text.encode_utf16().count(),
        snapshot.as_ref().map(|s| s.type_count() as i64).unwrap_or(-1),
    ));

    let posted = post_command_v();
    if restore_clipboard {
        schedule_restore(paste_id, written_change_count, snapshot, previous_text);
    }
    let bundle = frontmost.as_ref().map(|a| a.bundle_id.clone()).unwrap_or_default();
    match posted {
        Ok(()) => result(
            true,
            "cmd_v",
            None,
            format!("pasteId={paste_id} pid={frontmost_pid} bundle={bundle} textLen={}", text.len()),
        ),
        Err(why) => {
            write_log_line(&format!("[RUST] [inject] cmd+v failed pasteId={paste_id} {why}"));
            result(false, "cmd_v", Some("post_event_failed"), format!("pasteId={paste_id} {why}"))
        }
    }
}

/// `target_hwnd_val`：录音开始时探测到的前台应用 pid（mac 上 hwnd 字段装的就是 pid）。
pub fn inject_text_to_hwnd(text: &str, target_hwnd_val: isize, _focus_hwnd_val: isize, restore_clipboard: bool) -> InjectResult {
    do_inject(text, target_hwnd_val as i32, restore_clipboard)
}

pub fn inject_text(text: &str, restore_clipboard: bool) -> InjectResult {
    let ctx = crate::context::capture_context("inject");
    if ctx.pid == 0 {
        write_log_line("[RUST] [inject] no frontmost application");
        return InjectResult {
            ok: false,
            strategy: None,
            reason: Some("no_foreground_window".to_string()),
            detail: None,
            uncertain: false,
        };
    }
    let gate = super::editability_gate(&ctx);
    if !gate.is_editable() {
        return InjectResult {
            ok: false,
            strategy: Some("overlay_fallback".to_string()),
            reason: Some("not_editable".to_string()),
            detail: Some(super::describe_editability(&ctx, gate)),
            uncertain: false,
        };
    }
    do_inject(text, ctx.pid as i32, restore_clipboard)
}

/// 只写剪贴板（结果卡的「复制」、不可输入时的兜底）。复制是用户要的，正常进剪贴板历史。
pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    appkit::pasteboard_set_text(text, false).map(|_| ())
}

// ─── 「这里能不能打字」的 mac 判据 ───

/// 明确是文本输入的 AX 角色。
fn is_text_role(role: &str) -> bool {
    matches!(role, "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField")
}

/// 明确不是输入区域的 AX 角色（按钮、菜单、列表……）。
fn is_definitely_not_editable(role: &str) -> bool {
    matches!(
        role,
        "AXButton"
            | "AXMenuItem"
            | "AXMenuBar"
            | "AXMenuBarItem"
            | "AXMenu"
            | "AXMenuButton"
            | "AXPopUpButton"
            | "AXTabGroup"
            | "AXToolbar"
            | "AXScrollBar"
            | "AXImage"
            | "AXLink"
            | "AXCheckBox"
            | "AXRadioButton"
            | "AXSlider"
            | "AXDisclosureTriangle"
            | "AXList"
            | "AXTable"
            | "AXOutline"
            | "AXRow"
            | "AXCell"
            | "AXBrowser"
            | "AXDockItem"
    )
}

/// 按 Bundle ID / 可执行文件名放行的常用程序（对应 Windows 的进程名白名单）。
/// Electron / Qt / 自绘界面的程序常常拿不到可用的 AX 信息，只能靠这一层。
const EDITABLE_APP_TOKENS: &[&str] = &[
    // 浏览器
    "chrome", "safari", "firefox", "edgemac", "brave", "thebrowser", "opera", "vivaldi",
    // 编辑器 / IDE
    "vscode", "todesktop", "cursor", "windsurf", "kiro", "jetbrains", "xcode", "sublime", "zed",
    "notion", "obsidian",
    // 聊天 / 办公
    "xinwechat", "wechat", "tencent.qq", "wework", "lark", "feishu", "dingtalk", "slack",
    "teams", "telegram", "discord", "outlook", "microsoft.word", "microsoft.excel",
    "microsoft.powerpoint", "iwork", "apple.notes", "textedit",
    // 终端
    "apple.terminal", "iterm", "warp", "wezterm", "kitty", "ghostty", "alacritty",
];

fn is_allowlisted(bundle_id: &str, process_name: &str) -> bool {
    EDITABLE_APP_TOKENS
        .iter()
        .any(|token| bundle_id.contains(token) || process_name.contains(token))
}

/// macOS 的可编辑判据。比 Windows 乐观：⌘V 打到不能输入的地方只会「嘟」一声，
/// 而误判成不可编辑会让每一次口述都要从兜底卡片手动粘贴；只有拿到明确的否定信号才拒绝。
pub fn editability_gate(ctx: &crate::context::AppContext) -> super::EditableGate {
    use super::EditableGate;
    let role = ctx.control_type.as_str();
    let bundle = ctx.bundle_id.to_lowercase();
    let process = ctx.process_name.to_lowercase();
    let text_role = is_text_role(role) || ctx.focus_class == "AXSecureTextField";

    // Finder（含桌面）：只有重命名框、搜索框这类文本框才是输入目标（对应 explorer 桌面）
    if bundle == "com.apple.finder" && !text_role {
        return EditableGate::ExplorerDesktopReject;
    }
    if text_role && ctx.is_enabled {
        return EditableGate::UiaEditableControl;
    }
    if ctx.has_caret && ctx.is_enabled {
        return EditableGate::Caret;
    }
    if is_allowlisted(&bundle, &process) {
        return EditableGate::ProcessAllowlist;
    }
    // 辅助功能没给出任何信息（未授权、程序不支持无障碍）：不当成否定
    if role.is_empty() {
        return EditableGate::AxOptimistic;
    }
    if is_definitely_not_editable(role) || !ctx.is_enabled {
        return EditableGate::NoSignal;
    }
    EditableGate::AxOptimistic
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::AppContext;
    use crate::inject::EditableGate;

    fn ctx(bundle: &str, role: &str) -> AppContext {
        AppContext {
            bundle_id: bundle.to_string(),
            process_name: bundle.rsplit('.').next().unwrap_or("").to_string(),
            control_type: role.to_string(),
            is_enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn text_fields_are_editable_everywhere() {
        assert_eq!(editability_gate(&ctx("com.example.app", "AXTextArea")), EditableGate::UiaEditableControl);
        assert_eq!(editability_gate(&ctx("com.apple.finder", "AXTextField")), EditableGate::UiaEditableControl);
    }

    #[test]
    fn finder_desktop_and_lists_are_rejected() {
        assert_eq!(editability_gate(&ctx("com.apple.finder", "AXList")), EditableGate::ExplorerDesktopReject);
        assert_eq!(editability_gate(&ctx("com.apple.finder", "")), EditableGate::ExplorerDesktopReject);
    }

    #[test]
    fn known_apps_pass_even_without_ax_details() {
        assert_eq!(editability_gate(&ctx("com.tencent.xinWeChat", "AXGroup")), EditableGate::ProcessAllowlist);
        assert_eq!(editability_gate(&ctx("com.microsoft.VSCode", "AXWindow")), EditableGate::ProcessAllowlist);
        assert_eq!(editability_gate(&ctx("com.googlecode.iterm2", "")), EditableGate::ProcessAllowlist);
    }

    #[test]
    fn buttons_in_unknown_apps_are_rejected_but_missing_ax_is_optimistic() {
        assert_eq!(editability_gate(&ctx("com.example.player", "AXButton")), EditableGate::NoSignal);
        assert_eq!(editability_gate(&ctx("com.example.player", "")), EditableGate::AxOptimistic);
        assert_eq!(editability_gate(&ctx("com.example.player", "AXGroup")), EditableGate::AxOptimistic);
    }

    #[test]
    fn keycode_for_v_is_a_valid_keycode() {
        assert!(keycode_for_v() < 128);
    }
}
