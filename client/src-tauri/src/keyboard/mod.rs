//! Global keyboard hook for PTT (Push-to-Talk) functionality.
//!
//! Uses Win32 SetWindowsHookExW(WH_KEYBOARD_LL) to capture key events globally.
//! Runs the message loop on a dedicated thread.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    GetMessageW, TranslateMessage, DispatchMessageW,
    KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_QUIT,
    WM_XBUTTONDOWN, WM_XBUTTONUP,
};

/// 单键热键表 —— 单一数据源。
///
/// ⚠️ 必须与前端 `client/src/lib/shortcutKeys.ts` 的 `SINGLE_KEYS` 保持一致
/// （Rust 无法直接引用 TS，新增/修改单键时两边都要改）。
/// `setting` 取值等于 DOM KeyboardEvent.code。
const SINGLE_KEY_TABLE: &[(&str, u32)] = &[
    ("AltLeft", 0xA4),
    ("AltRight", 0xA5),
    ("ControlLeft", 0xA2),
    ("ControlRight", 0xA3),
    ("ShiftLeft", 0xA0),
    ("ShiftRight", 0xA1),
    ("MouseBack", 0x05),
    ("MouseForward", 0x06),
    ("CapsLock", 0x14),
    ("Space", 0x20),
    ("ContextMenu", 0x5D),
    ("Pause", 0x13),
    ("ScrollLock", 0x91),
    ("Insert", 0x2D),
    ("F1", 0x70), ("F2", 0x71), ("F3", 0x72), ("F4", 0x73),
    ("F5", 0x74), ("F6", 0x75), ("F7", 0x76), ("F8", 0x77),
    ("F9", 0x78), ("F10", 0x79), ("F11", 0x7A), ("F12", 0x7B),
];

/// Virtual key code mapping for PTT settings
fn vk_codes_for_setting(setting: &str) -> Vec<u32> {
    if setting.is_empty() {
        return vec![];
    }
    SINGLE_KEY_TABLE
        .iter()
        .find(|(s, _)| *s == setting)
        .map(|(_, vk)| vec![*vk])
        .unwrap_or_else(|| vec![0xA5]) // default: AltRight
}

/// Check if a shortcut setting is a single key (handled by hook) vs combo (handled by global_shortcut)
pub fn is_single_key_setting(setting: &str) -> bool {
    SINGLE_KEY_TABLE.iter().any(|(s, _)| *s == setting)
}

/// Check if a setting is a mouse button (needs WH_MOUSE_LL instead of WH_KEYBOARD_LL)
fn is_mouse_button_setting(setting: &str) -> bool {
    matches!(setting, "MouseBack" | "MouseForward")
}

#[allow(dead_code)]
fn modifier_kind(setting: &str) -> Option<&'static str> {
    match setting {
        "AltLeft" | "AltRight" => Some("alt"),
        "ControlLeft" | "ControlRight" => Some("ctrl"),
        "ShiftLeft" | "ShiftRight" => Some("shift"),
        _ => None,
    }
}

#[derive(Clone, Serialize)]
struct PTTEvent {
    source: String,
    reason: String,
    #[serde(rename = "keycode")]
    vk: u32,
    #[serde(rename = "pttSetting")]
    ptt_setting: String,
    timestamp: i64,
    #[serde(rename = "altKey")]
    alt_key: bool,
    #[serde(rename = "ctrlKey")]
    ctrl_key: bool,
    #[serde(rename = "shiftKey")]
    shift_key: bool,
}

/// Shared state between the hook callback and the main thread
struct HookSharedState {
    ptt_vk_codes: Vec<u32>,
    ptt_setting: String,
    ptt_is_mouse: bool,
    ptt_key_down: AtomicBool,
    /// Generation counter — incremented on each keydown, used to invalidate
    /// stale hard-timeout timers from previous presses.
    ptt_generation: AtomicU64,
    hands_free_active: AtomicBool,
    /// VK codes for hands-free toggle key (empty = not using hook for hands-free)
    hf_vk_codes: Vec<u32>,
    hf_setting: String,
    hf_is_mouse: bool,
    app_handle: AppHandle,
}

/// Message sent from the hook callback (non-blocking) to the dispatcher thread.
#[cfg(windows)]
#[allow(dead_code)]
enum HookAction {
    PttDown { vk: u32, gen: u64 },
    PttUp { vk: u32 },
    HfToggle { vk: u32 },
    Diag { vk: u32, msg_name: &'static str, flags: u32 },
}

// Thread-local storage for the hook callback
thread_local! {
    static HOOK_STATE: std::cell::RefCell<Option<Arc<HookSharedState>>> = std::cell::RefCell::new(None);
    /// Non-blocking channel sender for offloading work from the hook callback.
    static HOOK_ACTION_TX: std::cell::RefCell<Option<std::sync::mpsc::SyncSender<HookAction>>> = std::cell::RefCell::new(None);
}

pub struct KeyboardHookManager {
    hook_thread_id: Mutex<Option<u32>>,
    shared_state: Mutex<Option<Arc<HookSharedState>>>,
    running: AtomicBool,
}

impl KeyboardHookManager {
    pub fn new() -> Self {
        Self {
            hook_thread_id: Mutex::new(None),
            shared_state: Mutex::new(None),
            running: AtomicBool::new(false),
        }
    }

    /// Start the keyboard hook with the given PTT setting and optional hands-free setting
    pub fn start(&self, app: &AppHandle, ptt_setting: &str, hf_setting: &str) {
        if self.running.load(Ordering::SeqCst) {
            self.stop();
        }

        let hf_vk_codes = if is_single_key_setting(hf_setting) {
            vk_codes_for_setting(hf_setting)
        } else {
            vec![] // combo key — handled by global_shortcut, not hook
        };

        let state = Arc::new(HookSharedState {
            ptt_vk_codes: vk_codes_for_setting(ptt_setting),
            ptt_setting: ptt_setting.to_string(),
            ptt_is_mouse: is_mouse_button_setting(ptt_setting),
            ptt_key_down: AtomicBool::new(false),
            ptt_generation: AtomicU64::new(0),
            hands_free_active: AtomicBool::new(false),
            hf_vk_codes,
            hf_setting: hf_setting.to_string(),
            hf_is_mouse: is_mouse_button_setting(hf_setting),
            app_handle: app.clone(),
        });

        *self.shared_state.lock().unwrap() = Some(state.clone());
        self.running.store(true, Ordering::SeqCst);

        let state_for_thread = state.clone();
        let (tx, rx) = std::sync::mpsc::channel::<u32>();

        thread::spawn(move || {
            Self::hook_thread(state_for_thread, tx);
        });

        // Wait for the thread to report its ID
        if let Ok(thread_id) = rx.recv_timeout(std::time::Duration::from_secs(5)) {
            *self.hook_thread_id.lock().unwrap() = Some(thread_id);
            log::info!("Keyboard hook started, thread_id={}", thread_id);
        } else {
            log::error!("Keyboard hook thread failed to start");
            self.running.store(false, Ordering::SeqCst);
        }
    }

    /// Stop the keyboard hook
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);

        // 清理可能卡住的修饰键状态
        #[cfg(windows)]
        if let Some(state) = self.shared_state.lock().unwrap().as_ref() {
            if state.ptt_key_down.load(Ordering::SeqCst) {
                state.ptt_key_down.store(false, Ordering::SeqCst);
                // 发送合成的 keyup 事件，让 Windows 释放修饰键
                for &vk in &state.ptt_vk_codes {
                    unsafe {
                        use windows::Win32::UI::Input::KeyboardAndMouse::*;
                        let mut input = INPUT {
                            r#type: INPUT_KEYBOARD,
                            ..std::mem::zeroed()
                        };
                        input.Anonymous.ki = KEYBDINPUT {
                            wVk: VIRTUAL_KEY(vk as u16),
                            dwFlags: KEYEVENTF_KEYUP,
                            ..std::mem::zeroed()
                        };
                        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                    }
                }
                log::info!("[ptt] sent synthetic keyup on stop to clear modifier state");
            }
        }

        if let Some(thread_id) = self.hook_thread_id.lock().unwrap().take() {
            #[cfg(windows)]
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }

        *self.shared_state.lock().unwrap() = None;
    }

    /// Reconfigure with new PTT and hands-free settings
    pub fn reconfigure(&self, app: &AppHandle, ptt_setting: &str, hf_setting: &str) {
        self.stop();
        // Small delay to let the old hook thread exit
        thread::sleep(std::time::Duration::from_millis(100));
        self.start(app, ptt_setting, hf_setting);
    }

    /// Set hands-free mode active (suppresses PTT up events temporarily)
    #[allow(dead_code)]
    pub fn set_hands_free(&self, active: bool) {
        if let Some(state) = self.shared_state.lock().unwrap().as_ref() {
            state.hands_free_active.store(active, Ordering::SeqCst);
            if active {
                state.ptt_key_down.store(false, Ordering::SeqCst);
            }
        }
    }

    #[cfg(windows)]
    fn hook_thread(state: Arc<HookSharedState>, tx: std::sync::mpsc::Sender<u32>) {
        use windows::Win32::System::Threading::GetCurrentThreadId;

        log::info!(
            "keyboard hook thread starting, ptt_setting={} vk_codes={:?}",
            state.ptt_setting, state.ptt_vk_codes
        );

        // Create a bounded channel for non-blocking sends from the hook callback.
        // Buffer of 64 is plenty — we only send on PTT key events.
        let (action_tx, action_rx) = std::sync::mpsc::sync_channel::<HookAction>(64);

        // Spawn dispatcher thread — handles logging and emit (potentially blocking ops)
        let dispatch_state = state.clone();
        thread::spawn(move || {
            while let Ok(action) = action_rx.recv() {
                match action {
                    HookAction::Diag { vk, msg_name, flags } => {
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [hook-diag] vk={} msg={} flags=0x{:X}", vk, msg_name, flags)
                        );
                    }
                    HookAction::PttDown { vk, gen } => {
                        let setting = &dispatch_state.ptt_setting;
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [ptt] keydown vk={} setting={} gen={}", vk, setting, gen)
                        );
                        let event = PTTEvent {
                            source: "rust_hook".to_string(),
                            reason: "keydown".to_string(),
                            vk,
                            ptt_setting: setting.clone(),
                            timestamp: chrono::Utc::now().timestamp_millis(),
                            alt_key: setting == "AltLeft" || setting == "AltRight",
                            ctrl_key: setting == "ControlLeft" || setting == "ControlRight",
                            shift_key: setting == "ShiftLeft" || setting == "ShiftRight",
                        };
                        let _ = dispatch_state.app_handle.emit("ptt-down", &event);

                        // Arm hard release timer (5min)
                        let state_clone = dispatch_state.clone();
                        thread::spawn(move || {
                            // 4-minute warning
                            thread::sleep(std::time::Duration::from_secs(240));
                            if state_clone.ptt_generation.load(Ordering::SeqCst) == gen
                                && state_clone.ptt_key_down.load(Ordering::SeqCst)
                            {
                                crate::commands::system::write_log_line(
                                    &format!("[RUST] [ptt] 4min timeout warning gen={}", gen)
                                );
                                let warn_event = PTTEvent {
                                    source: "rust_hook".to_string(),
                                    reason: "timeout_warning".to_string(),
                                    vk,
                                    ptt_setting: state_clone.ptt_setting.clone(),
                                    timestamp: chrono::Utc::now().timestamp_millis(),
                                    alt_key: false, ctrl_key: false, shift_key: false,
                                };
                                let _ = state_clone.app_handle.emit("ptt-timeout-warning", &warn_event);
                            }
                            // Remaining 60s until hard cutoff
                            thread::sleep(std::time::Duration::from_secs(60));
                            if state_clone.ptt_generation.load(Ordering::SeqCst) == gen
                                && state_clone.ptt_key_down.load(Ordering::SeqCst)
                            {
                                state_clone.ptt_key_down.store(false, Ordering::SeqCst);
                                crate::commands::system::write_log_line(
                                    &format!("[RUST] [ptt] hard_timeout_release gen={}", gen)
                                );
                                let timeout_event = PTTEvent {
                                    source: "rust_hook".to_string(),
                                    reason: "hard_timeout_release".to_string(),
                                    vk,
                                    ptt_setting: state_clone.ptt_setting.clone(),
                                    timestamp: chrono::Utc::now().timestamp_millis(),
                                    alt_key: false, ctrl_key: false, shift_key: false,
                                };
                                let _ = state_clone.app_handle.emit("ptt-up", &timeout_event);
                            }
                        });
                    }
                    HookAction::PttUp { vk } => {
                        let setting = &dispatch_state.ptt_setting;
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [ptt] keyup vk={} setting={}", vk, setting)
                        );
                        let event = PTTEvent {
                            source: "rust_hook".to_string(),
                            reason: "keyup".to_string(),
                            vk,
                            ptt_setting: setting.clone(),
                            timestamp: chrono::Utc::now().timestamp_millis(),
                            alt_key: setting == "AltLeft" || setting == "AltRight",
                            ctrl_key: setting == "ControlLeft" || setting == "ControlRight",
                            shift_key: setting == "ShiftLeft" || setting == "ShiftRight",
                        };
                        let _ = dispatch_state.app_handle.emit("ptt-up", &event);
                    }
                    HookAction::HfToggle { vk } => {
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [hf] toggle vk={} setting={}", vk, dispatch_state.hf_setting)
                        );
                        let _ = dispatch_state.app_handle.emit("toggle-hands-free", serde_json::json!({
                            "source": "rust_hook",
                            "vk": vk,
                        }));
                    }
                }
            }
            log::info!("[ptt] dispatcher thread exited");
        });

        // Set thread-local state for the callback
        HOOK_STATE.with(|s| {
            *s.borrow_mut() = Some(state.clone());
        });
        HOOK_ACTION_TX.with(|s| {
            *s.borrow_mut() = Some(action_tx);
        });

        unsafe {
            let install_hook = || -> Option<windows::Win32::UI::WindowsAndMessaging::HHOOK> {
                match SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(low_level_keyboard_proc),
                    None,
                    0,
                ) {
                    Ok(h) => {
                        log::info!("SetWindowsHookExW(keyboard) succeeded: {:?}", h.0);
                        Some(h)
                    }
                    Err(e) => {
                        log::error!("SetWindowsHookExW(keyboard) failed: {}", e);
                        None
                    }
                }
            };

            let kb_hook = match install_hook() {
                Some(h) => h,
                None => return,
            };

            // Install mouse hook if PTT or hands-free uses a mouse button
            let needs_mouse_hook = state.ptt_is_mouse
                || (state.hf_is_mouse && !state.hf_vk_codes.is_empty());
            let mouse_hook = if needs_mouse_hook {
                match SetWindowsHookExW(
                    WH_MOUSE_LL,
                    Some(low_level_mouse_proc),
                    None,
                    0,
                ) {
                    Ok(h) => {
                        log::info!("SetWindowsHookExW(mouse) succeeded: {:?}", h.0);
                        Some(h)
                    }
                    Err(e) => {
                        log::error!("SetWindowsHookExW(mouse) failed: {}", e);
                        None
                    }
                }
            } else {
                None
            };

            let thread_id = GetCurrentThreadId();
            let _ = tx.send(thread_id);
            log::info!("keyboard hook message loop starting on thread {}", thread_id);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            log::info!("keyboard hook message loop exited");
            let _ = UnhookWindowsHookEx(kb_hook);
            if let Some(mh) = mouse_hook {
                let _ = UnhookWindowsHookEx(mh);
            }
        }

        HOOK_STATE.with(|s| {
            *s.borrow_mut() = None;
        });
        HOOK_ACTION_TX.with(|s| {
            *s.borrow_mut() = None;
        });
    }

    #[cfg(not(windows))]
    fn hook_thread(_state: Arc<HookSharedState>, tx: std::sync::mpsc::Sender<u32>) {
        let _ = tx.send(0);
        // No-op on non-Windows
    }
}

#[cfg(windows)]
unsafe extern "system" fn low_level_keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code >= 0 {
        let kb = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        let vk = kb.vkCode;
        let msg = w_param.0 as u32;

        // ── CRITICAL: This callback MUST return within ~200ms or Windows
        // will silently remove the hook. NO blocking operations allowed.
        // All logging and emit are offloaded via try_send to a dispatcher thread.

        // Ultra-low-level diagnostic: OutputDebugString bypasses all locks
        if vk == 165 || vk == 163 {
            extern "system" {
                fn OutputDebugStringA(lp: *const u8);
            }
            let s = format!("[SayIt-hook] vk={} msg=0x{:04X}\0", vk, msg);
            OutputDebugStringA(s.as_ptr());
        }

        let mut consumed = false;

        HOOK_STATE.with(|s| {
            if let Some(state) = s.borrow().as_ref() {
                let is_ptt_key = state.ptt_vk_codes.contains(&vk);
                let is_hf_key = !state.hf_vk_codes.is_empty()
                    && state.hf_vk_codes.contains(&vk)
                    && !is_ptt_key; // PTT takes priority if same key

                if is_ptt_key {
                    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

                    // 只吞掉 keydown，keyup 必须放行让系统更新键盘状态
                    // 否则 Windows 会认为修饰键一直按着
                    if is_down {
                        consumed = true;
                    }

                    if is_down && !state.ptt_key_down.load(Ordering::SeqCst)
                        && !state.hands_free_active.load(Ordering::SeqCst)
                    {
                        state.ptt_key_down.store(true, Ordering::SeqCst);
                        let gen = state.ptt_generation.fetch_add(1, Ordering::SeqCst) + 1;

                        // Non-blocking send to dispatcher
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                let _ = sender.try_send(HookAction::PttDown { vk, gen });
                            }
                        });
                    }

                    if is_up && state.ptt_key_down.load(Ordering::SeqCst) {
                        state.ptt_key_down.store(false, Ordering::SeqCst);

                        if !state.hands_free_active.load(Ordering::SeqCst) {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    let _ = sender.try_send(HookAction::PttUp { vk });
                                }
                            });
                        }
                    }
                }

                // 免提键：keyup 时触发 toggle（避免和 keydown repeat 冲突）
                if is_hf_key {
                    let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    if is_down {
                        consumed = true; // 吞掉 keydown 防止系统处理
                    }
                    if is_up {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                let _ = sender.try_send(HookAction::HfToggle { vk });
                            }
                        });
                    }
                }
            }
        });

        if consumed {
            return LRESULT(1);
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}

/// XButton index constants from HIWORD of MSLLHOOKSTRUCT.mouseData
#[cfg(windows)]
const XBUTTON1: u16 = 1;
#[cfg(windows)]
const XBUTTON2: u16 = 2;

#[cfg(windows)]
unsafe extern "system" fn low_level_mouse_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code >= 0 {
        let ms = &*(l_param.0 as *const MSLLHOOKSTRUCT);
        let msg = w_param.0 as u32;

        if msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP {
            let xbutton = ((ms.mouseData >> 16) & 0xFFFF) as u16;
            let vk: u32 = match xbutton {
                XBUTTON1 => 0x05, // VK_XBUTTON1
                XBUTTON2 => 0x06, // VK_XBUTTON2
                _ => 0,
            };

            if vk != 0 {
                let mut consumed = false;

                HOOK_STATE.with(|s| {
                    if let Some(state) = s.borrow().as_ref() {
                        let is_ptt_key = state.ptt_is_mouse && state.ptt_vk_codes.contains(&vk);
                        let is_hf_key = state.hf_is_mouse
                            && !state.hf_vk_codes.is_empty()
                            && state.hf_vk_codes.contains(&vk)
                            && !is_ptt_key;

                        if is_ptt_key {
                            let is_down = msg == WM_XBUTTONDOWN;
                            let is_up = msg == WM_XBUTTONUP;

                            consumed = true;

                            if is_down && !state.ptt_key_down.load(Ordering::SeqCst)
                                && !state.hands_free_active.load(Ordering::SeqCst)
                            {
                                state.ptt_key_down.store(true, Ordering::SeqCst);
                                let gen = state.ptt_generation.fetch_add(1, Ordering::SeqCst) + 1;
                                HOOK_ACTION_TX.with(|tx| {
                                    if let Some(sender) = tx.borrow().as_ref() {
                                        let _ = sender.try_send(HookAction::PttDown { vk, gen });
                                    }
                                });
                            }

                            if is_up && state.ptt_key_down.load(Ordering::SeqCst) {
                                state.ptt_key_down.store(false, Ordering::SeqCst);
                                if !state.hands_free_active.load(Ordering::SeqCst) {
                                    HOOK_ACTION_TX.with(|tx| {
                                        if let Some(sender) = tx.borrow().as_ref() {
                                            let _ = sender.try_send(HookAction::PttUp { vk });
                                        }
                                    });
                                }
                            }
                        }

                        if is_hf_key {
                            consumed = true;
                            if msg == WM_XBUTTONUP {
                                HOOK_ACTION_TX.with(|tx| {
                                    if let Some(sender) = tx.borrow().as_ref() {
                                        let _ = sender.try_send(HookAction::HfToggle { vk });
                                    }
                                });
                            }
                        }
                    }
                });

                if consumed {
                    return LRESULT(1);
                }
            }
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}