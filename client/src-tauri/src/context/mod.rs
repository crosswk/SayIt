//! Window context detection — captures information about the foreground window
//! and focused element to determine text injection strategy.
//! Also runs a WinEvent hook to push context updates when the foreground window changes.

#[cfg(target_os = "macos")]
mod macos;

use serde::Serialize;
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::sync::atomic::Ordering;
#[cfg(windows)]
use std::thread;
use tauri::AppHandle;
#[cfg(windows)]
use tauri::Manager;

#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowTextW, GetWindowThreadProcessId,
    GUITHREADINFO,
};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextContext {
    /// UI Automation pattern used to obtain the text. Useful for diagnostics only.
    pub source: String,
    /// Text immediately before the caret/selection. Capped locally before serialization.
    pub text_before: String,
    /// Selected text. Empty means this is ordinary dictation rather than an edit command.
    pub selected_text: String,
    /// Text immediately after the caret/selection. Capped locally before serialization.
    pub text_after: String,
    /// A large selection is deliberately not sent to AI, because replacing a partial selection
    /// would risk data loss.
    pub selection_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AppContext {
    pub reason: String,
    pub timestamp: i64,
    pub hwnd: String,
    pub pid: u32,
    pub tid: u32,
    #[serde(rename = "processName")]
    pub process_name: String,
    #[serde(rename = "exePath")]
    pub exe_path: String,
    #[serde(rename = "windowTitle")]
    pub window_title: String,
    #[serde(rename = "windowClass")]
    pub window_class: String,
    #[serde(rename = "focusHwnd")]
    pub focus_hwnd: String,
    #[serde(rename = "focusClass")]
    pub focus_class: String,
    #[serde(rename = "hasCaret")]
    pub has_caret: bool,
    #[serde(rename = "controlType")]
    pub control_type: String,
    #[serde(rename = "automationId")]
    pub automation_id: String,
    #[serde(rename = "isValuePatternAvailable")]
    pub is_value_pattern_available: bool,
    #[serde(rename = "isTextPatternAvailable")]
    pub is_text_pattern_available: bool,
    #[serde(rename = "isTextPattern2Available")]
    pub is_text_pattern2_available: bool,
    #[serde(rename = "isKeyboardFocusable")]
    pub is_keyboard_focusable: bool,
    #[serde(rename = "isEnabled")]
    pub is_enabled: bool,
    #[serde(rename = "isReadOnly")]
    pub is_read_only: Option<bool>,
    #[serde(rename = "isPassword")]
    pub is_password: bool,
    /// macOS 的 Bundle ID（如 `com.tencent.xinWeChat`）。Windows 上为空，不进载荷。
    #[serde(rename = "bundleId", skip_serializing_if = "String::is_empty")]
    pub bundle_id: String,
    /// Present only when the user explicitly enabled context-aware writing. Ordinary foreground
    /// tracking and diagnostics never read or retain editor text.
    #[serde(rename = "textContext", skip_serializing_if = "Option::is_none")]
    pub text_context: Option<TextContext>,
}

/// 前台窗口所在显示器的物理工作区，已排除任务栏。
#[derive(Debug, Clone)]
pub struct MonitorBounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub source: String,
}

pub struct ContextDetector {
    #[cfg_attr(not(windows), allow(dead_code))]
    winevent_running: AtomicBool,
}

impl ContextDetector {
    pub fn new() -> Self {
        Self {
            winevent_running: AtomicBool::new(false),
        }
    }

    /// Capture the current foreground window context
    pub fn capture(&self, reason: &str) -> AppContext {
        capture_context_with_text(reason, false)
    }

    /// Capture the recording target, optionally including a bounded slice of editor text.
    /// This separate entry point is intentional: WinEvent hooks must never start reading text
    /// merely because the feature exists.
    pub fn capture_recording(&self, reason: &str, include_text_context: bool) -> AppContext {
        capture_context_with_text(reason, include_text_context)
    }

    /// 监听前台窗口切换：切换后若悬浮窗正显示，把它重新顶回最上层
    /// （用户切到 PotPlayer 这类置顶程序时，悬浮窗会被压下去）。
    ///
    /// 只做这一件事。原来这里还挂了 EVENT_OBJECT_FOCUS，并且每次切换都完整采集一遍
    /// 前台上下文（进程路径 + UI Automation）再广播给全部 webview —— 可前端没有任何
    /// 地方订阅那个事件，录音和插字时都会重新采集。代价却不小：方向键在列表里移动都会触发，
    /// 而 UIA 查询会让 Chrome / VS Code / 微信这类程序打开自己的无障碍树，跟着多耗 CPU 和内存。
    #[cfg(windows)]
    pub fn start_winevent_hook(&self, app: &AppHandle) {
        if self.winevent_running.swap(true, Ordering::SeqCst) {
            return; // already running
        }

        let app_handle = app.clone();

        thread::spawn(move || {
            use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, GetMessageW, TranslateMessage, MSG,
            };

            const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
            const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;

            thread_local! {
                static APP: std::cell::RefCell<Option<AppHandle>> = std::cell::RefCell::new(None);
            }
            APP.with(|a| *a.borrow_mut() = Some(app_handle));

            unsafe extern "system" fn winevent_proc(
                _hook: HWINEVENTHOOK,
                _event: u32,
                _hwnd: HWND,
                _id_object: i32,
                _id_child: i32,
                _event_thread: u32,
                _event_time: u32,
            ) {
                APP.with(|a| {
                    let Some(app) = a.borrow().as_ref().cloned() else { return };
                    let state = app.state::<crate::window::WindowState>();
                    if !state.overlay_visible() {
                        return;
                    }
                    // 等新前台窗口自己完成置顶再顶回来，否则会被它随后的 SetWindowPos 压回去。
                    // 这 50ms 是原来就有的节奏，只在悬浮窗显示时才等。
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    state.reassert_overlay_topmost_if_visible(&app);
                });
            }

            unsafe {
                let _fg_hook = SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    None,
                    Some(winevent_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                );

                // Message loop required for WinEvent hooks
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
    }

    #[cfg(not(windows))]
    pub fn start_winevent_hook(&self, _app: &AppHandle) {}
}

/// Standalone capture function (no &self needed, usable from callbacks)
#[cfg(windows)]
pub fn capture_context(reason: &str) -> AppContext {
    capture_context_with_text(reason, false)
}

#[cfg(windows)]
fn capture_context_with_text(reason: &str, include_text_context: bool) -> AppContext {
    let mut ctx = AppContext {
        reason: reason.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };

    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0 == std::ptr::null_mut() {
            return ctx;
        }
        ctx.hwnd = format!("{}", foreground.0 as isize);

        let mut pid: u32 = 0;
        let tid = GetWindowThreadProcessId(foreground, Some(&mut pid));
        ctx.pid = pid;
        ctx.tid = tid;
        ctx.window_title = read_window_text(foreground);
        ctx.window_class = read_class_name(foreground);
        ctx.process_name = get_process_name(pid);
        ctx.exe_path = get_process_path(pid);

        let mut gui_info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gui_info).is_ok() {
            let focus = gui_info.hwndFocus;
            if focus.0 != std::ptr::null_mut() {
                ctx.focus_hwnd = format!("{}", focus.0 as isize);
                ctx.focus_class = read_class_name(focus);
            }
            let caret = gui_info.hwndCaret;
            if caret.0 != std::ptr::null_mut() {
                let rc = gui_info.rcCaret;
                ctx.has_caret = (rc.right - rc.left) > 0 || (rc.bottom - rc.top) > 0;
            }
        }

        // UI Automation: get focused element's ControlType, ValuePattern, etc.
        // This is critical for Chromium-class windows where GetGUIThreadInfo
        // doesn't report caret/focus reliably.
        populate_uia_fields(&mut ctx, include_text_context);
    }
    ctx
}

/// 捕获当前前台窗口所在显示器的物理工作区。
#[cfg(windows)]
pub fn capture_foreground_monitor() -> Option<MonitorBounds> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0 == std::ptr::null_mut() {
            return None;
        }

        let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }

        let work = info.rcWork;
        if work.right <= work.left || work.bottom <= work.top {
            return None;
        }

        Some(MonitorBounds {
            left: work.left,
            top: work.top,
            right: work.right,
            bottom: work.bottom,
            source: "foreground_window".to_string(),
        })
    }
}

/// Use Windows UI Automation to query the focused element's properties.
/// Populates control_type, automation_id, is_value_pattern_available,
/// is_keyboard_focusable, is_enabled, is_read_only in AppContext.
#[cfg(windows)]
unsafe fn populate_uia_fields(ctx: &mut AppContext, include_text_context: bool) {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, UIA_AutomationIdPropertyId, UIA_ControlTypePropertyId,
        UIA_IsEnabledPropertyId, UIA_IsKeyboardFocusablePropertyId, UIA_IsPasswordPropertyId,
        UIA_IsTextPattern2AvailablePropertyId, UIA_IsTextPatternAvailablePropertyId,
        UIA_IsValuePatternAvailablePropertyId, UIA_ValueIsReadOnlyPropertyId,
    };
    // CoInitialize for this thread (may already be initialized — that's ok)
    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<(), String> {
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("CoCreateInstance CUIAutomation: {}", e))?;

        let focused = uia
            .GetFocusedElement()
            .map_err(|e| format!("GetFocusedElement: {}", e))?;

        // ControlType (int → string name)
        let ct_val = focused.GetCurrentPropertyValue(UIA_ControlTypePropertyId);
        if let Ok(v) = ct_val {
            if let Ok(ct_id) = i32::try_from(&v) {
                ctx.control_type = uia_control_type_name(ct_id);
            }
        }

        // AutomationId
        let aid_val = focused.GetCurrentPropertyValue(UIA_AutomationIdPropertyId);
        if let Ok(v) = aid_val {
            if let Ok(bstr) = windows::core::BSTR::try_from(&v) {
                ctx.automation_id = bstr.to_string();
            }
        }

        // IsValuePatternAvailable
        let vp_val = focused.GetCurrentPropertyValue(UIA_IsValuePatternAvailablePropertyId);
        if let Ok(v) = vp_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_value_pattern_available = b;
            }
        }

        let tp_val = focused.GetCurrentPropertyValue(UIA_IsTextPatternAvailablePropertyId);
        if let Ok(v) = tp_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_text_pattern_available = b;
            }
        }

        let tp2_val = focused.GetCurrentPropertyValue(UIA_IsTextPattern2AvailablePropertyId);
        if let Ok(v) = tp2_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_text_pattern2_available = b;
            }
        }

        // Password controls are a hard boundary. Never ask a pattern for their value or text,
        // even when the user enabled context-aware writing globally.
        let password_val = focused.GetCurrentPropertyValue(UIA_IsPasswordPropertyId);
        if let Ok(v) = password_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_password = b;
            }
        }

        // IsKeyboardFocusable
        let kf_val = focused.GetCurrentPropertyValue(UIA_IsKeyboardFocusablePropertyId);
        if let Ok(v) = kf_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_keyboard_focusable = b;
            }
        }

        // IsEnabled
        let en_val = focused.GetCurrentPropertyValue(UIA_IsEnabledPropertyId);
        if let Ok(v) = en_val {
            if let Ok(b) = bool::try_from(&v) {
                ctx.is_enabled = b;
            }
        }

        // Value.IsReadOnly (only meaningful if ValuePattern is available)
        if ctx.is_value_pattern_available {
            let ro_val = focused.GetCurrentPropertyValue(UIA_ValueIsReadOnlyPropertyId);
            if let Ok(v) = ro_val {
                if let Ok(b) = bool::try_from(&v) {
                    ctx.is_read_only = Some(b);
                }
            }
        }

        if include_text_context && !ctx.is_password && ctx.is_enabled {
            ctx.text_context = capture_uia_text_context(&uia, &focused);
        }

        Ok(())
    })();

    if let Err(e) = result {
        log::debug!("UIA populate failed (non-fatal): {}", e);
    }

    if need_co_uninit {
        CoUninitialize();
    }
}

#[cfg(windows)]
const TEXT_BEFORE_LIMIT: i32 = 500;
#[cfg(windows)]
const TEXT_AFTER_LIMIT: i32 = 300;
#[cfg(windows)]
const SELECTED_TEXT_LIMIT: i32 = 6000;

/// Read a small, caret-relative slice rather than the whole document. TextPattern is attempted on
/// the focused element and a few ancestors because Chromium/Office often put it on the enclosing
/// Document element. ValuePattern is a conservative fallback for simple inputs and is treated as
/// text-before-caret only (most such controls expose no selection/caret API through UIA).
#[cfg(windows)]
unsafe fn capture_uia_text_context(
    uia: &windows::Win32::UI::Accessibility::IUIAutomation,
    focused: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<TextContext> {
    use windows::core::Interface;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationElement, IUIAutomationTextPattern, IUIAutomationTextPattern2,
        IUIAutomationValuePattern, UIA_TextPattern2Id, UIA_TextPatternId, UIA_ValuePatternId,
    };

    let mut element: IUIAutomationElement = focused.clone();
    let walker = uia.RawViewWalker().ok();
    let value_fallback = focused
        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        .ok()
        .and_then(|pattern| pattern.CurrentValue().ok())
        .map(|value| sanitize_uia_text(&value.to_string()))
        .filter(|value| !value.is_empty());

    for _depth in 0..=4 {
        if let Ok(pattern2) =
            element.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)
        {
            let mut active = windows::Win32::Foundation::BOOL::default();
            let caret = pattern2
                .GetCaretRange(&mut active)
                .ok()
                .filter(|_| active.as_bool());
            let base: IUIAutomationTextPattern = pattern2.cast().ok()?;
            if let Some(context) = text_context_from_pattern(&base, caret, "text_pattern2") {
                return Some(context);
            }
        }

        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
        {
            if let Some(context) = text_context_from_pattern(&pattern, None, "text_pattern") {
                return Some(context);
            }
        }

        let Some(ref tree_walker) = walker else { break };
        let Ok(parent) = tree_walker.GetParentElement(&element) else {
            break;
        };
        element = parent;
    }

    value_fallback.map(|value| TextContext {
        source: "value_pattern_tail".to_string(),
        text_before: tail_chars(&value, TEXT_BEFORE_LIMIT as usize),
        ..Default::default()
    })
}

#[cfg(windows)]
unsafe fn text_context_from_pattern(
    pattern: &windows::Win32::UI::Accessibility::IUIAutomationTextPattern,
    caret: Option<windows::Win32::UI::Accessibility::IUIAutomationTextRange>,
    source: &str,
) -> Option<TextContext> {
    use windows::Win32::UI::Accessibility::IUIAutomationTextRange;

    let selection_range = pattern.GetSelection().ok().and_then(|ranges| {
        (ranges.Length().ok().unwrap_or(0) > 0)
            .then(|| ranges.GetElement(0).ok())
            .flatten()
    });

    let mut selected_text = String::new();
    let mut selection_truncated = false;
    if let Some(ref range) = selection_range {
        if let Ok(text) = range.GetText(SELECTED_TEXT_LIMIT + 1) {
            let raw = sanitize_uia_text(&text.to_string());
            if raw.chars().count() > SELECTED_TEXT_LIMIT as usize {
                // Do not send a partial selection to AI: its output would replace the complete
                // selection and could silently discard content it never saw.
                selection_truncated = true;
            } else if !raw.trim().is_empty() {
                selected_text = raw;
            }
        }
    }

    let anchor: IUIAutomationTextRange = if !selected_text.is_empty() {
        selection_range.clone()?
    } else {
        caret.or(selection_range)?
    };

    let text_before = text_before_range(&anchor).unwrap_or_default();
    let text_after = text_after_range(&anchor).unwrap_or_default();
    if text_before.is_empty()
        && selected_text.is_empty()
        && text_after.is_empty()
        && !selection_truncated
    {
        return None;
    }

    Some(TextContext {
        source: source.to_string(),
        text_before,
        selected_text,
        text_after,
        selection_truncated,
    })
}

#[cfg(windows)]
unsafe fn text_before_range(
    anchor: &windows::Win32::UI::Accessibility::IUIAutomationTextRange,
) -> Option<String> {
    use windows::Win32::UI::Accessibility::{
        TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    };
    let range = anchor.Clone().ok()?;
    range
        .MoveEndpointByRange(
            TextPatternRangeEndpoint_End,
            anchor,
            TextPatternRangeEndpoint_Start,
        )
        .ok()?;
    range
        .MoveEndpointByRange(
            TextPatternRangeEndpoint_Start,
            anchor,
            TextPatternRangeEndpoint_Start,
        )
        .ok()?;
    let _ = range.MoveEndpointByUnit(
        TextPatternRangeEndpoint_Start,
        TextUnit_Character,
        -TEXT_BEFORE_LIMIT,
    );
    range
        .GetText(TEXT_BEFORE_LIMIT)
        .ok()
        .map(|v| sanitize_uia_text(&v.to_string()))
}

#[cfg(windows)]
unsafe fn text_after_range(
    anchor: &windows::Win32::UI::Accessibility::IUIAutomationTextRange,
) -> Option<String> {
    use windows::Win32::UI::Accessibility::{
        TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    };
    let range = anchor.Clone().ok()?;
    range
        .MoveEndpointByRange(
            TextPatternRangeEndpoint_Start,
            anchor,
            TextPatternRangeEndpoint_End,
        )
        .ok()?;
    range
        .MoveEndpointByRange(
            TextPatternRangeEndpoint_End,
            anchor,
            TextPatternRangeEndpoint_End,
        )
        .ok()?;
    let _ = range.MoveEndpointByUnit(
        TextPatternRangeEndpoint_End,
        TextUnit_Character,
        TEXT_AFTER_LIMIT,
    );
    range
        .GetText(TEXT_AFTER_LIMIT)
        .ok()
        .map(|v| sanitize_uia_text(&v.to_string()))
}

fn sanitize_uia_text(value: &str) -> String {
    value
        .replace('\0', "")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn tail_chars(value: &str, limit: usize) -> String {
    let count = value.chars().count();
    value.chars().skip(count.saturating_sub(limit)).collect()
}

/// Map UIA ControlType ID to a human-readable name.
#[cfg(windows)]
fn uia_control_type_name(id: i32) -> String {
    match id {
        50000 => "Button".to_string(),
        50001 => "Calendar".to_string(),
        50002 => "CheckBox".to_string(),
        50003 => "ComboBox".to_string(),
        50004 => "Edit".to_string(),
        50005 => "Hyperlink".to_string(),
        50006 => "Image".to_string(),
        50007 => "ListItem".to_string(),
        50008 => "List".to_string(),
        50009 => "Menu".to_string(),
        50010 => "MenuBar".to_string(),
        50011 => "MenuItem".to_string(),
        50012 => "ProgressBar".to_string(),
        50013 => "RadioButton".to_string(),
        50014 => "ScrollBar".to_string(),
        50015 => "Slider".to_string(),
        50016 => "Spinner".to_string(),
        50017 => "StatusBar".to_string(),
        50018 => "Tab".to_string(),
        50019 => "TabItem".to_string(),
        50020 => "Text".to_string(),
        50021 => "ToolBar".to_string(),
        50022 => "ToolTip".to_string(),
        50023 => "Tree".to_string(),
        50024 => "TreeItem".to_string(),
        50025 => "Custom".to_string(),
        50026 => "Group".to_string(),
        50027 => "Thumb".to_string(),
        50028 => "DataGrid".to_string(),
        50029 => "DataItem".to_string(),
        50030 => "Document".to_string(),
        50031 => "SplitButton".to_string(),
        50032 => "Window".to_string(),
        50033 => "Pane".to_string(),
        50034 => "Header".to_string(),
        50035 => "HeaderItem".to_string(),
        50036 => "Table".to_string(),
        50037 => "TitleBar".to_string(),
        50038 => "Separator".to_string(),
        _ => format!("Unknown({})", id),
    }
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub fn capture_context(reason: &str) -> AppContext {
    macos::capture_context_with_text(reason, false)
}

#[cfg(target_os = "macos")]
fn capture_context_with_text(reason: &str, include_text_context: bool) -> AppContext {
    macos::capture_context_with_text(reason, include_text_context)
}

/// macOS 返回的是前台窗口矩形（逻辑点），不是显示器工作区，见 context/macos.rs。
#[cfg(target_os = "macos")]
pub fn capture_foreground_monitor() -> Option<MonitorBounds> {
    macos::capture_foreground_monitor()
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn capture_context(reason: &str) -> AppContext {
    capture_context_with_text(reason, false)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn capture_context_with_text(reason: &str, _include_text_context: bool) -> AppContext {
    AppContext {
        reason: reason.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn capture_foreground_monitor() -> Option<MonitorBounds> {
    None
}

// ─── Win32 helpers ───

#[cfg(windows)]
pub unsafe fn read_window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

#[cfg(windows)]
pub unsafe fn read_class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    }
}

/// pid → 可执行文件名（不含路径）。inject 模块用它指认「是谁占着剪贴板」。
#[cfg(windows)]
pub(crate) fn get_process_name(pid: u32) -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let name = get_process_image_name(h);
                let _ = CloseHandle(h);
                name.rsplit('\\').next().unwrap_or("").to_string()
            }
            Err(_) => String::new(),
        }
    }
}

#[cfg(windows)]
fn get_process_path(pid: u32) -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let path = get_process_image_name(h);
                let _ = CloseHandle(h);
                path
            }
            Err(_) => String::new(),
        }
    }
}

#[cfg(windows)]
unsafe fn get_process_image_name(handle: windows::Win32::Foundation::HANDLE) -> String {
    use windows::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_FORMAT};
    let mut buf = [0u16; 1024];
    let mut size = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_FORMAT(0),
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut size,
    );
    if ok.is_ok() && size > 0 {
        String::from_utf16_lossy(&buf[..size as usize])
    } else {
        String::new()
    }
}
