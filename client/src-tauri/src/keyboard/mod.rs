//! Global keyboard hook for PTT (Push-to-Talk) functionality.
//!
//! Uses Win32 SetWindowsHookExW(WH_KEYBOARD_LL) to capture key events globally.
//! Runs the message loop on a dedicated thread.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

// ── 健康监测埋点（悬浮窗/热键间歇性失效排查）──
// 这些是进程级静态量，与具体某次 hook 实例无关，用于在钩子"悄悄失效"时留下痕迹：
// - LAST_CALLBACK_MS：钩子回调最近一次被 Windows 调用的时间（任意按键都会更新，
//   不限于 PTT 键）。如果这个值长时间不再更新但用户在正常打字，说明钩子已被
//   系统摘除（WH_KEYBOARD_LL 回调超时/异常会被静默移除，是本次排查的头号嫌疑）。
// - DISPATCHER_ALIVE：dispatcher 线程是否仍在运行；线程 panic 或 recv() 返回
//   Err（发送端全部丢弃）都会导致这个循环退出。
// - TRY_SEND_FAIL_COUNT：钩子回调向 dispatcher 发送消息失败的累计次数——一旦
//   >0 就说明 dispatcher 侧出了问题（队列满或已退出），即使 hook 本身还活着，
//   PTT 事件也发不出去，前端永远等不到 ptt-down。
static LAST_CALLBACK_MS: AtomicI64 = AtomicI64::new(0);
static DISPATCHER_ALIVE: AtomicBool = AtomicBool::new(false);
static TRY_SEND_FAIL_COUNT: AtomicU64 = AtomicU64::new(0);
/// 钩子回调实际执行耗时的最大观测值（微秒），用于确认是否接近/超过 Windows 的
/// ~200ms 静默摘除阈值。正常情况应恒定在几十微秒级别。
static MAX_CALLBACK_DURATION_US: AtomicU64 = AtomicU64::new(0);
/// 镜像 `KeyboardHookManager.running`——独立看门狗线程没有该实例的引用，
/// 用全局静态量同步一份供健康快照读取。
static HOOK_RUNNING: AtomicBool = AtomicBool::new(false);
/// reconfigure() 累计调用次数，用于确认"过一段时间失效"是否与设置变更相关。
static RECONFIGURE_COUNT: AtomicU64 = AtomicU64::new(0);

// ── 侧键"录制捕获"模式 ──
// 设置页录制快捷键时，前端会打开这个开关。开启后：
//  - 鼠标钩子把下一个侧键(XBUTTON)按下吞掉并回报，webview 不会当成“后退”导航；
//  - 键盘钩子把浏览器后退/前进键(0xA6/0xA7，罗技等改键鼠标常把侧键映射成这个)也
//    吞掉并回报，同时记录捕获期间收到的每个 keydown 原始特征，便于诊断到底发的是啥。
static SHORTCUT_CAPTURE: AtomicBool = AtomicBool::new(false);
/// 捕获到侧键 down 后，记住其 vk，好把配对的 up 也一并吞掉（否则可能残留导航）。
static CONSUME_XUP_VK: AtomicU32 = AtomicU32::new(0);

/// 打开/关闭侧键录制捕获模式（供设置页录制快捷键时调用）。
pub fn set_mouse_shortcut_capture(on: bool) {
    SHORTCUT_CAPTURE.store(on, Ordering::SeqCst);
    // 只在“开始录制”时清零，作为一次干净的起点。
    // 绝不在“结束录制”时清零——因为捕获到 down 后配对的 up 往往稍晚才到，
    // 若在结束时就清掉，这个“抬起”就会漏给 webview（后退键会导致页面返回）。
    if on {
        CONSUME_XUP_VK.store(0, Ordering::SeqCst);
    }
}

// ── 看门狗写日志的节流状态 ──
// 每 60s 采样一次是廉价的，但没必要每次都写日志：正常时全是同样的正常值，纯噪音。
// 只在"状态翻转 / 失败计数增加 / 距上次写日志超过心跳间隔"时才落一行。
static WD_LAST_LOG_MS: AtomicI64 = AtomicI64::new(0);
static WD_LAST_HOOK_RUNNING: AtomicBool = AtomicBool::new(false);
static WD_LAST_DISPATCHER_ALIVE: AtomicBool = AtomicBool::new(false);
static WD_LAST_FAIL_COUNT: AtomicU64 = AtomicU64::new(0);
/// 一切正常时的心跳间隔：每 10 分钟落一行，证明进程还活着。
const WD_HEARTBEAT_MS: i64 = 10 * 60 * 1000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(windows)]
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    GetMessageW, TranslateMessage, DispatchMessageW,
    KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP, WM_QUIT,
    MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_XBUTTONDOWN, WM_XBUTTONUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP,
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
    ("CapsLock", 0x14),
    ("Space", 0x20),
    ("ContextMenu", 0x5D),
    ("Pause", 0x13),
    ("ScrollLock", 0x91),
    ("Insert", 0x2D),
    // 鼠标侧键：走 WH_MOUSE_LL 鼠标钩子（非键盘钩子），vk 用 Windows 的 VK_XBUTTON1/2。
    ("XButton1", 0x05),
    ("XButton2", 0x06),
    // 鼠标中键：走同一个低级鼠标钩子，vk 用 VK_MBUTTON。
    ("MButton", 0x04),
    // 浏览器后退/前进键：罗技等改键鼠标常把侧键映射成这个（走键盘钩子）。
    ("BrowserBack", 0xA6),
    ("BrowserForward", 0xA7),
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

/// 该设置是否为鼠标侧键（由低级鼠标钩子处理，而非键盘钩子）。
fn is_mouse_button_setting(setting: &str) -> bool {
    matches!(setting, "XButton1" | "XButton2" | "MButton")
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
    ptt_key_down: AtomicBool,
    /// Generation counter — incremented on each keydown, used to invalidate
    /// stale hard-timeout timers from previous presses.
    ptt_generation: AtomicU64,
    hands_free_active: AtomicBool,
    /// 免提键是否处于"已按下"状态。只有先收到过真实（未被 synthetic 过滤）的 keydown，
    /// 随后的 keyup 才允许触发 toggle。用于挡掉远程桌面等场景下的"孤儿 keyup"幻影按键。
    hf_key_down: AtomicBool,
    /// VK codes for hands-free toggle key (empty = not using hook for hands-free)
    hf_vk_codes: Vec<u32>,
    hf_setting: String,
    app_handle: AppHandle,
}

/// Message sent from the hook callback (non-blocking) to the dispatcher thread.
#[cfg(windows)]
#[allow(dead_code)]
enum HookAction {
    PttDown { vk: u32, gen: u64 },
    PttUp { vk: u32 },
    HfToggle { vk: u32 },
    Diag { vk: u32, msg_name: &'static str, flags: u32, scan_code: u32 },
    /// 快捷键录制期间捕获到的鼠标侧键（vk=0x05/0x06），用于让设置页绑定侧键。
    MouseCaptured { vk: u32 },
}

/// RAII 计时器：测量 `low_level_keyboard_proc` 单次调用耗时，drop 时更新
/// `MAX_CALLBACK_DURATION_US`。用 Drop 而非在每个 return 点手写更新，这样
/// 无论函数从哪条路径返回都会被覆盖到，不会漏记。
#[cfg(windows)]
struct CallbackTimer(std::time::Instant);

#[cfg(windows)]
impl Drop for CallbackTimer {
    fn drop(&mut self) {
        let elapsed_us = self.0.elapsed().as_micros() as u64;
        let prev = MAX_CALLBACK_DURATION_US.load(Ordering::Relaxed);
        if elapsed_us > prev {
            MAX_CALLBACK_DURATION_US.store(elapsed_us, Ordering::Relaxed);
        }
    }
}

/// RAII 标记：dispatcher 线程存活状态。构造时置 true，drop 时（无论正常退出
/// 还是 panic 展开）置 false —— 这样即使 dispatcher 线程 panic，全局健康快照
/// 也能立刻反映出"dispatcher 已死"，不依赖它自己走到正常退出的日志行。
struct DispatcherAliveGuard;

impl DispatcherAliveGuard {
    fn new() -> Self {
        DISPATCHER_ALIVE.store(true, Ordering::SeqCst);
        Self
    }
}

impl Drop for DispatcherAliveGuard {
    fn drop(&mut self) {
        DISPATCHER_ALIVE.store(false, Ordering::SeqCst);
    }
}

/// 供看门狗线程读取的健康快照，写入 sayit.log 供事后排查。
/// 复现问题后搜索 `[ptt-watchdog]` 即可看到当时的钩子/dispatcher 状态。
pub fn write_health_snapshot(reason: &str) {
    let last_cb = LAST_CALLBACK_MS.load(Ordering::SeqCst);
    let last_cb_age_ms = if last_cb == 0 { -1 } else { now_ms() - last_cb };
    let dispatcher_alive = DISPATCHER_ALIVE.load(Ordering::SeqCst);
    let hook_running = HOOK_RUNNING.load(Ordering::SeqCst);
    let fail_count = TRY_SEND_FAIL_COUNT.load(Ordering::SeqCst);
    let max_dur_us = MAX_CALLBACK_DURATION_US.load(Ordering::SeqCst);
    crate::commands::system::write_log_line(&format!(
        "[ptt-watchdog] reason={} hook_running={} dispatcher_alive={} last_callback_age_ms={} \
         try_send_fail_count={} max_callback_duration_us={}",
        reason, hook_running, dispatcher_alive, last_cb_age_ms, fail_count, max_dur_us,
    ));
}

/// 启动一个每 60 秒采样一次健康状态的看门狗线程。整个进程生命周期内只需启动一次
/// （在 main.rs 的 setup 阶段调用），与具体某次 hook 的 start/stop/reconfigure 无关。
///
/// 采样廉价、写日志克制：仅在①钩子/分发线程存活状态翻转、②投递失败计数增加、
/// ③距上次落盘超过心跳间隔（10 分钟）时才写一行，避免正常运行时刷屏。
pub fn spawn_health_watchdog() {
    let _ = thread::Builder::new()
        .name("ptt-watchdog".to_string())
        .spawn(|| {
            loop {
                thread::sleep(std::time::Duration::from_secs(60));

                let hook_running = HOOK_RUNNING.load(Ordering::SeqCst);
                let dispatcher_alive = DISPATCHER_ALIVE.load(Ordering::SeqCst);
                let fail_count = TRY_SEND_FAIL_COUNT.load(Ordering::SeqCst);

                let state_changed = hook_running != WD_LAST_HOOK_RUNNING.load(Ordering::SeqCst)
                    || dispatcher_alive != WD_LAST_DISPATCHER_ALIVE.load(Ordering::SeqCst)
                    || fail_count != WD_LAST_FAIL_COUNT.load(Ordering::SeqCst);

                let last_log = WD_LAST_LOG_MS.load(Ordering::SeqCst);
                let heartbeat_due = last_log == 0 || (now_ms() - last_log) >= WD_HEARTBEAT_MS;

                if state_changed || heartbeat_due {
                    write_health_snapshot(if state_changed { "change" } else { "heartbeat" });
                    WD_LAST_HOOK_RUNNING.store(hook_running, Ordering::SeqCst);
                    WD_LAST_DISPATCHER_ALIVE.store(dispatcher_alive, Ordering::SeqCst);
                    WD_LAST_FAIL_COUNT.store(fail_count, Ordering::SeqCst);
                    WD_LAST_LOG_MS.store(now_ms(), Ordering::SeqCst);
                }
            }
        });
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
        crate::commands::system::write_log_line(&format!(
            "[ptt-lifecycle] start() called ptt_setting={} hf_setting={}",
            ptt_setting, hf_setting,
        ));
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
            ptt_key_down: AtomicBool::new(false),
            ptt_generation: AtomicU64::new(0),
            hands_free_active: AtomicBool::new(false),
            hf_key_down: AtomicBool::new(false),
            hf_vk_codes,
            hf_setting: hf_setting.to_string(),
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
            HOOK_RUNNING.store(true, Ordering::SeqCst);
            log::info!("Keyboard hook started, thread_id={}", thread_id);
            crate::commands::system::write_log_line(&format!(
                "[ptt-lifecycle] hook started OK thread_id={}", thread_id,
            ));
        } else {
            log::error!("Keyboard hook thread failed to start");
            crate::commands::system::write_log_line(
                "[ptt-lifecycle] hook FAILED to start (rx.recv_timeout expired after 5s)"
            );
            self.running.store(false, Ordering::SeqCst);
            HOOK_RUNNING.store(false, Ordering::SeqCst);
        }
    }

    /// Stop the keyboard hook
    pub fn stop(&self) {
        crate::commands::system::write_log_line("[ptt-lifecycle] stop() called");
        self.running.store(false, Ordering::SeqCst);
        HOOK_RUNNING.store(false, Ordering::SeqCst);

        // 清理可能卡住的修饰键状态
        #[cfg(windows)]
        if let Some(state) = self.shared_state.lock().unwrap().as_ref() {
            if state.ptt_key_down.load(Ordering::SeqCst) {
                state.ptt_key_down.store(false, Ordering::SeqCst);
                // 鼠标侧键不涉及键盘修饰键状态，无需（也不能）补发键盘 keyup。
                if !is_mouse_button_setting(&state.ptt_setting) {
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
        let count = RECONFIGURE_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
        crate::commands::system::write_log_line(&format!(
            "[ptt-lifecycle] reconfigure() #{} ptt_setting={} hf_setting={} — 100ms 空档期开始",
            count, ptt_setting, hf_setting,
        ));
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
        thread::Builder::new()
            .name("ptt-dispatcher".to_string())
            .spawn(move || {
            // Guard 存活期 = 本线程存活期；线程正常退出或 panic 展开都会触发 Drop，
            // 从而让看门狗快照立刻看到 dispatcher_alive=false。
            let _alive_guard = DispatcherAliveGuard::new();
            crate::commands::system::write_log_line("[ptt-dispatcher] thread started");
            while let Ok(action) = action_rx.recv() {
                match action {
                    HookAction::Diag { vk, msg_name, flags, scan_code } => {
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [hook-diag] vk={} msg={} flags=0x{:X} scanCode=0x{:X}", vk, msg_name, flags, scan_code)
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
                    HookAction::MouseCaptured { vk } => {
                        let setting = match vk {
                            0x04 => "MButton",
                            0x05 => "XButton1",
                            0x06 => "XButton2",
                            0xA6 => "BrowserBack",
                            0xA7 => "BrowserForward",
                            _ => "",
                        };
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [shortcut-capture] mouse side button vk={} setting={}", vk, setting)
                        );
                        let _ = dispatch_state.app_handle.emit("mouse-shortcut-captured", serde_json::json!({
                            "setting": setting,
                            "vk": vk,
                        }));
                    }
                }
            }
            log::info!("[ptt] dispatcher thread exited");
            crate::commands::system::write_log_line(
                "[ptt-dispatcher] thread exited normally (recv() returned Err — all senders dropped)"
            );
            // _alive_guard drops here, flips DISPATCHER_ALIVE back to false.
        }).expect("failed to spawn ptt-dispatcher thread");

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
                        log::info!("SetWindowsHookExW succeeded: {:?}", h.0);
                        Some(h)
                    }
                    Err(e) => {
                        log::error!("SetWindowsHookExW failed: {}", e);
                        None
                    }
                }
            };

            let hook = match install_hook() {
                Some(h) => h,
                None => return,
            };

            // 低级鼠标钩子始终随键盘钩子一起挂上：一是支持侧键做 PTT/免提，二是设置页
            // 录制侧键时需要靠它在 OS 层把侧键吞掉（否则 webview 会先把侧键当“后退”）。
            // 它与键盘钩子共用本线程的同一个消息循环；回调对鼠标移动等有最前置的快速放行，
            // 开销可忽略。只有真正命中侧键（录制捕获 / 已绑为热键）时才会吞事件。
            let mouse_hook: Option<windows::Win32::UI::WindowsAndMessaging::HHOOK> =
                match SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), None, 0) {
                    Ok(h) => {
                        log::info!("SetWindowsHookExW(WH_MOUSE_LL) succeeded: {:?}", h.0);
                        crate::commands::system::write_log_line(
                            "[ptt-lifecycle] mouse hook installed (side-button support active)",
                        );
                        Some(h)
                    }
                    Err(e) => {
                        log::error!("SetWindowsHookExW(WH_MOUSE_LL) failed: {}", e);
                        crate::commands::system::write_log_line(&format!(
                            "[ptt-lifecycle] mouse hook FAILED to install: {}", e,
                        ));
                        None
                    }
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
            let _ = UnhookWindowsHookEx(hook);
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

/// 低级鼠标钩子回调：只处理鼠标侧键（XButton1/2）的按下/抬起，复用与键盘钩子
/// 完全相同的 PTT/免提流水线（HookAction -> dispatcher -> emit）。
///
/// ⚠️ 性能：WH_MOUSE_LL 会在**每次鼠标移动**都被调用。因此第一件事就是判断
/// “不是侧键的按下/抬起就立刻放行”，绝不在鼠标移动这条最热的路径上做任何多余的事。
#[cfg(windows)]
unsafe extern "system" fn low_level_mouse_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    let msg = w_param.0 as u32;

    // ── 最热路径：移动/滚轮/其它键一律立刻放行，连结构体都不解引用 ──
    // 只处理侧键(XBUTTON)和中键(MBUTTON)的按下/抬起。
    if n_code < 0
        || (msg != WM_XBUTTONDOWN
            && msg != WM_XBUTTONUP
            && msg != WM_MBUTTONDOWN
            && msg != WM_MBUTTONUP)
    {
        return CallNextHookEx(None, n_code, w_param, l_param);
    }

    let ms = &*(l_param.0 as *const MSLLHOOKSTRUCT);

    // 过滤注入（合成）的鼠标事件，只认真实硬件按键。
    const LLMHF_INJECTED: u32 = 0x00000001;
    if (ms.flags & LLMHF_INJECTED) != 0 {
        return CallNextHookEx(None, n_code, w_param, l_param);
    }

    // 中键：直接是 VK_MBUTTON(0x04)，无需从 mouseData 解码。
    // 侧键：编号在 mouseData 高 16 位：1=XBUTTON1（后退键） 2=XBUTTON2（前进键）。
    let is_middle = msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP;
    let vk: u32 = if is_middle {
        0x04 // VK_MBUTTON
    } else {
        match (ms.mouseData >> 16) & 0xFFFF {
            1 => 0x05, // VK_XBUTTON1
            2 => 0x06, // VK_XBUTTON2
            _ => return CallNextHookEx(None, n_code, w_param, l_param),
        }
    };

    let is_down = msg == WM_XBUTTONDOWN || msg == WM_MBUTTONDOWN;
    let is_up = msg == WM_XBUTTONUP || msg == WM_MBUTTONUP;

    // ── 录制捕获模式：把侧键吞掉并回报给设置页，避免 webview 把它当成“后退”导航 ──
    if SHORTCUT_CAPTURE.load(Ordering::SeqCst) {
        if is_down {
            SHORTCUT_CAPTURE.store(false, Ordering::SeqCst);
            CONSUME_XUP_VK.store(vk, Ordering::SeqCst); // 记住 vk，好把配对的 up 也吞掉
            HOOK_ACTION_TX.with(|tx| {
                if let Some(sender) = tx.borrow().as_ref() {
                    if sender.try_send(HookAction::MouseCaptured { vk }).is_err() {
                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                    }
                }
            });
        }
        return LRESULT(1); // 捕获期间侧键的 down/up 一律吞掉
    }
    // 吞掉“捕获到的那次 down”配对的 up，避免残留“后退”导航。
    if is_up && CONSUME_XUP_VK.load(Ordering::SeqCst) == vk {
        CONSUME_XUP_VK.store(0, Ordering::SeqCst);
        return LRESULT(1);
    }

    let mut consumed = false;

    HOOK_STATE.with(|s| {
        if let Some(state) = s.borrow().as_ref() {
            let is_ptt_key = state.ptt_vk_codes.contains(&vk);
            let is_hf_key = !state.hf_vk_codes.is_empty()
                && state.hf_vk_codes.contains(&vk)
                && !is_ptt_key; // 同一键时 PTT 优先

            if is_ptt_key {
                // 鼠标侧键不涉及键盘修饰键状态，按下和抬起都吞掉，
                // 避免误触发其它程序的“前进/后退”。
                consumed = true;

                if is_down
                    && !state.ptt_key_down.load(Ordering::SeqCst)
                    && !state.hands_free_active.load(Ordering::SeqCst)
                {
                    state.ptt_key_down.store(true, Ordering::SeqCst);
                    let gen = state.ptt_generation.fetch_add(1, Ordering::SeqCst) + 1;
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            if sender.try_send(HookAction::PttDown { vk, gen }).is_err() {
                                TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    });
                }

                if is_up && state.ptt_key_down.load(Ordering::SeqCst) {
                    state.ptt_key_down.store(false, Ordering::SeqCst);
                    if !state.hands_free_active.load(Ordering::SeqCst) {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                if sender.try_send(HookAction::PttUp { vk }).is_err() {
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
                    }
                }
            }

            if is_hf_key {
                // 免提：按下即吞，抬起触发 toggle（需先配对过真实按下，防孤儿抬起误触）。
                if is_down {
                    consumed = true;
                    state.hf_key_down.store(true, Ordering::SeqCst);
                }
                if is_up {
                    let had_down = state.hf_key_down.swap(false, Ordering::SeqCst);
                    if had_down {
                        consumed = true;
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                if sender.try_send(HookAction::HfToggle { vk }).is_err() {
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
                    }
                }
            }
        }
    });

    if consumed {
        return LRESULT(1);
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}

#[cfg(windows)]
unsafe extern "system" fn low_level_keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    // 计时器：无论下面走哪条 return 路径，drop 时都会把本次调用耗时汇报进
    // MAX_CALLBACK_DURATION_US，用来确认回调是否在正常情况下也逼近了 Windows
    // 静默摘除钩子的 ~200ms 阈值。
    let _timer = CallbackTimer(std::time::Instant::now());
    // 任意按键（不限于 PTT 键）都刷新这个时间戳——只要这个值还在正常前进，
    // 就说明 Windows 仍在调用本回调，钩子没有被系统摘除。
    LAST_CALLBACK_MS.store(now_ms(), Ordering::Relaxed);

    if n_code >= 0 {
        let kb = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        let vk = kb.vkCode;
        let msg = w_param.0 as u32;

        // 过滤 Windows 合成的"幻影 Alt"：鼠标点击跨会话边界（如从本机点进远程桌面
        // 窗口）触发焦点切换时，Windows 会自动合成一个 Alt keydown/keyup 用于清理
        // 菜单导航状态，与用户真实按键几乎无法区分——唯二的区别是：
        //   1) LLKHF_INJECTED (0x10) / LLKHF_LOWER_IL_INJECTED (0x02) 标志位被置位；
        //   2) scanCode 通常为 0（真实键盘按键的 scanCode 非零）。
        // 命中任一条件即认为是系统合成按键，直接放行给系统处理，不当作用户按键。
        const LLKHF_INJECTED: u32 = 0x10;
        const LLKHF_LOWER_IL_INJECTED: u32 = 0x02;

        // 保存本次事件的 flags/scanCode，供下方「命中热键时」的诊断日志使用。
        let kb_flags = kb.flags.0;
        let kb_scan_code = kb.scanCode;

        let is_kdown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;

        // ── 侧键录制捕获（键盘侧）：必须放在下面的“幻影过滤”之前，因为罗技等改键鼠标
        //    发出的浏览器后退/前进键通常带“注入”标志，会被幻影过滤器直接丢掉。 ──
        if SHORTCUT_CAPTURE.load(Ordering::SeqCst) {
            // 浏览器后退/前进键 → 作为侧键绑定，并吞掉避免 webview 后退/前进导航。
            if vk == 0xA6 || vk == 0xA7 {
                if is_kdown {
                    SHORTCUT_CAPTURE.store(false, Ordering::SeqCst);
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            let _ = sender.try_send(HookAction::MouseCaptured { vk });
                        }
                    });
                }
                return LRESULT(1);
            }
        }

        // 幻影过滤：注入或 scanCode==0 视为系统合成键，放行、不当作用户按键。
        // 例外：浏览器后退/前进（0xA6/0xA7）常由鼠标驱动“注入”，不能按幻影丢弃——
        // 否则绑成侧键后按下不生效；它们不会是“幻影 Alt”，放行进入匹配是安全的。
        let is_synthetic = ((kb.flags.0 & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0
            || kb.scanCode == 0)
            && vk != 0xA6
            && vk != 0xA7;
        if is_synthetic {
            return CallNextHookEx(None, n_code, w_param, l_param);
        }

        // ── CRITICAL: This callback MUST return within ~200ms or Windows
        // will silently remove the hook. NO blocking operations allowed.
        // All logging and emit are offloaded via try_send to a dispatcher thread.

        let mut consumed = false;

        HOOK_STATE.with(|s| {
            if let Some(state) = s.borrow().as_ref() {
                let is_ptt_key = state.ptt_vk_codes.contains(&vk);
                let is_hf_key = !state.hf_vk_codes.is_empty()
                    && state.hf_vk_codes.contains(&vk)
                    && !is_ptt_key; // PTT takes priority if same key

                // ── 诊断：仅在「当前配置的 PTT/免提热键」被按下时记录 flags/scanCode ──
                // 只记热键本身（不记正常打字的 Ctrl/Shift 等），量可控；用于抓远程桌面
                // 场景下误触发热键的那次事件特征，和真实按键对比后再对症过滤幻影键。
                if (is_ptt_key || is_hf_key) && (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            if sender.try_send(HookAction::Diag {
                                vk, msg_name: "hotkey-down", flags: kb_flags, scan_code: kb_scan_code,
                            }).is_err() {
                                TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    });
                }

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
                                if sender.try_send(HookAction::PttDown { vk, gen }).is_err() {
                                    // 这是最关键的失败点：说明 Windows 已经正确捕获了 PTT
                                    // 按键（钩子本身还活着），但 dispatcher 收不到消息——
                                    // 大概率是 dispatcher 线程已经 panic/退出，导致
                                    // ptt-down 事件永远不会 emit 给前端，悬浮窗自然不会
                                    // 出现。此时 TRY_SEND_FAIL_COUNT 会 > 0。
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
                    }

                    if is_up && state.ptt_key_down.load(Ordering::SeqCst) {
                        state.ptt_key_down.store(false, Ordering::SeqCst);

                        if !state.hands_free_active.load(Ordering::SeqCst) {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    if sender.try_send(HookAction::PttUp { vk }).is_err() {
                                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            });
                        }
                    }
                }

                // 免提键：keyup 时触发 toggle（避免和 keydown repeat 冲突）。
                // ⚠️ 必须校验配对的 keydown：远程桌面等场景下，鼠标点击跨会话边界会让
                // Windows 合成幻影 Alt——其 keydown 常带 INJECTED 标志被 synthetic 过滤器挡掉，
                // 但残留的 keyup 会漏进来。若在 keyup 上无条件 toggle，就会被这种"孤儿 keyup"
                // 误触发（且一次点击可能爆发多次）。因此只有先记录过真实 keydown（hf_key_down=true）
                // 的 keyup 才 toggle。
                if is_hf_key {
                    let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    if is_down {
                        consumed = true; // 吞掉 keydown 防止系统处理
                        state.hf_key_down.store(true, Ordering::SeqCst);
                    }
                    if is_up {
                        // 只有配对过真实 keydown 才 toggle；孤儿 keyup（幻影）直接忽略。
                        let had_down = state.hf_key_down.swap(false, Ordering::SeqCst);
                        if had_down {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    if sender.try_send(HookAction::HfToggle { vk }).is_err() {
                                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            });
                        }
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