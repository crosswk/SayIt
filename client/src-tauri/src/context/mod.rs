//! Window context detection — captures information about the foreground window
//! and focused element to determine text injection strategy.
//! Also runs a WinEvent hook to push context updates when the foreground window changes.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, GetClassNameW, GetWindowTextW,
    GetGUIThreadInfo, GUITHREADINFO,
};

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
    #[serde(rename = "isKeyboardFocusable")]
    pub is_keyboard_focusable: bool,
    #[serde(rename = "isEnabled")]
    pub is_enabled: bool,
    #[serde(rename = "isReadOnly")]
    pub is_read_only: Option<bool>,
}

pub struct ContextDetector {
    cached_context: Mutex<Option<AppContext>>,
    winevent_running: AtomicBool,
}

impl ContextDetector {
    pub fn new() -> Self {
        Self {
            cached_context: Mutex::new(None),
            winevent_running: AtomicBool::new(false),
        }
    }

    /// Capture the current foreground window context
    pub fn capture(&self, reason: &str) -> AppContext {
        let ctx = capture_context(reason);
        *self.cached_context.lock().unwrap() = Some(ctx.clone());
        ctx
    }

    /// Get the last cached context without re-capturing
    #[allow(dead_code)]
    pub fn get_cached(&self) -> Option<AppContext> {
        self.cached_context.lock().unwrap().clone()
    }

    /// Start the WinEvent hook that monitors foreground window changes
    /// and pushes active-app-context events to the frontend
    #[cfg(windows)]
    pub fn start_winevent_hook(&self, app: &AppHandle) {
        if self.winevent_running.swap(true, Ordering::SeqCst) {
            return; // already running
        }

        let app_handle = app.clone();
        let cached = Arc::new(Mutex::new(None::<AppContext>));
        let cached_for_cb = cached.clone();

        thread::spawn(move || {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetMessageW, TranslateMessage, DispatchMessageW, MSG,
            };
            use windows::Win32::UI::Accessibility::{
                SetWinEventHook, HWINEVENTHOOK,
            };

            // WinEvent constants
            const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
            const EVENT_OBJECT_FOCUS: u32 = 0x8005;
            const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;

            // Store app handle in thread-local for the callback
            thread_local! {
                static APP: std::cell::RefCell<Option<AppHandle>> = std::cell::RefCell::new(None);
                static CACHED: std::cell::RefCell<Option<Arc<Mutex<Option<AppContext>>>>> = std::cell::RefCell::new(None);
            }

            APP.with(|a| *a.borrow_mut() = Some(app_handle));
            CACHED.with(|c| *c.borrow_mut() = Some(cached_for_cb));

            unsafe extern "system" fn winevent_proc(
                _hook: HWINEVENTHOOK,
                _event: u32,
                _hwnd: HWND,
                _id_object: i32,
                _id_child: i32,
                _event_thread: u32,
                _event_time: u32,
            ) {
                // Debounce: small delay to let focus settle
                std::thread::sleep(std::time::Duration::from_millis(50));

                let ctx = capture_context("winevent");

                APP.with(|a| {
                    if let Some(app) = a.borrow().as_ref() {
                        let _ = app.emit("active-app-context", &ctx);
                    }
                });

                CACHED.with(|c| {
                    if let Some(cache) = c.borrow().as_ref() {
                        *cache.lock().unwrap() = Some(ctx);
                    }
                });
            }

            unsafe {
                let _fg_hook = SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    None,
                    Some(winevent_proc),
                    0, 0,
                    WINEVENT_OUTOFCONTEXT,
                );

                let _focus_hook = SetWinEventHook(
                    EVENT_OBJECT_FOCUS,
                    EVENT_OBJECT_FOCUS,
                    None,
                    Some(winevent_proc),
                    0, 0,
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
        populate_uia_fields(&mut ctx);
    }
    ctx
}

/// Use Windows UI Automation to query the focused element's properties.
/// Populates control_type, automation_id, is_value_pattern_available,
/// is_keyboard_focusable, is_enabled, is_read_only in AppContext.
#[cfg(windows)]
unsafe fn populate_uia_fields(ctx: &mut AppContext) {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation,
        UIA_ControlTypePropertyId, UIA_AutomationIdPropertyId,
        UIA_IsValuePatternAvailablePropertyId, UIA_IsKeyboardFocusablePropertyId,
        UIA_IsEnabledPropertyId, UIA_ValueIsReadOnlyPropertyId,
    };
    // CoInitialize for this thread (may already be initialized — that's ok)
    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<(), String> {
        let uia: IUIAutomation = CoCreateInstance(
            &CUIAutomation,
            None,
            CLSCTX_INPROC_SERVER,
        ).map_err(|e| format!("CoCreateInstance CUIAutomation: {}", e))?;

        let focused = uia.GetFocusedElement()
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

        Ok(())
    })();

    if let Err(e) = result {
        log::debug!("UIA populate failed (non-fatal): {}", e);
    }

    if need_co_uninit {
        CoUninitialize();
    }
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

#[cfg(not(windows))]
pub fn capture_context(reason: &str) -> AppContext {
    AppContext {
        reason: reason.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    }
}

// ─── Win32 helpers ───

#[cfg(windows)]
pub unsafe fn read_window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len > 0 { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() }
}

#[cfg(windows)]
pub unsafe fn read_class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() }
}


#[cfg(windows)]
fn get_process_name(pid: u32) -> String {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::Foundation::CloseHandle;
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
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::Foundation::CloseHandle;
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
