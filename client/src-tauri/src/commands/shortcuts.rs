use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use crate::keyboard::KeyboardHookManager;
use crate::storage::Storage;

#[tauri::command]
pub fn shortcuts_changed(
    app: AppHandle,
    storage: State<Storage>,
    hook: State<KeyboardHookManager>,
) {
    // Read settings
    let ptt_setting = storage.get("shortcutPTT", None);
    let ptt_str = ptt_setting.as_str().unwrap_or("ShiftRight");
    let hf_val = storage.get("shortcutHandsFree", None);
    let hf_key = hf_val.as_str().unwrap_or("AltRight");

    // Reconfigure PTT + hands-free keyboard hook
    hook.reconfigure(&app, ptt_str, hf_key);

    // Re-register hands-free global shortcut (only for combo keys)
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();

    // If hands-free is a combo key (contains '+'), register via global_shortcut
    // If it's a single key, it's already handled by the keyboard hook
    if !hf_key.is_empty() && hf_key.contains('+') {
        if let Err(e) = app.global_shortcut().on_shortcut(
            hf_key,
            move |_app, _shortcut, _event| {
                let _ = _app.emit("toggle-hands-free", serde_json::json!({
                    "source": "globalShortcut",
                }));
            },
        ) {
            log::warn!("Failed to register hands-free shortcut '{}': {}", hf_key, e);
        } else {
            log::info!("Re-registered hands-free shortcut: {}", hf_key);
        }
    }
}

#[tauri::command]
pub fn test_shortcut(_accelerator: String) -> Result<bool, String> {
    // In Tauri, we use raw keyboard hooks, so any key is valid
    Ok(true)
}

/// PTT Lab: start/stop a dedicated keyboard hook for the lab test key (right Ctrl).
/// Completely independent from the main PTT hook — does not interfere with recording.
#[tauri::command]
pub fn set_ptt_lab_config(data: Value, app: AppHandle) -> Result<(), String> {
    let enabled = data.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    log::info!("[ptt-lab] set_ptt_lab_config called, enabled={}, data={}", enabled, data);

    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
        use std::sync::Mutex;
        use std::thread;

        // Static state for the lab hook thread
        static LAB_RUNNING: AtomicBool = AtomicBool::new(false);
        static LAB_THREAD_ID: AtomicU32 = AtomicU32::new(0);
        static LAB_APP: Mutex<Option<AppHandle>> = Mutex::new(None);

        // Stop existing lab hook if running
        if LAB_RUNNING.load(Ordering::SeqCst) {
            let tid = LAB_THREAD_ID.load(Ordering::SeqCst);
            if tid != 0 {
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
                    use windows::Win32::Foundation::{WPARAM, LPARAM};
                    const WM_QUIT: u32 = 0x0012;
                    let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
                }
            }
            LAB_RUNNING.store(false, Ordering::SeqCst);
            LAB_THREAD_ID.store(0, Ordering::SeqCst);
            *LAB_APP.lock().unwrap() = None;
            // Small delay to let old thread exit
            thread::sleep(std::time::Duration::from_millis(100));
            log::info!("[ptt-lab] stopped lab hook");
        }

        if !enabled {
            return Ok(());
        }

        // Parse the VK code — default to right Ctrl (0xA3)
        let vk_code: u32 = data.get("vkCode")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(0xA3); // VK_RCONTROL

        *LAB_APP.lock().unwrap() = Some(app.clone());
        LAB_RUNNING.store(true, Ordering::SeqCst);

        thread::spawn(move || {
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowsHookExW, UnhookWindowsHookEx, GetMessageW,
                TranslateMessage, DispatchMessageW, CallNextHookEx,
                KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
                WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
            };
            use windows::Win32::Foundation::{WPARAM, LPARAM, LRESULT};
            use windows::Win32::System::Threading::GetCurrentThreadId;

            // Thread-local state
            thread_local! {
                static LAB_VK: std::cell::Cell<u32> = std::cell::Cell::new(0xA3);
                static LAB_KEY_DOWN: std::cell::Cell<bool> = std::cell::Cell::new(false);
            }

            LAB_VK.with(|v| v.set(vk_code));

            unsafe extern "system" fn lab_keyboard_proc(
                n_code: i32,
                w_param: WPARAM,
                l_param: LPARAM,
            ) -> LRESULT {
                if n_code >= 0 {
                    let kb = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
                    let vk = kb.vkCode;
                    let msg = w_param.0 as u32;

                    let is_lab_key = LAB_VK.with(|v| vk == v.get());
                    if is_lab_key {
                        let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                        let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

                        if is_down && !LAB_KEY_DOWN.with(|v| v.get()) {
                            LAB_KEY_DOWN.with(|v| v.set(true));
                            if let Some(app) = LAB_APP.lock().ok().and_then(|g| g.clone()) {
                                let _ = app.emit("ptt-lab-event", serde_json::json!({
                                    "phase": "down",
                                    "vk": vk,
                                    "timestamp": chrono::Utc::now().timestamp_millis(),
                                }));
                            }
                            return LRESULT(1); // consume
                        }

                        if is_up && LAB_KEY_DOWN.with(|v| v.get()) {
                            LAB_KEY_DOWN.with(|v| v.set(false));
                            if let Some(app) = LAB_APP.lock().ok().and_then(|g| g.clone()) {
                                let _ = app.emit("ptt-lab-event", serde_json::json!({
                                    "phase": "up",
                                    "vk": vk,
                                    "timestamp": chrono::Utc::now().timestamp_millis(),
                                }));
                            }
                            return LRESULT(1); // consume
                        }

                        // Consume repeat downs too
                        if is_down || is_up {
                            return LRESULT(1);
                        }
                    }
                }
                CallNextHookEx(None, n_code, w_param, l_param)
            }

            unsafe {
                let tid = GetCurrentThreadId();
                LAB_THREAD_ID.store(tid, Ordering::SeqCst);
                log::info!("[ptt-lab] hook thread started, tid={}, vk=0x{:X}", tid, vk_code);

                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(lab_keyboard_proc), None, 0);
                let hook = match hook {
                    Ok(h) => h,
                    Err(e) => {
                        log::error!("[ptt-lab] SetWindowsHookExW failed: {}", e);
                        LAB_RUNNING.store(false, Ordering::SeqCst);
                        return;
                    }
                };

                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                let _ = UnhookWindowsHookEx(hook);
                LAB_RUNNING.store(false, Ordering::SeqCst);
                LAB_THREAD_ID.store(0, Ordering::SeqCst);
                log::info!("[ptt-lab] hook thread exited");
            }
        });
    }

    Ok(())
}
