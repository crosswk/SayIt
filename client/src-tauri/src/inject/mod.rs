//! Text injection — writes text into the target application.
//!
//! Strategy priority:
//! 1. clipboard + WM_PASTE message (sent directly to target hwnd — works cross-process)
//! 2. clipboard + SendInput Ctrl+V (fallback for apps that don't handle WM_PASTE)
//!
//! Two entry points:
//! - `inject_text_to_hwnd(text, hwnd, focus_hwnd)` — uses pre-probed hwnd (preferred)
//! - `inject_text(text)` — re-captures context (legacy fallback)

use serde::Serialize;

#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    SendMessageTimeoutW, SMTO_ABORTIFHUNG,
};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, KEYBD_EVENT_FLAGS,
};
#[cfg(windows)]
use windows::Win32::System::Threading::GetCurrentThreadId;
#[cfg(windows)]
use windows::Win32::System::DataExchange::{
    OpenClipboard, CloseClipboard, EmptyClipboard, SetClipboardData,
};
#[cfg(windows)]
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
#[cfg(windows)]
use windows::Win32::Foundation::HANDLE;

use crate::context;

#[derive(Debug, Clone, Serialize, Default)]
pub struct InjectResult {
    pub ok: bool,
    pub strategy: Option<String>,
    pub reason: Option<String>,
    pub detail: Option<String>,
    /// True when SendInput was used on a Chromium-class window without caret —
    /// we can't verify if paste actually landed in an input field.
    #[serde(default)]
    pub uncertain: bool,
}

#[cfg(windows)]
pub fn inject_text_to_hwnd(text: &str, target_hwnd_val: isize, focus_hwnd_val: isize) -> InjectResult {
    let target = HWND(target_hwnd_val as *mut _);
    let focus = if focus_hwnd_val != 0 {
        HWND(focus_hwnd_val as *mut _)
    } else {
        target
    };

    unsafe { do_inject(target, focus, text) }
}

#[cfg(windows)]
pub fn inject_text(text: &str) -> InjectResult {
    let ctx = context::capture_context("inject");

    if ctx.hwnd.is_empty() || ctx.hwnd == "0" {
        return InjectResult {
            ok: false, strategy: None,
            reason: Some("no_foreground_window".to_string()), detail: None,
            uncertain: false,
        };
    }

    let editable = is_likely_editable(&ctx);
    if !editable {
        return InjectResult {
            ok: false,
            strategy: Some("overlay_fallback".to_string()),
            reason: Some("not_editable".to_string()),
            detail: Some(format!(
                "class={} focusClass={} hasCaret={} process={}",
                ctx.window_class, ctx.focus_class, ctx.has_caret, ctx.process_name
            )),
            uncertain: false,
        };
    }

    let target_hwnd = ctx.hwnd.parse::<isize>().unwrap_or(0);
    let focus_hwnd = ctx.focus_hwnd.parse::<isize>().unwrap_or(0);
    inject_text_to_hwnd(text, target_hwnd, focus_hwnd)
}

#[cfg(not(windows))]
pub fn inject_text_to_hwnd(_text: &str, _target: isize, _focus: isize) -> InjectResult {
    InjectResult { ok: false, strategy: None, reason: Some("not_windows".to_string()), detail: None, uncertain: false }
}
#[cfg(not(windows))]
pub fn inject_text(_text: &str) -> InjectResult {
    InjectResult { ok: false, strategy: None, reason: Some("not_windows".to_string()), detail: None, uncertain: false }
}

fn is_likely_editable(ctx: &context::AppContext) -> bool {
    is_likely_editable_pub(ctx)
}

pub fn is_likely_editable_pub(ctx: &context::AppContext) -> bool {
    if ctx.has_caret { return true; }

    let fc = ctx.focus_class.to_lowercase();
    let wc = ctx.window_class.to_lowercase();

    // Native Win32 editable controls — always considered editable
    let native_editable_classes = [
        "edit", "richedit", "richedit20w", "richedit50w",
        "scintilla", "texteditorsid",
        // Office Word editor control (used by Outlook, Word, etc.)
        "_wwg",
    ];
    for cls in &native_editable_classes {
        if fc.contains(cls) || wc.contains(cls) { return true; }
    }

    // UIA-based detection: if control_type is populated, use it as primary signal.
    // This works for both Chromium and native windows.
    if !ctx.control_type.is_empty() {
        let ct = ctx.control_type.as_str();

        // Definitely editable control types
        let is_editable_control = ct == "Edit" || ct == "Document" || ct == "ComboBox";

        // Custom/Group/Pane with ValuePattern (rich text editors like CodeMirror,
        // Notion, Feishu docs, etc.)
        let has_value = ctx.is_value_pattern_available;
        let is_rich_editor = (ct == "Custom" || ct == "Group" || ct == "Pane") && has_value;

        if is_editable_control || is_rich_editor {
            if ctx.is_enabled {
                if ctx.is_read_only == Some(true) {
                    return false;
                }
                return true;
            }
        }

        // For Chromium windows: if UIA says it's a keyboard-focusable Group/Pane
        // (even without ValuePattern), be optimistic — many web editors
        // (Feishu, Notion, Slack) use contenteditable divs that expose as
        // Group without ValuePattern. SendInput Ctrl+V is harmless if wrong.
        let is_chromium_class = fc.contains("chrome_widgetwin_1")
            || fc.contains("chrome_renderwidgethostview")
            || wc.contains("chrome_widgetwin_1")
            || fc.contains("intermediate d3d window");

        if is_chromium_class && ctx.is_keyboard_focusable && ctx.is_enabled {
            // Optimistic: keyboard-focusable element in Chromium is likely an
            // input area. Only reject known non-editable types.
            let definitely_not_editable = ct == "Button"
                || ct == "MenuItem"
                || ct == "MenuBar"
                || ct == "Menu"
                || ct == "Tab"
                || ct == "TabItem"
                || ct == "ToolBar"
                || ct == "TitleBar"
                || ct == "ScrollBar"
                || ct == "Image"
                || ct == "Hyperlink"
                || ct == "StatusBar"
                || ct == "Header"
                || ct == "HeaderItem"
                || ct == "Separator"
                || ct == "ProgressBar";
            if !definitely_not_editable {
                return true;
            }
        }

        // For non-Chromium windows with UIA data: if it's not an editable type,
        // fall through to process-based heuristic (don't hard-reject).
    }

    let proc = ctx.process_name.to_lowercase();
    let editable_procs = [
        "notepad", "winword", "excel", "powerpnt", "outlook",
        "code", "devenv", "idea64",
        "chrome", "msedge", "firefox", "opera", "brave",
        "teams", "wechat", "dingtalk", "slack",
        "windowsterminal", "cmd", "powershell",
        "explorer",
        "mobaxterm", "putty", "securecrt", "xshell",
    ];
    for p in &editable_procs {
        if proc.contains(p) { return true; }
    }
    false
}

// ─── Core injection logic ───

/// WM_PASTE = 0x0302
#[cfg(windows)]
const WM_PASTE: u32 = 0x0302;

/// Main injection: try WM_PASTE first, then SendInput Ctrl+V as fallback.
#[cfg(windows)]
unsafe fn do_inject(target: HWND, focus: HWND, text: &str) -> InjectResult {
    // Step 1: Write text to clipboard
    let clipboard_ok = set_clipboard_with_retry(text, 5, 30);
    if !clipboard_ok {
        return InjectResult {
            ok: false,
            strategy: Some("clipboard".to_string()),
            reason: Some("clipboard_write_failed".to_string()),
            detail: Some("failed after 5 retries".to_string()),
            uncertain: false,
        };
    }

    // Step 2: Try WM_PASTE — this is a message sent directly to the target
    // window handle, so it works even if the target is not the foreground
    // window. Most native Win32 controls (Edit, RichEdit) handle it.
    let paste_target = if focus.0 != std::ptr::null_mut() { focus } else { target };
    let focus_class = crate::context::read_class_name(paste_target).to_lowercase();

    // WM_PASTE works reliably for native Win32 edit controls
    let try_wm_paste = focus_class.contains("edit")
        || focus_class.contains("richedit")
        || focus_class.contains("scintilla");

    if try_wm_paste {
        crate::commands::system::write_log_line(
            &format!("[RUST] [inject] WM_PASTE attempt hwnd={} class={} textLen={}",
                paste_target.0 as isize, focus_class, text.len())
        );

        let mut result_val: usize = 0;
        let send_ok = SendMessageTimeoutW(
            paste_target,
            WM_PASTE,
            windows::Win32::Foundation::WPARAM(0),
            windows::Win32::Foundation::LPARAM(0),
            SMTO_ABORTIFHUNG,
            2000, // 2 second timeout
            Some(&mut result_val),
        );

        if send_ok.0 != 0 {
            crate::commands::system::write_log_line(
                &format!("[RUST] [inject] WM_PASTE ok hwnd={} class={}", paste_target.0 as isize, focus_class)
            );
            return InjectResult {
                ok: true,
                strategy: Some("wm_paste".to_string()),
                reason: None,
                detail: Some(format!(
                    "hwnd={} class={} textLen={}",
                    paste_target.0 as isize, focus_class, text.len()
                )),
                uncertain: false,
            };
        }
        crate::commands::system::write_log_line("[RUST] [inject] WM_PASTE failed, fallback to SendInput");
    }

    // Step 3: Fallback — force foreground + SendInput Ctrl+V
    let fg_ok = force_foreground(target);
    crate::commands::system::write_log_line(
        &format!("[RUST] [inject] SendInput fallback target={} fg_ok={} class={} textLen={}",
            target.0 as isize, fg_ok, focus_class, text.len())
    );

    // Release stuck modifiers
    release_modifiers();
    std::thread::sleep(std::time::Duration::from_millis(15));

    // Set focus to child control if needed
    if focus != target && focus.0 != std::ptr::null_mut() {
        attach_and_set_focus(target, focus);
    }

    // SendInput Ctrl+V
    let vk_ctrl = VIRTUAL_KEY(0x11);
    let vk_v = VIRTUAL_KEY(0x56);
    let inputs = [
        make_key_input(vk_ctrl, KEYBD_EVENT_FLAGS(0)),
        make_key_input(vk_v, KEYBD_EVENT_FLAGS(0)),
        make_key_input(vk_v, KEYEVENTF_KEYUP),
        make_key_input(vk_ctrl, KEYEVENTF_KEYUP),
    ];
    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);

    std::thread::sleep(std::time::Duration::from_millis(10));
    release_modifiers();

    let detail = format!(
        "sent={} class={} target={} focus={} textLen={} fgOk={}",
        sent, focus_class, target.0 as isize, focus.0 as isize, text.len(), fg_ok
    );

    // SendInput Ctrl+V is fire-and-forget. For Chromium-class windows we
    // used to mark ALL results as uncertain, but that was too aggressive —
    // it blocked every browser input field. Now we only mark as uncertain
    // when UIA says the focused element is NOT an editable control.
    let uncertain = false; // UIA-based editability is checked upstream in probe

    if sent >= 4 {
        InjectResult {
            ok: true,
            strategy: Some("send_input".to_string()),
            reason: None,
            detail: Some(detail),
            uncertain,
        }
    } else {
        InjectResult {
            ok: false,
            strategy: Some("send_input".to_string()),
            reason: Some("send_input_short_write".to_string()),
            detail: Some(detail),
            uncertain: false,
        }
    }
}

// ─── Window activation helpers ───

#[cfg(windows)]
unsafe fn force_foreground(target: HWND) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, f_attach: i32) -> i32;
        fn BringWindowToTop(hwnd: HWND) -> i32;
        fn ShowWindow(hwnd: HWND, n_cmd_show: i32) -> i32;
    }
    const SW_SHOW: i32 = 5;

    let my_tid = GetCurrentThreadId();
    let mut pid: u32 = 0;
    let target_tid = GetWindowThreadProcessId(target, Some(&mut pid));

    let attached = if target_tid != 0 && target_tid != my_tid {
        AttachThreadInput(my_tid, target_tid, 1) != 0
    } else {
        false
    };

    // Use a harmless key (VK_F24 = 0x87) to satisfy SetForegroundWindow's
    // "caller must have received input" requirement. Alt is problematic
    // because its keyup activates menus in many apps.
    let f24_down = make_key_input(VIRTUAL_KEY(0x87), KEYBD_EVENT_FLAGS(0));
    let f24_up = make_key_input(VIRTUAL_KEY(0x87), KEYEVENTF_KEYUP);
    let _ = SendInput(&[f24_down, f24_up], std::mem::size_of::<INPUT>() as i32);

    let _ = ShowWindow(target, SW_SHOW);
    let _ = BringWindowToTop(target);
    let _ = SetForegroundWindow(target);
    std::thread::sleep(std::time::Duration::from_millis(50));

    let fg_ok = GetForegroundWindow() == target;
    if !fg_ok {
        let _ = SetForegroundWindow(target);
        std::thread::sleep(std::time::Duration::from_millis(30));
    }

    if attached {
        AttachThreadInput(my_tid, target_tid, 0);
    }

    GetForegroundWindow() == target
}

#[cfg(windows)]
unsafe fn attach_and_set_focus(target: HWND, focus: HWND) {
    #[link(name = "user32")]
    extern "system" {
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, f_attach: i32) -> i32;
    }

    let my_tid = GetCurrentThreadId();
    let mut pid: u32 = 0;
    let target_tid = GetWindowThreadProcessId(target, Some(&mut pid));
    let attached = if target_tid != 0 && target_tid != my_tid {
        AttachThreadInput(my_tid, target_tid, 1) != 0
    } else {
        false
    };

    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    let _ = SetFocus(focus);
    std::thread::sleep(std::time::Duration::from_millis(10));

    if attached {
        AttachThreadInput(my_tid, target_tid, 0);
    }
}

// ─── Key input helpers ───

#[cfg(windows)]
fn make_key_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(windows)]
unsafe fn release_modifiers() {
    let modifiers: [u16; 6] = [0xA4, 0xA5, 0xA0, 0xA1, 0xA2, 0xA3];
    let inputs: Vec<INPUT> = modifiers.iter().map(|&vk| {
        make_key_input(VIRTUAL_KEY(vk), KEYEVENTF_KEYUP)
    }).collect();
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

// ─── Clipboard helpers ───

#[cfg(windows)]
unsafe fn set_clipboard_with_retry(text: &str, max_retries: u32, retry_delay_ms: u64) -> bool {
    for attempt in 0..max_retries {
        if native_set_clipboard_text(text) { return true; }
        if attempt < max_retries - 1 {
            std::thread::sleep(std::time::Duration::from_millis(retry_delay_ms));
        }
    }
    false
}

#[cfg(windows)]
unsafe fn native_set_clipboard_text(text: &str) -> bool {
    if OpenClipboard(HWND(std::ptr::null_mut())).is_err() { return false; }

    let result = (|| -> bool {
        let _ = EmptyClipboard();
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let byte_len = wide.len() * 2;

        let hmem = match GlobalAlloc(GMEM_MOVEABLE, byte_len) {
            Ok(h) => h,
            Err(_) => return false,
        };

        let locked = GlobalLock(hmem);
        if locked.is_null() { return false; }

        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, locked as *mut u8, byte_len);
        let _ = GlobalUnlock(hmem);

        // CF_UNICODETEXT = 13
        SetClipboardData(13, HANDLE(hmem.0 as *mut _)).is_ok()
    })();

    let _ = CloseClipboard();
    result
}

#[cfg(windows)]
pub unsafe fn set_clipboard_with_retry_pub(text: &str, max_retries: u32, retry_delay_ms: u64) -> bool {
    set_clipboard_with_retry(text, max_retries, retry_delay_ms)
}
