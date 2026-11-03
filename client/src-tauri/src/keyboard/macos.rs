//! macOS 全局热键：CGEventTap。
//!
//! 与 Windows 的 `low_level_keyboard_proc` / `low_level_mouse_proc` 一一对应：
//! 事件入口把 macOS 键码翻译成同一套内部键 ID（Windows VK），之后的 PTT 代次、
//! 组合键位图、Esc / 卡片快捷键闸门、看门狗全部复用 mod.rs 里的实现。
//!
//! 与 Windows 不同的几处：
//! - **修饰键永远放行**。macOS 的修饰状态在 HID 层维护，吞掉 flagsChanged 并不能让后续
//!   按键失去该修饰位，反而让前台程序看到「没按下就有修饰位」的错乱状态；macOS 也没有
//!   「单击 Alt 激活菜单栏」的问题，所以不需要 Windows 那套吞 Alt keyup 的处理。
//! - **不会被系统静默摘除**：回调超时或用户输入保护时系统会投递
//!   `kCGEventTapDisabledBy*`，收到后立刻重新启用（另有看门狗兜底）。
//! - **需要「辅助功能」授权**才能建出能吞键的 tap。没授权时每 2 秒重试一次，
//!   用户在系统设置里勾选后不用重启 SayIt。
//! - 自己注入的事件（插字用的 ⌘V）带 `kCGEventSourceUserData` 标记，回调里直接放行。

#![allow(non_upper_case_globals)]

use super::*;
use crate::platform::macos::ffi::*;
use crate::platform::macos::keycodes;
use std::sync::atomic::AtomicUsize;

/// 我们自己 post 的事件在 `kCGEventSourceUserData` 里写这个值（"SAYI"）。
pub(crate) const SAYIT_EVENT_MARKER: i64 = 0x5341_5949;

/// 当前 tap 的 CFMachPortRef（0 = 没装上）。
static TAP_PORT: AtomicUsize = AtomicUsize::new(0);
/// tap 线程的 CFRunLoopRef（0 = 线程没在跑）。
static TAP_RUN_LOOP: AtomicUsize = AtomicUsize::new(0);
/// 请求 tap 线程退出。
static TAP_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
/// tap 被系统停用后由回调重新启用的次数（写进诊断日志）。
static TAP_REENABLED_IN_CALLBACK: AtomicU64 = AtomicU64::new(0);

/// event tap 是否已装上且处于启用状态（给权限/诊断页用）。
pub fn tap_active() -> bool {
    let port = TAP_PORT.load(Ordering::SeqCst) as CFMachPortRef;
    !port.is_null() && unsafe { CGEventTapIsEnabled(port) }
}

/// 看门狗兜底：tap 存在但被停用时重新启用。返回是否做了重启用。
pub fn reenable_tap_if_disabled() -> bool {
    let port = TAP_PORT.load(Ordering::SeqCst) as CFMachPortRef;
    if port.is_null() {
        return false;
    }
    unsafe {
        if CGEventTapIsEnabled(port) {
            return false;
        }
        CGEventTapEnable(port, true);
    }
    true
}

/// 让 tap 线程退出（stop() 调用；线程会自己卸载 tap 并完成收尾）。
pub fn request_tap_thread_stop() {
    TAP_STOP_REQUESTED.store(true, Ordering::SeqCst);
    let run_loop = TAP_RUN_LOOP.load(Ordering::SeqCst) as CFRunLoopRef;
    if !run_loop.is_null() {
        unsafe {
            CFRunLoopStop(run_loop);
            CFRunLoopWakeUp(run_loop);
        }
    }
}

unsafe fn create_tap() -> CFMachPortRef {
    let mask: CGEventMask = (1 << kCGEventKeyDown)
        | (1 << kCGEventKeyUp)
        | (1 << kCGEventFlagsChanged)
        | (1 << kCGEventOtherMouseDown)
        | (1 << kCGEventOtherMouseUp);
    CGEventTapCreate(
        kCGSessionEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionDefault,
        mask,
        tap_callback,
        std::ptr::null_mut(),
    )
}

/// tap 线程主体。结构与 Windows 的 hook_thread 相同：action 队列 → dispatcher 线程，
/// 成员看门狗，退出时按 FIFO 排入配对的 up 和 Shutdown。
pub(super) fn hook_thread(state: Arc<HookSharedState>, tx: std::sync::mpsc::Sender<u32>) {
    log::info!(
        "macOS event tap thread starting, ptt_setting={} vk_codes={:?}",
        state.ptt_setting, state.ptt_vk_codes
    );

    let (action_tx, action_rx) = std::sync::mpsc::channel::<HookAction>();
    let watchdog_action_tx = action_tx.clone();
    let member_watchdog = spawn_ptt_member_watchdog(state.clone(), action_tx.clone());
    let dispatcher_thread = spawn_dispatcher(state.clone(), action_rx, watchdog_action_tx);

    HOOK_STATE.with(|s| *s.borrow_mut() = Some(state.clone()));
    HOOK_ACTION_TX.with(|s| *s.borrow_mut() = Some(action_tx));

    TAP_STOP_REQUESTED.store(false, Ordering::SeqCst);
    let run_loop = unsafe { CFRunLoopGetCurrent() };
    TAP_RUN_LOOP.store(run_loop as usize, Ordering::SeqCst);
    // mac 上没有 Windows 那样的线程消息 id，用 1 占位，告诉 start() 线程已经起来了。
    let _ = tx.send(1);

    // 等授权：没有「辅助功能」授权时 CGEventTapCreate 返回 NULL。
    let mut waiting_logged = false;
    let port = loop {
        if TAP_STOP_REQUESTED.load(Ordering::SeqCst) {
            break std::ptr::null_mut();
        }
        let port = unsafe { create_tap() };
        if !port.is_null() {
            break port;
        }
        if !waiting_logged {
            waiting_logged = true;
            crate::commands::system::write_log_line(&format!(
                "[ptt-lifecycle] event tap unavailable (accessibility_trusted={}); retrying every 2s until permission is granted",
                crate::platform::macos::ax::is_trusted(),
            ));
        }
        for _ in 0..20 {
            if TAP_STOP_REQUESTED.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(100));
        }
    };

    if !port.is_null() {
        unsafe {
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
            CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            TAP_PORT.store(port as usize, Ordering::SeqCst);
            crate::commands::system::write_log_line(&format!(
                "[ptt-lifecycle] event tap installed (waited_for_permission={})",
                waiting_logged
            ));

            while !TAP_STOP_REQUESTED.load(Ordering::SeqCst) {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0, 0);
            }

            TAP_PORT.store(0, Ordering::SeqCst);
            CGEventTapEnable(port, false);
            CFRunLoopRemoveSource(run_loop, source, kCFRunLoopCommonModes);
            CFMachPortInvalidate(port);
            CFRelease(source as CFTypeRef);
            CFRelease(port as CFTypeRef);
        }
        log::info!("macOS event tap removed");
    }
    TAP_RUN_LOOP.store(0, Ordering::SeqCst);

    // 收尾与 Windows 相同：先等成员看门狗退出，再用回调同一个 sender 排入配对 up 和 Shutdown。
    state.ptt_hook_alive.store(false, Ordering::SeqCst);
    if let Some(handle) = member_watchdog {
        if handle.join().is_err() {
            crate::commands::system::write_log_line("[ptt-lifecycle] member watchdog panicked while stopping");
        }
    }
    HOOK_ACTION_TX.with(|s| {
        if let Some(sender) = s.borrow_mut().take() {
            clear_ptt_members(&state);
            let vk = state.ptt_vk_codes.first().copied().unwrap_or(0);
            let _ = queue_ptt_release(&sender, &state.ptt_active_generation, None, vk, "manager_stop");
            let _ = sender.send(HookAction::Shutdown);
        }
    });
    HOOK_STATE.with(|s| *s.borrow_mut() = None);
    if dispatcher_thread.join().is_err() {
        crate::commands::system::write_log_line("[ptt-lifecycle] dispatcher thread panicked while stopping");
    }
}

// ─── 物理按键状态（给看门狗、WebView 回退用）───

/// 这个内部键此刻是否按着。修饰键看修饰标志（区分左右），普通键看键状态，
/// 鼠标键看按钮状态（mac 上能查到，Windows 上查不到）。
///
/// HID 状态表只记真实硬件；远程控制（向日葵等）和自动化工具用 CGEventPost 注入的按键
/// 只记在会话状态表里。只看 HID 的话，远程按住右 ⌥ 说话时看门狗约 2 秒后就会判成
/// 「已松开」把录音掐断。两张表都看：本机键盘两者一致；Windows 的 GetAsyncKeyState
/// 本来也包含注入的按键。
pub(super) unsafe fn is_physically_down(vk: u32) -> bool {
    is_down_in(kCGEventSourceStateHIDSystemState, vk)
        || is_down_in(kCGEventSourceStateCombinedSessionState, vk)
}

unsafe fn is_down_in(state: CGEventSourceStateID, vk: u32) -> bool {
    if let Some(button) = keycodes::mouse_button_for_vk(vk) {
        return CGEventSourceButtonState(state, button);
    }
    if keycodes::is_modifier_vk(vk) {
        let flags = CGEventSourceFlagsState(state);
        return keycodes::modifier_vk_is_down(vk, flags).unwrap_or(false);
    }
    match keycodes::keycode_for_vk(vk) {
        Some(keycode) => CGEventSourceKeyState(state, keycode),
        None => false,
    }
}

/// 单键热键按下时是否带着额外修饰键（带了就整条放行，对应 Windows 的 single_key_blocked_by_modifiers）。
fn single_key_blocked_by_modifiers(vk: u32, flags: CGEventFlags) -> bool {
    single_key_requires_bare_press(vk) && flags & keycodes::BLOCKING_MODIFIER_MASK != 0
}

/// 这一刻是不是**只有** ⌘ 的 ⌘C（卡片「复制」快捷键）。⌘⇧C、⌘⌥C 等都不算。
fn only_command_is_down(flags: CGEventFlags) -> bool {
    flags & kCGEventFlagMaskCommand != 0
        && flags & (kCGEventFlagMaskShift | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate) == 0
}

fn send_action(action: HookAction) {
    HOOK_ACTION_TX.with(|tx| {
        if let Some(sender) = tx.borrow().as_ref() {
            if sender.send(action).is_err() {
                TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
            }
        }
    });
}

fn queue_release(state: &HookSharedState, vk: u32, reason: &'static str) {
    HOOK_ACTION_TX.with(|tx| {
        if let Some(sender) = tx.borrow().as_ref() {
            let _ = queue_ptt_release(sender, &state.ptt_active_generation, None, vk, reason);
        }
    });
}

/// PTT 成员按下：记账，凑齐整个组合时开始一次新的 PTT 代次。
fn press_member(state: &HookSharedState, member_index: usize, vk: u32) {
    let member_bit = 1_u64 << member_index;
    state.ptt_last_down_ms[member_index].store(now_ms(), Ordering::SeqCst);
    let became_complete = press_ptt_member(&state.ptt_pressed_mask, member_index, state.ptt_full_mask);
    if !became_complete || state.hands_free_active.load(Ordering::SeqCst) {
        return;
    }
    if let Some(gen) = begin_ptt_press(&state.ptt_active_generation, &state.ptt_generation) {
        HOOK_ACTION_TX.with(|tx| {
            if let Some(sender) = tx.borrow().as_ref() {
                if sender.send(HookAction::PttDown { vk, gen }).is_err() {
                    let _ = release_ptt_member(&state.ptt_pressed_mask, member_index);
                    state.ptt_consumed_down_mask.fetch_and(!member_bit, Ordering::SeqCst);
                    cancel_ptt_press_start(&state.ptt_active_generation, gen);
                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
    }
}

// ─── 系统快捷键接不住的组合键 ───
//
// 免提、AI 整理开关、润色模式切换的组合键平时走系统的 RegisterEventHotKey
// （tauri-plugin-global-shortcut，见 commands/shortcuts.rs）：「安全输入」期间（密码框等）
// 它照样有效，event tap 却收不到按键，所以能交给系统的都交给系统。
//
// 但从 macOS 15 起，修饰键只有 ⌥、只有 ⇧ 或只有 ⌥⇧ 的组合注册「成功」却永远不触发。
// Windows 上 Alt 组合很常见，从 Windows 导入的配置也会带过来。这一类改由 event tap 匹配：
// 命中就吞掉主键的按下、自动重复和抬起（修饰键照常放行），再发出和系统快捷键相同的事件。

/// 组合键触发的动作，与 commands/shortcuts.rs 里系统快捷键发出的事件一一对应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TapComboAction {
    HandsFree,
    AiToggle,
    Preset(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TapCombo {
    /// 必须按着、而且只能按着的修饰键（⌘ ⌃ ⌥ ⇧ 的 kCGEventFlagMask* 组合）
    modifiers: CGEventFlags,
    /// 主键（内部键 ID，沿用 Windows VK）
    vk: u32,
    action: TapComboAction,
}

static TAP_COMBOS: std::sync::Mutex<Vec<TapCombo>> = std::sync::Mutex::new(Vec::new());
/// 正被吞掉的组合键主键（0 = 没有）。它的自动重复和抬起也要吞掉，不能漏给前台程序。
static TAP_COMBO_HELD_VK: AtomicU32 = AtomicU32::new(0);

/// 组合键比对的修饰键：只看这四个，Caps Lock、Fn、小键盘这些标志不看。
const COMBO_MODIFIER_MASK: CGEventFlags =
    kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift;

/// 把 accelerator（如 `Alt+Shift+D`）换成交给 event tap 的组合键。
///
/// 只接系统快捷键在 macOS 15 上接不住的那一类：修饰键只有 ⌥ / ⇧。带 ⌘ 或 ⌃ 的、解析不了的、
/// 主键在 Mac 键盘上没有的，返回 None，照旧交给系统快捷键。
pub(crate) fn tap_combo_for_accelerator(accelerator: &str, action: TapComboAction) -> Option<TapCombo> {
    use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
    let shortcut: Shortcut = accelerator.parse().ok()?;
    if shortcut.mods.intersects(Modifiers::SUPER | Modifiers::META | Modifiers::CONTROL) {
        return None;
    }
    let mut modifiers: CGEventFlags = 0;
    if shortcut.mods.contains(Modifiers::ALT) {
        modifiers |= kCGEventFlagMaskAlternate;
    }
    if shortcut.mods.contains(Modifiers::SHIFT) {
        modifiers |= kCGEventFlagMaskShift;
    }
    if modifiers == 0 {
        return None;
    }
    let vk = vk_for_combo_key(&shortcut.key.to_string())?;
    keycodes::keycode_for_vk(vk)?;
    Some(TapCombo { modifiers, vk, action })
}

/// 组合键主键（DOM code 写法，如 `KeyD`、`F5`、`Comma`）→ 内部 VK。
/// 字母、数字、F 键、方向键等沿用按住说话的映射，再补上标点和小键盘。
fn vk_for_combo_key(code: &str) -> Option<u32> {
    if let Some(vk) = vk_for_ptt_code(code) {
        return Some(vk);
    }
    let vk = match code {
        "Semicolon" => 0xBA,
        "Equal" => 0xBB,
        "Comma" => 0xBC,
        "Minus" => 0xBD,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "Backquote" => 0xC0,
        "BracketLeft" => 0xDB,
        "Backslash" => 0xDC,
        "BracketRight" => 0xDD,
        "Quote" => 0xDE,
        "NumpadMultiply" => 0x6A,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadDecimal" => 0x6E,
        "NumpadDivide" => 0x6F,
        _ => {
            let digit = code.strip_prefix("Numpad")?;
            if digit.len() != 1 {
                return None;
            }
            0x60 + digit.parse::<u32>().ok()?
        }
    };
    Some(vk)
}

/// 换一套交给 event tap 的组合键（每次重新注册全局快捷键时调用，空表 = 不接任何组合）。
pub(crate) fn set_tap_combos(combos: Vec<TapCombo>) {
    if let Ok(mut current) = TAP_COMBOS.lock() {
        *current = combos;
    }
    TAP_COMBO_HELD_VK.store(0, Ordering::SeqCst);
}

/// 主键按下时，修饰键必须和登记的完全一致：多按了 ⌘ 或少按了 ⇧ 都不算。
fn match_tap_combo(combos: &[TapCombo], vk: u32, flags: CGEventFlags) -> Option<TapComboAction> {
    let pressed = flags & COMBO_MODIFIER_MASK;
    combos
        .iter()
        .find(|combo| combo.vk == vk && combo.modifiers == pressed)
        .map(|combo| combo.action.clone())
}

/// 一次非修饰键事件是不是登记的组合键。返回 true = 吞掉。
fn handle_tap_combo(vk: u32, is_kdown: bool, is_kup: bool, flags: CGEventFlags) -> bool {
    if is_kup {
        return TAP_COMBO_HELD_VK
            .compare_exchange(vk, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
    }
    if !is_kdown {
        return false;
    }
    let action = match TAP_COMBOS.lock() {
        Ok(combos) if !combos.is_empty() => match_tap_combo(&combos, vk, flags),
        _ => None,
    };
    let Some(action) = action else {
        // 同一个键这次不带组合的修饰键：说明错过了上次的抬起（比如 tap 刚好被系统停用），
        // 把「按住中」清掉，免得这个键接下来的正常按键被当成自动重复吞掉
        let _ = TAP_COMBO_HELD_VK.compare_exchange(vk, 0, Ordering::SeqCst, Ordering::SeqCst);
        return false;
    };
    // 自动重复：同一次按住只触发一次
    if TAP_COMBO_HELD_VK.swap(vk, Ordering::SeqCst) == vk {
        return true;
    }
    send_action(match action {
        TapComboAction::HandsFree => HookAction::HfToggle { vk },
        TapComboAction::AiToggle => HookAction::AiToggle { vk },
        TapComboAction::Preset(preset_id) => HookAction::PresetSwitch { preset_id },
    });
    true
}

// ─── 回调 ───

unsafe extern "C" fn tap_callback(
    _proxy: CGEventTapProxy,
    event_type: CGEventType,
    event: CGEventRef,
    _user_info: *mut std::ffi::c_void,
) -> CGEventRef {
    let _timer = CallbackTimer(std::time::Instant::now());
    LAST_CALLBACK_MS.store(now_ms(), Ordering::Relaxed);

    if event_type == kCGEventTapDisabledByTimeout || event_type == kCGEventTapDisabledByUserInput {
        let port = TAP_PORT.load(Ordering::SeqCst) as CFMachPortRef;
        if !port.is_null() {
            CGEventTapEnable(port, true);
        }
        let count = TAP_REENABLED_IN_CALLBACK.fetch_add(1, Ordering::SeqCst) + 1;
        send_action(HookAction::Diag {
            vk: 0,
            msg_name: if event_type == kCGEventTapDisabledByTimeout {
                "tap-disabled-by-timeout-reenabled"
            } else {
                "tap-disabled-by-user-input-reenabled"
            },
            flags: count as u32,
            scan_code: 0,
        });
        return event;
    }
    if event.is_null() {
        return event;
    }
    // 自己 post 的事件（插字的 ⌘V）不是用户按键
    if CGEventGetIntegerValueField(event, kCGEventSourceUserData) == SAYIT_EVENT_MARKER {
        return event;
    }

    let consumed = match event_type {
        kCGEventKeyDown | kCGEventKeyUp | kCGEventFlagsChanged => handle_key_event(event_type, event),
        kCGEventOtherMouseDown | kCGEventOtherMouseUp => handle_mouse_event(event_type, event),
        _ => false,
    };
    if consumed {
        std::ptr::null_mut()
    } else {
        event
    }
}

unsafe fn handle_key_event(event_type: CGEventType, event: CGEventRef) -> bool {
    let keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) as CGKeyCode;
    let flags = CGEventGetFlags(event);
    if event_type == kCGEventFlagsChanged {
        // Caps Lock 和未知修饰键不在表里：直接放行
        let Some(vk) = keycodes::modifier_vk_for_keycode(keycode) else { return false };
        let down = keycodes::modifier_is_down(keycode, flags);
        process_key(vk, down, !down, true, flags);
        // 修饰键永远放行（见文件头）
        false
    } else {
        let Some(vk) = keycodes::vk_for_keycode(keycode) else { return false };
        process_key(vk, event_type == kCGEventKeyDown, event_type == kCGEventKeyUp, false, flags)
    }
}

/// 一个已归一化的按键事件。返回 true = 吞掉。逻辑与 Windows 的 `low_level_keyboard_proc`
/// 逐段对应（顺序也一样：录制捕获 → Esc → 卡片 ⌘C → PTT / 免提 / AI 开关）。
fn process_key(vk: u32, is_kdown: bool, is_kup: bool, is_modifier: bool, flags: CGEventFlags) -> bool {
    // ── 设置页录制快捷键：先结束仍活动的 PTT，然后一律放行给 webview 去绑定 ──
    if SHORTCUT_CAPTURE.load(Ordering::SeqCst) {
        HOOK_STATE.with(|s| {
            if let Some(state) = s.borrow().as_ref() {
                clear_ptt_members(state);
                if let Some(&ptt_vk) = state.ptt_vk_codes.first() {
                    queue_release(state, ptt_vk, "shortcut_capture");
                }
                state.hf_key_down.store(false, Ordering::SeqCst);
            }
        });
        // WebKit 不给 Fn 发 DOM 事件，由这里回报（复用 mouse-shortcut-captured 通道）
        if vk == keycodes::VK_FN && is_kdown {
            SHORTCUT_CAPTURE.store(false, Ordering::SeqCst);
            send_action(HookAction::MouseCaptured { vk });
        }
        return false;
    }

    // ── 悬浮窗不聚焦：录音中/处理中/结果卡的 Esc 在这里全局捕获 ──
    const VK_ESCAPE: u32 = 0x1B;
    if vk == VK_ESCAPE {
        if is_kdown {
            if ESCAPE_KEY_DOWN.load(Ordering::SeqCst) {
                return true;
            }
            let (mode, token) = active_escape_action();
            if mode != ESCAPE_MODE_OFF {
                if !ESCAPE_KEY_DOWN.swap(true, Ordering::SeqCst) {
                    send_action(HookAction::Escape { mode, token });
                }
                return true;
            }
        }
        if is_kup && ESCAPE_KEY_DOWN.swap(false, Ordering::SeqCst) {
            return true;
        }
    }

    // ── 结果卡的 ⌘C（Windows 是 Ctrl+C）：只在卡片可见、且前台还是弹卡时那个程序时接管 ──
    const VK_C: u32 = 0x43;
    if vk == VK_C {
        if is_kdown {
            if CARD_HOTKEY_C_DOWN.load(Ordering::SeqCst) {
                return true;
            }
            let (mask, token) = active_card_hotkeys();
            if mask & CARD_HOTKEY_COPY != 0 && only_command_is_down(flags) && card_hotkey_foreground_matches() {
                CARD_HOTKEY_C_DOWN.store(true, Ordering::SeqCst);
                send_action(HookAction::CardHotkey { action: CARD_HOTKEY_COPY, token });
                return true;
            }
        }
        if is_kup && CARD_HOTKEY_C_DOWN.swap(false, Ordering::SeqCst) {
            return true;
        }
    }

    // ── 系统快捷键接不住、交给 event tap 的组合键（只带 ⌥ / ⇧，见 TAP_COMBOS）──
    if !is_modifier && handle_tap_combo(vk, is_kdown, is_kup, flags) {
        return true;
    }

    let mut consumed = false;
    HOOK_STATE.with(|s| {
        let borrowed = s.borrow();
        let Some(state) = borrowed.as_ref() else { return };

        let ptt_member = ptt_member_index(&state.ptt_vk_codes, vk);
        let is_ptt_key = ptt_member.is_some();
        let is_hf_key = !state.hf_vk_codes.is_empty() && state.hf_vk_codes.contains(&vk) && !is_ptt_key;
        let is_ai_toggle_key = !state.ai_toggle_vk_codes.is_empty()
            && state.ai_toggle_vk_codes.contains(&vk)
            && !is_ptt_key
            && !is_hf_key;

        // 单键热键必须裸按才算命中（只看 keydown；keyup 一律照常处理，否则会停不下来）
        let modifiers_block_down = single_key_blocked_by_modifiers(vk, flags);

        let should_log_hotkey_down = is_kdown
            && ((ptt_member.is_some_and(|index| state.ptt_pressed_mask.load(Ordering::SeqCst) & (1_u64 << index) == 0)
                && !state.hands_free_active.load(Ordering::SeqCst))
                || (is_hf_key && !state.hf_key_down.load(Ordering::SeqCst)));
        if should_log_hotkey_down {
            send_action(HookAction::Diag {
                vk,
                msg_name: if modifiers_block_down { "hotkey-down-with-modifier" } else { "hotkey-down" },
                flags: flags as u32,
                scan_code: 0,
            });
        }

        if let Some(member_index) = ptt_member {
            if is_kdown {
                unsafe { reconcile_stale_ptt_members_before_down(state, member_index) };
            }
            let member_bit = 1_u64 << member_index;
            let is_combo = state.ptt_vk_codes.len() > 1;
            let is_pure_modifier_combo = is_combo && state.ptt_modifier_mask == state.ptt_full_mask;
            let is_main_key = state.ptt_modifier_mask & member_bit == 0;
            let bare_press_violated = !is_combo && modifiers_block_down;

            if !is_combo {
                if is_kdown && !bare_press_violated {
                    consumed = true;
                }
            } else if !is_pure_modifier_combo && is_main_key {
                if is_kdown {
                    let consume_this_press = should_consume_combo_main_down(
                        state.ptt_pressed_mask.load(Ordering::SeqCst),
                        state.ptt_consumed_down_mask.load(Ordering::SeqCst),
                        member_bit,
                        state.ptt_modifier_mask,
                    );
                    if consume_this_press {
                        state.ptt_consumed_down_mask.fetch_or(member_bit, Ordering::SeqCst);
                        consumed = true;
                    }
                }
                if is_kup && state.ptt_consumed_down_mask.fetch_and(!member_bit, Ordering::SeqCst) & member_bit != 0 {
                    consumed = true;
                }
            }

            if is_kdown && !bare_press_violated {
                press_member(state, member_index, vk);
            }
            if is_kup && release_ptt_member(&state.ptt_pressed_mask, member_index) {
                queue_release(state, vk, "member_keyup");
            }
        }

        // 免提：首个按下立即触发，repeat 忽略，抬起重新布防
        if is_hf_key {
            if is_kdown && !modifiers_block_down {
                consumed = true;
                if begin_hf_press(&state.hf_key_down) {
                    send_action(HookAction::HfToggle { vk });
                }
            }
            if is_kup && end_hf_press(&state.hf_key_down) {
                consumed = true;
            }
        }

        if is_ai_toggle_key {
            if is_kdown && !modifiers_block_down {
                consumed = true;
                if begin_hf_press(&state.ai_toggle_key_down) {
                    send_action(HookAction::AiToggle { vk });
                }
            }
            if is_kup && end_hf_press(&state.ai_toggle_key_down) {
                consumed = true;
            }
        }
    });

    consumed && !is_modifier
}

/// 鼠标中键 / 侧键。逻辑与 Windows 的 `low_level_mouse_proc` 对应。
unsafe fn handle_mouse_event(event_type: CGEventType, event: CGEventRef) -> bool {
    let button = CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
    let Some(vk) = keycodes::vk_for_mouse_button(button) else { return false };
    let is_down = event_type == kCGEventOtherMouseDown;
    let is_up = event_type == kCGEventOtherMouseUp;

    // 录制捕获：吞掉并回报，避免 webview 把侧键当「后退」导航
    if SHORTCUT_CAPTURE.load(Ordering::SeqCst) {
        if is_down {
            SHORTCUT_CAPTURE.store(false, Ordering::SeqCst);
            CONSUME_XUP_VK.store(vk, Ordering::SeqCst);
            send_action(HookAction::MouseCaptured { vk });
        }
        return true;
    }
    if is_up && CONSUME_XUP_VK.load(Ordering::SeqCst) == vk {
        CONSUME_XUP_VK.store(0, Ordering::SeqCst);
        return true;
    }

    let mut consumed = false;
    HOOK_STATE.with(|s| {
        let borrowed = s.borrow();
        let Some(state) = borrowed.as_ref() else { return };
        let ptt_member = ptt_member_index(&state.ptt_vk_codes, vk);
        let is_ptt_key = ptt_member.is_some();
        let is_hf_key = !state.hf_vk_codes.is_empty() && state.hf_vk_codes.contains(&vk) && !is_ptt_key;
        let is_ai_toggle_key = !state.ai_toggle_vk_codes.is_empty()
            && state.ai_toggle_vk_codes.contains(&vk)
            && !is_ptt_key
            && !is_hf_key;

        if let Some(member_index) = ptt_member {
            consumed = true;
            if is_down {
                press_member(state, member_index, vk);
            }
            if is_up && release_ptt_member(&state.ptt_pressed_mask, member_index) {
                queue_release(state, vk, "keyup");
            }
        }
        if is_hf_key {
            if is_down {
                consumed = true;
                if begin_hf_press(&state.hf_key_down) {
                    send_action(HookAction::HfToggle { vk });
                }
            }
            if is_up && end_hf_press(&state.hf_key_down) {
                consumed = true;
            }
        }
        if is_ai_toggle_key {
            if is_down {
                consumed = true;
                if begin_hf_press(&state.ai_toggle_key_down) {
                    send_action(HookAction::AiToggle { vk });
                }
            }
            if is_up && end_hf_press(&state.ai_toggle_key_down) {
                consumed = true;
            }
        }
    });
    consumed
}

/// 当前 macOS 的「最后一次输入距今多少毫秒」（对应 GetLastInputInfo）。
#[allow(dead_code)]
pub(super) fn last_input_age_ms() -> Option<i64> {
    let secs = unsafe { CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType) };
    (secs.is_finite() && secs >= 0.0).then(|| (secs * 1000.0) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_press_blocks_main_keys_with_modifiers_but_not_modifier_hotkeys() {
        // F5 带 ⌥：放行
        assert!(single_key_blocked_by_modifiers(0x74, kCGEventFlagMaskAlternate));
        // F5 只带 Fn 位（功能键自带）：不算修饰
        assert!(!single_key_blocked_by_modifiers(0x74, kCGEventFlagMaskSecondaryFn));
        // 右 ⌥ 本身是热键：不套裸按规则
        assert!(!single_key_blocked_by_modifiers(0xA5, kCGEventFlagMaskAlternate));
    }

    #[test]
    fn card_copy_requires_command_only() {
        assert!(only_command_is_down(kCGEventFlagMaskCommand));
        assert!(!only_command_is_down(kCGEventFlagMaskCommand | kCGEventFlagMaskShift));
        assert!(!only_command_is_down(kCGEventFlagMaskControl));
    }

    #[test]
    fn last_input_age_is_reported() {
        assert!(last_input_age_ms().is_some());
    }

    #[test]
    fn option_and_shift_only_combos_go_to_the_event_tap() {
        let combo = tap_combo_for_accelerator("Alt+Shift+D", TapComboAction::HandsFree).unwrap();
        assert_eq!(combo.modifiers, kCGEventFlagMaskAlternate | kCGEventFlagMaskShift);
        assert_eq!(combo.vk, 0x44);
        assert_eq!(combo.action, TapComboAction::HandsFree);
        let f5 = tap_combo_for_accelerator("Shift+F5", TapComboAction::AiToggle).unwrap();
        assert_eq!((f5.modifiers, f5.vk), (kCGEventFlagMaskShift, 0x74));
        let comma = tap_combo_for_accelerator("Alt+Shift+Comma", TapComboAction::Preset("p".into())).unwrap();
        assert_eq!(comma.vk, 0xBC);
        assert_eq!(tap_combo_for_accelerator("Alt+Shift+Numpad3", TapComboAction::HandsFree).map(|c| c.vk), Some(0x63));
        assert_eq!(tap_combo_for_accelerator("Option+Shift+1", TapComboAction::HandsFree).map(|c| c.vk), Some(0x31));
    }

    #[test]
    fn combos_with_command_or_control_stay_with_the_system_hotkey() {
        for accel in ["Control+Alt+D", "CommandOrControl+Shift+D", "Command+Alt+K", "Control+F5"] {
            assert!(tap_combo_for_accelerator(accel, TapComboAction::HandsFree).is_none(), "{accel}");
        }
        // 解析不了的、Mac 键盘上没有的、根本不是组合键的：也交回系统快捷键那边处理
        for accel in ["Alt+Shift+Return", "Alt+F24", "Alt+", "D", "Alt+Shift+Î"] {
            assert!(tap_combo_for_accelerator(accel, TapComboAction::HandsFree).is_none(), "{accel}");
        }
    }

    #[test]
    fn tap_combo_needs_exactly_the_registered_modifiers() {
        let combos = vec![tap_combo_for_accelerator("Alt+Shift+D", TapComboAction::HandsFree).unwrap()];
        let opt_shift = kCGEventFlagMaskAlternate | kCGEventFlagMaskShift;
        assert_eq!(match_tap_combo(&combos, 0x44, opt_shift), Some(TapComboAction::HandsFree));
        // Caps Lock、Fn 这些标志不影响
        assert_eq!(
            match_tap_combo(&combos, 0x44, opt_shift | kCGEventFlagMaskAlphaShift | kCGEventFlagMaskSecondaryFn),
            Some(TapComboAction::HandsFree)
        );
        // 多按了 ⌘、少按了 ⇧、换了主键，都不算
        assert_eq!(match_tap_combo(&combos, 0x44, opt_shift | kCGEventFlagMaskCommand), None);
        assert_eq!(match_tap_combo(&combos, 0x44, kCGEventFlagMaskAlternate), None);
        assert_eq!(match_tap_combo(&combos, 0x45, opt_shift), None);
    }

    #[test]
    fn tap_combo_fires_once_and_swallows_its_repeats_and_key_up_only() {
        let (tx, rx) = std::sync::mpsc::channel();
        HOOK_ACTION_TX.with(|cell| *cell.borrow_mut() = Some(tx));
        set_tap_combos(vec![
            tap_combo_for_accelerator("Alt+Shift+D", TapComboAction::HandsFree).unwrap(),
            tap_combo_for_accelerator("Alt+Shift+2", TapComboAction::Preset("email".into())).unwrap(),
        ]);
        let opt_shift = kCGEventFlagMaskAlternate | kCGEventFlagMaskShift;

        assert!(handle_tap_combo(0x44, true, false, opt_shift)); // 按下：触发并吞掉
        assert!(handle_tap_combo(0x44, true, false, opt_shift)); // 自动重复：吞掉，不再触发
        assert!(handle_tap_combo(0x44, false, true, opt_shift)); // 抬起：吞掉
        assert!(!handle_tap_combo(0x44, true, false, 0)); // 单按 D：照常打字
        assert!(!handle_tap_combo(0x44, false, true, 0));
        assert!(!handle_tap_combo(0x45, true, false, opt_shift)); // ⌥⇧E 没登记
        assert!(handle_tap_combo(0x32, true, false, opt_shift)); // ⌥⇧2 → 切换润色模式
        assert!(handle_tap_combo(0x32, false, true, 0)); // 先松修饰键再松 2：抬起照样吞掉

        // 错过了抬起：同一个键不带修饰键再按，就不算「按住中」了
        assert!(handle_tap_combo(0x44, true, false, opt_shift));
        assert!(!handle_tap_combo(0x44, true, false, 0));
        assert!(!handle_tap_combo(0x44, false, true, 0));

        let actions: Vec<HookAction> = rx.try_iter().collect();
        assert_eq!(actions.len(), 3, "按下三次组合键，触发三次");
        assert!(matches!(actions[0], HookAction::HfToggle { vk: 0x44 }));
        assert!(matches!(&actions[1], HookAction::PresetSwitch { preset_id } if preset_id.as_str() == "email"));
        assert!(matches!(actions[2], HookAction::HfToggle { vk: 0x44 }));

        set_tap_combos(Vec::new());
        HOOK_ACTION_TX.with(|cell| *cell.borrow_mut() = None);
    }
}
