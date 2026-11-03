//! Global keyboard hook for PTT (Push-to-Talk) functionality.
//!
//! Uses Win32 SetWindowsHookExW(WH_KEYBOARD_LL) to capture key events globally.
//! Runs the message loop on a dedicated thread.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::{tap_active, SAYIT_EVENT_MARKER};
#[cfg(target_os = "macos")]
pub(crate) use macos::{set_tap_combos, tap_combo_for_accelerator, TapCombo, TapComboAction};

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU32, AtomicU64, Ordering};
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

// ── "录制捕获"模式 ──
// 设置页录制快捷键时，前端会打开这个开关。开启后：
//  - 鼠标钩子把下一个侧键(XBUTTON)按下吞掉并回报，webview 不会当成“后退”导航；
//  - 键盘钩子把浏览器后退/前进键(0xA6/0xA7，罗技等改键鼠标常把侧键映射成这个)也
//    吞掉并回报；
//  - 键盘钩子放行已绑定的 PTT/免提单键，不触发录音——录制时按到旧热键应当是"想把它
//    录进来"（或看到冲突提示），而不是开始口述。
static SHORTCUT_CAPTURE: AtomicBool = AtomicBool::new(false);
/// 捕获到侧键 down 后，记住其 vk，好把配对的 up 也一并吞掉（否则可能残留导航）。
static CONSUME_XUP_VK: AtomicU32 = AtomicU32::new(0);

/// 打开/关闭录制捕获模式（供设置页录制快捷键时调用）。
pub fn set_shortcut_capture(on: bool) {
    SHORTCUT_CAPTURE.store(on, Ordering::SeqCst);
    // 只在“开始录制”时清零，作为一次干净的起点。
    // 绝不在“结束录制”时清零——因为捕获到 down 后配对的 up 往往稍晚才到，
    // 若在结束时就清掉，这个“抬起”就会漏给 webview（后退键会导致页面返回）。
    if on {
        CONSUME_XUP_VK.store(0, Ordering::SeqCst);
        // 录制时可能按侧键，鼠标钩子必须在场才能把它吞掉（见 needs_mouse_hook）。
        // 钩子只能装在钩子线程上，所以发消息让那边装。
        #[cfg(windows)]
        {
            let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
            if tid != 0 {
                unsafe {
                    let _ = PostThreadMessageW(tid, WM_SAYIT_NEED_MOUSE_HOOK, WPARAM(0), LPARAM(0));
                }
            }
        }
    }
}

/// 键盘钩子线程的 id，用来从别的线程让它装上鼠标钩子。0 = 钩子线程没在跑。
#[cfg_attr(not(windows), allow(dead_code))]
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// 发给钩子线程的私有消息（WM_APP + 0x51）：「现在需要鼠标钩子」。
#[cfg(windows)]
const WM_SAYIT_NEED_MOUSE_HOOK: u32 = 0x8000 + 0x51;
/// 发给钩子线程的私有消息（WM_APP + 0x52）：「钩子可能被系统摘了，重装一遍」。
#[cfg(windows)]
const WM_SAYIT_REFRESH_HOOKS: u32 = 0x8000 + 0x52;
/// 已经因为怀疑被摘而重装过几次（写进 [ptt-watchdog] 日志）。
static HOOK_REFRESH_COUNT: AtomicU32 = AtomicU32::new(0);

/// 低级钩子回调超过 LowLevelHooksTimeout（系统卡顿、休眠唤醒时常见）会被 Windows **静默摘除**，
/// 不发任何通知；之后热键全部失灵，直到重启 SayIt。
///
/// 判据：系统记录的「最后一次输入」比钩子最后一次被调用晚了 5 秒以上，说明有输入没经过我们。
/// 会误报：没绑鼠标键时不装鼠标钩子，只动鼠标也算输入。误报的代价只是重装一次钩子
/// （几微秒，在钩子线程里先装新的再卸旧的，中间不会处理任何按键，所以不会漏也不会重复），
/// 所以宁可多装，每分钟最多一次。
#[cfg_attr(not(windows), allow(dead_code))]
fn hook_looks_removed(callback_age_ms: i64, input_age_ms: i64) -> bool {
    callback_age_ms >= 0 && input_age_ms >= 0 && callback_age_ms - input_age_ms > 5_000
}

/// 系统最后一次输入（键盘或鼠标）距今多少毫秒。
#[cfg(windows)]
fn last_input_age_ms() -> Option<i64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if !GetLastInputInfo(&mut info).as_bool() {
            return None;
        }
        Some(GetTickCount().wrapping_sub(info.dwTime) as i64)
    }
}

/// 鼠标钩子只在用得上时才装：某个热键绑在鼠标键上（侧键 / 中键），或者正在录制快捷键。
///
/// 原来它随键盘钩子一直挂着。回调虽然对鼠标移动最先放行，但每次移动仍要经过一次
/// 跨进程回调，高回报率的游戏鼠标每秒上千次。绝大多数用户根本没绑鼠标键。
/// 录制时装上的钩子留到下次重配（保存绑定后就会重配）才按绑定重新决定，
/// 这样捕获到侧键后配对的那个抬起照样能被吞掉（pitfalls #6）。
#[cfg_attr(not(windows), allow(dead_code))]
fn needs_mouse_hook(ptt: &[u32], hf: &[u32], ai_toggle: &[u32], capturing: bool) -> bool {
    capturing || ptt.iter().chain(hf).chain(ai_toggle).any(|vk| is_mouse_vk(*vk))
}

// ── 全局 Esc 动作 ──
// overlay 不抢焦点，用户按键仍发给原应用，因此必须在现有 WH_KEYBOARD_LL 中捕获。
// 仅由前端在 recording/processing/fallback 可见期间短暂开启，并设置硬截止时间作为安全网。
const ESCAPE_MODE_OFF: u32 = 0;
const ESCAPE_MODE_CANCEL_PROCESSING: u32 = 1;
const ESCAPE_MODE_DISMISS_FALLBACK: u32 = 2;
const ESCAPE_MODE_CANCEL_RECORDING: u32 = 3;
/// 处理已超时、正在宽限期里等迟到结果时按 Esc：放弃等待。
/// 必须和 dismiss_fallback 分开 —— 它除了收起提示，还要让随后到达的迟到结果
/// **不再自动插字**（否则界面说着"失败"，文字却突然出现在输入框里）。
const ESCAPE_MODE_ABANDON_LATE_RESULT: u32 = 4;
static ESCAPE_ACTION_MODE: AtomicU32 = AtomicU32::new(ESCAPE_MODE_OFF);
static ESCAPE_ACTION_TOKEN: AtomicU64 = AtomicU64::new(0);
static ESCAPE_ACTION_DEADLINE_MS: AtomicI64 = AtomicI64::new(0);
static ESCAPE_KEY_DOWN: AtomicBool = AtomicBool::new(false);

pub fn set_escape_action_mode(mode: &str, token: u64) -> Result<(), String> {
    let (value, ttl_ms) = match mode {
        "off" => (ESCAPE_MODE_OFF, 0),
        // 录音硬上限约 5 分钟；留足安全余量，但异常状态也不会永久吞 Esc。
        "cancel_recording" => (ESCAPE_MODE_CANCEL_RECORDING, 11 * 60 * 1000),
        "cancel_processing" => (ESCAPE_MODE_CANCEL_PROCESSING, 2 * 60 * 1000),
        // 结果卡/失败卡不再自动消失，改由前端在可见期间续期，所以这里的 TTL 只是
        // 异常兜底（渲染端卡死时不至于永久吞 Esc）。续期间隔必须明显小于它。
        "dismiss_fallback" => (ESCAPE_MODE_DISMISS_FALLBACK, 30 * 1000),
        // 宽限期最长 LATE_FINAL_GRACE_MS（15s），留足余量。
        "abandon_late_result" => (ESCAPE_MODE_ABANDON_LATE_RESULT, 60 * 1000),
        _ => return Err(format!("Unknown Escape action mode: {mode}")),
    };
    // 先关闭模式，再按 token/deadline/final mode 的顺序发布一组一致快照。
    // 钩子只有看到最终非 off 模式后才会读取对应 token。
    ESCAPE_ACTION_MODE.store(ESCAPE_MODE_OFF, Ordering::SeqCst);
    ESCAPE_ACTION_TOKEN.store(if value == ESCAPE_MODE_OFF { 0 } else { token }, Ordering::SeqCst);
    ESCAPE_ACTION_DEADLINE_MS.store(
        if value == ESCAPE_MODE_OFF { 0 } else { now_ms() + ttl_ms },
        Ordering::SeqCst,
    );
    ESCAPE_ACTION_MODE.store(value, Ordering::SeqCst);
    Ok(())
}

fn active_escape_action() -> (u32, u64) {
    let mode = ESCAPE_ACTION_MODE.load(Ordering::SeqCst);
    if mode == ESCAPE_MODE_OFF {
        return (ESCAPE_MODE_OFF, 0);
    }
    if now_ms() > ESCAPE_ACTION_DEADLINE_MS.load(Ordering::SeqCst) {
        ESCAPE_ACTION_MODE.store(ESCAPE_MODE_OFF, Ordering::SeqCst);
        ESCAPE_ACTION_TOKEN.store(0, Ordering::SeqCst);
        ESCAPE_ACTION_DEADLINE_MS.store(0, Ordering::SeqCst);
        return (ESCAPE_MODE_OFF, 0);
    }
    (mode, ESCAPE_ACTION_TOKEN.load(Ordering::SeqCst))
}

fn escape_action_mode_name(mode: u32) -> &'static str {
    match mode {
        ESCAPE_MODE_CANCEL_RECORDING => "cancel_recording",
        ESCAPE_MODE_CANCEL_PROCESSING => "cancel_processing",
        ESCAPE_MODE_DISMISS_FALLBACK => "dismiss_fallback",
        ESCAPE_MODE_ABANDON_LATE_RESULT => "abandon_late_result",
        _ => "off",
    }
}

// ── 悬浮窗卡片快捷键（与卡片生命周期绑定的临时组合键）──
//
// 为什么不能用 global_shortcut 注册 Ctrl+C：那是**永久**占用，用户在别的程序里
// 就再也复制不了东西。为什么不能在 overlay 的 webview 里监听 keydown：悬浮窗是
// `.focused(false)` 且显示时带 SWP_NOACTIVATE，按键始终发给用户原来的程序，DOM
// 永远收不到 —— Esc 当年就是因此改用这个钩子的。
//
// 所以做成"只在卡片可见期间、且只在卡片弹出时那个前台窗口里"生效的临时接管，
// 三道闸门：位掩码（哪些动作开着）、token（哪一张卡片）、前台窗口（还是不是他）。
const CARD_HOTKEY_COPY: u32 = 1 << 0;

static CARD_HOTKEY_MASK: AtomicU32 = AtomicU32::new(0);
static CARD_HOTKEY_TOKEN: AtomicU64 = AtomicU64::new(0);
static CARD_HOTKEY_DEADLINE_MS: AtomicI64 = AtomicI64::new(0);
/// 卡片弹出瞬间的前台窗口句柄。0 表示不校验 —— 拿不到前台窗口时宁可少吞一次
/// （漏判只让用户改用鼠标点，误吞会抢走他在别处的复制）。
static CARD_HOTKEY_FOREGROUND: AtomicIsize = AtomicIsize::new(0);
/// 一次物理按下只投递一个动作；同时保证配对的 keyup 也被吞掉，否则目标程序会
/// 收到一个孤立的 C 抬起事件（与 ESCAPE_KEY_DOWN 同一个理由）。
static CARD_HOTKEY_C_DOWN: AtomicBool = AtomicBool::new(false);

/// 卡片快捷键的硬截止。
///
/// 结果卡现在**不再自动消失**（文本还没交给用户，不该按"通知已读"处理），所以
/// 前端会在卡片可见期间周期性续期。这个 TTL 只是异常兜底：渲染端卡死或进程忙死时，
/// 绝不能永久接管用户的 Ctrl+C。续期间隔必须明显小于它。
const CARD_HOTKEY_TTL_MS: i64 = 20 * 1000;

/// 开启/续期/解除卡片快捷键。`actions` 为空即全部解除。
pub fn set_card_hotkeys(actions: &[String], token: u64) -> Result<(), String> {
    let mut mask = 0u32;
    for action in actions {
        match action.as_str() {
            "copy" => mask |= CARD_HOTKEY_COPY,
            other => return Err(format!("Unknown card hotkey action: {other}")),
        }
    }

    if mask == 0 {
        CARD_HOTKEY_MASK.store(0, Ordering::SeqCst);
        CARD_HOTKEY_TOKEN.store(0, Ordering::SeqCst);
        CARD_HOTKEY_DEADLINE_MS.store(0, Ordering::SeqCst);
        CARD_HOTKEY_FOREGROUND.store(0, Ordering::SeqCst);
        return Ok(());
    }

    // 续期（token 未变）时不要重新取前台窗口：卡片可见期间用户可能已经切走，
    // 那正是要解除接管的情形，重新取会把新前台当成"卡片的主人"又接管回来。
    let renewing = CARD_HOTKEY_TOKEN.load(Ordering::SeqCst) == token
        && CARD_HOTKEY_MASK.load(Ordering::SeqCst) != 0;
    if !renewing {
        CARD_HOTKEY_FOREGROUND.store(current_foreground_hwnd(), Ordering::SeqCst);
    }

    // 与 set_escape_action_mode 同样的发布顺序：先关，再写 token/deadline，最后开 mask。
    // 钩子只有看到非零 mask 之后才会去读 token。
    CARD_HOTKEY_MASK.store(0, Ordering::SeqCst);
    CARD_HOTKEY_TOKEN.store(token, Ordering::SeqCst);
    CARD_HOTKEY_DEADLINE_MS.store(now_ms() + CARD_HOTKEY_TTL_MS, Ordering::SeqCst);
    CARD_HOTKEY_MASK.store(mask, Ordering::SeqCst);
    Ok(())
}

#[cfg(windows)]
fn current_foreground_hwnd() -> isize {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as isize }
}

/// macOS：用前台应用的 pid 代替窗口句柄（卡片快捷键只需判断「用户切没切走」）。
#[cfg(target_os = "macos")]
fn current_foreground_hwnd() -> isize {
    crate::platform::macos::ax::focused_application_pid().unwrap_or(0) as isize
}

#[cfg(not(any(windows, target_os = "macos")))]
fn current_foreground_hwnd() -> isize {
    0
}

/// 读取当前生效的卡片快捷键；顺手做过期自清（与 active_escape_action 同构）。
fn active_card_hotkeys() -> (u32, u64) {
    let mask = CARD_HOTKEY_MASK.load(Ordering::SeqCst);
    if mask == 0 {
        return (0, 0);
    }
    if now_ms() > CARD_HOTKEY_DEADLINE_MS.load(Ordering::SeqCst) {
        CARD_HOTKEY_MASK.store(0, Ordering::SeqCst);
        CARD_HOTKEY_TOKEN.store(0, Ordering::SeqCst);
        CARD_HOTKEY_DEADLINE_MS.store(0, Ordering::SeqCst);
        CARD_HOTKEY_FOREGROUND.store(0, Ordering::SeqCst);
        return (0, 0);
    }
    (mask, CARD_HOTKEY_TOKEN.load(Ordering::SeqCst))
}

/// 前台窗口是否仍是卡片弹出时那个。记录值为 0（取不到）时一律放过校验。
#[cfg(any(windows, target_os = "macos"))]
fn card_hotkey_foreground_matches() -> bool {
    let expected = CARD_HOTKEY_FOREGROUND.load(Ordering::SeqCst);
    if expected == 0 {
        return true;
    }
    current_foreground_hwnd() == expected
}

/// 这一刻按下的是不是**只有** Ctrl 的 Ctrl+C。
///
/// 为什么要排除其他修饰键：Ctrl+Shift+C（浏览器开发者工具的"检查元素"）、Ctrl+Alt+C、
/// Win+Ctrl+C 都含着一个 Ctrl+C。只判"Ctrl 按着"会把这些一并截走，用户在自己的程序里
/// 突然少了一个快捷键，而且完全看不出是谁干的。
///
/// 用 `GetAsyncKeyState` 是可靠的：这些修饰键我们从不吞（见
/// single_key_blocked_by_modifiers 的注释）。唯一的边界是用户把**右 Ctrl 设成了
/// PTT 单键**（默认配置就是），那一路 down 会被吞掉、异步状态可能读不到 —— 但那种
/// 场景下按右 Ctrl 本来就在开始录音，不会是在复制。
#[cfg(windows)]
unsafe fn only_ctrl_is_down(kb_flags: u32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    const VK_CONTROL: i32 = 0x11;
    const VK_SHIFT: i32 = 0x10;
    const VK_MENU: i32 = 0x12;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;

    if GetAsyncKeyState(VK_CONTROL) >= 0 {
        return false;
    }
    // Alt 优先用事件自带的 LLKHF_ALTDOWN：那是 OS 派发这次按键时的视角，比事后问
    // GetAsyncKeyState 更贴近现场（与 single_key_blocked_by_modifiers 同一个理由）。
    if kb_flags & LLKHF_ALTDOWN != 0 {
        return false;
    }
    for vk in [VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN] {
        if GetAsyncKeyState(vk) < 0 {
            return false;
        }
    }
    true
}

fn card_hotkey_action_name(action: u32) -> &'static str {
    match action {
        CARD_HOTKEY_COPY => "copy",
        _ => "unknown",
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
    // F13–F24：物理键盘上没有这些键，因此几乎不与任何程序的快捷键冲突，
    // 适合可编程键盘 / 自制 HID 语音设备当专用触发键。
    // 这一段在幻影过滤里有例外，见 is_injection_exempt_vk。
    ("F13", 0x7C), ("F14", 0x7D), ("F15", 0x7E), ("F16", 0x7F),
    ("F17", 0x80), ("F18", 0x81), ("F19", 0x82), ("F20", 0x83),
    ("F21", 0x84), ("F22", 0x85), ("F23", 0x86), ("F24", 0x87),
];

/// 只在 macOS 上能单独当热键的键，Windows 上不放进上面的公共表（Windows 行为保持不变）：
/// - 单独的 ⌘（Windows 上是 Win 键，单按会弹开始菜单，所以 Windows 不允许）；
///   mac 上右 ⌘ 单按没有系统动作，是免提的默认键。
/// - Fn / 🌐：Windows 没有对应的虚拟键；mac 的 event tap 把它翻译成保留值 0xFF
///   （见 platform::macos::keycodes::VK_FN）。
/// ⚠️ 与前端 lib/shortcutKeys.ts 里 IS_MAC 时追加的单键保持一致。
#[cfg(target_os = "macos")]
const PLATFORM_EXTRA_SINGLE_KEYS: &[(&str, u32)] = &[("MetaLeft", 0x5B), ("MetaRight", 0x5C), ("Fn", 0xFF)];
#[cfg(not(target_os = "macos"))]
const PLATFORM_EXTRA_SINGLE_KEYS: &[(&str, u32)] = &[];

/// 单键热键表查找（公共表 + 本平台额外的单键）。
fn single_key_vk(code: &str) -> Option<u32> {
    SINGLE_KEY_TABLE
        .iter()
        .chain(PLATFORM_EXTRA_SINGLE_KEYS)
        .find(|(setting, _)| *setting == code)
        .map(|(_, vk)| *vk)
}

fn ptt_modifier_family(code: &str) -> Option<&'static str> {
    if code.starts_with("Alt") {
        Some("Alt")
    } else if code.starts_with("Control") {
        Some("Control")
    } else if code.starts_with("Shift") {
        Some("Shift")
    } else if code.starts_with("Meta") {
        Some("Meta")
    } else {
        None
    }
}

fn vk_for_ptt_code(code: &str) -> Option<u32> {
    if let Some(vk) = single_key_vk(code) {
        return Some(vk);
    }

    if let Some(letter) = code.strip_prefix("Key") {
        let bytes = letter.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_uppercase() {
            return Some(bytes[0] as u32);
        }
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let bytes = digit.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_digit() {
            return Some(bytes[0] as u32);
        }
    }

    match code {
        "MetaLeft" => Some(0x5B),
        "MetaRight" => Some(0x5C),
        "Escape" => Some(0x1B),
        "Tab" => Some(0x09),
        "Enter" => Some(0x0D),
        "Backspace" => Some(0x08),
        "Delete" => Some(0x2E),
        "ArrowUp" => Some(0x26),
        "ArrowDown" => Some(0x28),
        "ArrowLeft" => Some(0x25),
        "ArrowRight" => Some(0x27),
        "Home" => Some(0x24),
        "End" => Some(0x23),
        "PageUp" => Some(0x21),
        "PageDown" => Some(0x22),
        _ => None,
    }
}

struct PttKeyConfig {
    setting: String,
    vk_codes: Vec<u32>,
    modifier_mask: u64,
}

impl PttKeyConfig {
    fn disabled() -> Self {
        Self {
            setting: String::new(),
            vk_codes: Vec::new(),
            modifier_mask: 0,
        }
    }

    fn fallback() -> Self {
        Self {
            setting: DEFAULT_PTT_SETTING.to_string(),
            vk_codes: vec![DEFAULT_PTT_VK],
            modifier_mask: 1,
        }
    }
}

/// 「按住说话」的默认键，同时也是配置非法时的回退。
///
/// **不能是 Shift**：长按右 Shift 约 8 秒会触发 Windows 筛选键，那之后我们收不到
/// 这次「松开」，录音不会随手指抬起而结束。这里曾经是 ShiftRight，于是每台新装的
/// 机器开箱就绑在那个键上（前端也一样，见 services/defaults.ts）。
/// 右 Ctrl 位置相近、没有辅助功能陷阱，也不和免提的默认键（右 Alt）撞。
///
/// 值在 crate::defaults，那里有与前端 defaults.ts 的对账测试。
const DEFAULT_PTT_SETTING: &str = crate::defaults::SHORTCUT_PTT;
/// 与 DEFAULT_PTT_SETTING 对应的键：Windows 右 Ctrl，macOS 右 ⌥（MacBook 没有右 Ctrl）。
#[cfg(not(target_os = "macos"))]
const DEFAULT_PTT_VK: u32 = 0xA3;
#[cfg(target_os = "macos")]
const DEFAULT_PTT_VK: u32 = 0xA5;

/// 解析向后兼容的 PTT 物理键格式。旧单键仍是单成员；组合成员用 `+` 分隔。
///
/// 非法或未知非空值安全回退到默认键，避免整串被误当成别的键。
/// 注意这里**不禁止 Shift**：老用户存的可能就是 ShiftRight，那些绑定必须照原样生效。
/// 「不许再新设 Shift」是前端校验的事（lib/shortcutKeys.ts），不是解析器的事 ——
/// 在这里连解析都拒掉，等于用户没改设置说话键就自己变了。
fn ptt_key_config(setting: &str) -> PttKeyConfig {
    if setting.is_empty() {
        return PttKeyConfig::disabled();
    }

    let codes: Vec<&str> = setting.split('+').collect();
    if codes.is_empty() || codes.len() > 63 || codes.iter().any(|code| code.is_empty()) {
        return PttKeyConfig::fallback();
    }

    let mut vk_codes = Vec::with_capacity(codes.len());
    let mut modifier_mask = 0_u64;
    let mut modifier_families = Vec::new();
    for (index, code) in codes.iter().enumerate() {
        let Some(vk) = vk_for_ptt_code(code) else {
            return PttKeyConfig::fallback();
        };
        if vk_codes.contains(&vk) {
            return PttKeyConfig::fallback();
        }
        vk_codes.push(vk);
        if let Some(family) = ptt_modifier_family(code) {
            // WebView 的 KeyboardEvent 只能给出家族级 ctrlKey/altKey 等状态，无法在
            // 主键快路径可靠区分同族左右键；明确禁止左右两侧同时进入一个组合。
            if modifier_families.contains(&family) {
                return PttKeyConfig::fallback();
            }
            modifier_families.push(family);
            modifier_mask |= 1_u64 << index;
        }
    }

    let mouse_member = codes
        .iter()
        .any(|code| matches!(*code, "XButton1" | "XButton2" | "MButton"));
    let main_key_count = codes.len() - modifier_mask.count_ones() as usize;
    let valid_shape = if codes.len() == 1 {
        single_key_vk(codes[0]).is_some()
    } else {
        !mouse_member
            && main_key_count <= 1
            && ((main_key_count == 0 && codes.len() >= 2)
                || (main_key_count == 1 && modifier_mask != 0))
    };
    if !valid_shape {
        return PttKeyConfig::fallback();
    }

    PttKeyConfig {
        setting: setting.to_string(),
        vk_codes,
        modifier_mask,
    }
}

/// Virtual key code mapping for PTT settings.
fn vk_codes_for_setting(setting: &str) -> Vec<u32> {
    ptt_key_config(setting).vk_codes
}

/// Check if a shortcut setting is a single key (handled by hook) vs combo (handled by global_shortcut).
pub fn is_single_key_setting(setting: &str) -> bool {
    single_key_vk(setting).is_some()
}

/// 该设置是否为鼠标侧键（由低级鼠标钩子处理，而非键盘钩子）。
#[cfg_attr(not(windows), allow(dead_code))]
fn is_mouse_button_setting(setting: &str) -> bool {
    matches!(setting, "XButton1" | "XButton2" | "MButton")
}

/// 这个 vk 是鼠标按键吗（VK_MBUTTON / VK_XBUTTON1 / VK_XBUTTON2）。
///
/// ⚠️ 鼠标按键的物理状态**查不到**：低级鼠标钩子把它们的 down/up 都吞掉了
/// （返回 LRESULT(1)，否则会触发别的程序的前进/后退导航），事件因此不进系统输入
/// 队列，Windows 也就不为它们维护异步键状态 —— `GetAsyncKeyState` 会一直报「没按下」。
/// 所以凡是以 `is_ptt_member_physically_down` 为判据的逻辑，遇到鼠标按键都必须绕开。
///
/// 若日后往 SINGLE_KEY_TABLE 里加第四个鼠标键，这里也要跟着加（有测试钉住）。
fn is_mouse_vk(vk: u32) -> bool {
    matches!(vk, 0x04 | 0x05 | 0x06)
}

/// 幻影过滤的例外键：即使带「注入」标志或 scanCode==0，也照常当用户按键处理。
///
/// 幻影过滤真正要防的是 Windows 菜单导航合成出来的假 Alt（与真实按键几乎无法区分，
/// 只能靠 injected 标志和 scanCode==0 识别）。下面这些键都不可能是那种幻影，而它们的
/// **正常来源恰恰就是注入**，按幻影丢弃只会让用户绑了不生效：
///   · BrowserBack / BrowserForward（0xA6/0xA7）：罗技等鼠标驱动把侧键改写成它们。
///   · F13–F24（0x7C–0x87）：物理键盘上不存在这些键，用户要按出来只有两条路 ——
///     可编程键盘 / HID 固件直接发（真键，本来就能过），或者用 AutoHotkey、PowerToys
///     键盘管理器、外设驱动宏把别的键映射过来。后者走 SendInput，带 injected 标志；
///     不开例外的话这类用户会遇到「绑得上、按下去没反应、日志里也没有任何记录」，
///     排查起来毫无线索。误判的代价只是某个程序模拟 F13 时多弹一次悬浮窗。
#[cfg_attr(not(windows), allow(dead_code))]
fn is_injection_exempt_vk(vk: u32) -> bool {
    matches!(vk, 0xA6 | 0xA7) || (0x7C..=0x87).contains(&vk)
}

/// `KBDLLHOOKSTRUCT.flags` 的 LLKHF_ALTDOWN 位：这次按键发生时 Alt 是否按住。
///
/// 这是 OS 派发事件时自己的视角，比事后问 `GetAsyncKeyState` 更贴近现场。
/// ⚠️ 不能用「msg == WM_SYSKEYDOWN」代替：F10 单独按下也走 WM_SYSKEYDOWN。
#[cfg(windows)]
const LLKHF_ALTDOWN: u32 = 0x20;

/// 左右 Shift / Ctrl / Alt / Win 的 vk。
const MODIFIER_VK_CODES: [u32; 8] = [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C];

/// 这个单键热键是否要求「裸按」—— 按下的那一刻不能有额外修饰键按住。
///
/// 起因：用户把 F4 设成免提，结果按 Alt+F4 也会开始录音（而且 F4 的 down 被我们吞掉，
/// Alt+F4 本身还失效了）。判定原来只比 vk，压根不看修饰键。
///
/// **只对主键成立**（F1–F24、Space、Insert、CapsLock、BrowserBack…）。热键本身就是
/// 修饰键时绝不能套这条规则，两个原因都会让热键彻底失效：
///   · 「按住说话」默认是右 Ctrl、免提默认是右 Alt。自己就是 Ctrl，再去问
///     「有没有 Ctrl 按住」永远为真；
///   · 欧洲键盘布局的 AltGr 会同时产生 左Ctrl + 右Alt。右 Alt 当热键时，
///     这些用户每次按都带着一个左 Ctrl，会被永久挡住。
///
/// 鼠标键也排除：它们走的是鼠标钩子，而且 Alt+侧键不是任何系统快捷键 ——
/// 放行反而会把浏览器的前进/后退导航漏给别的程序（见 pitfalls 第 6 条）。
fn single_key_requires_bare_press(vk: u32) -> bool {
    !MODIFIER_VK_CODES.contains(&vk) && !is_mouse_vk(vk)
}

/// 按下这个单键热键的时刻，是否有额外修饰键按住（有则整条放行、不吞、不触发）。
///
/// Ctrl / Shift / Alt / Win 我们从不吞掉，所以它们的异步键状态是可靠的 ——
/// pitfalls 第 13 条那条「鼠标键查不到物理状态」的限制在这里不适用。
#[cfg(windows)]
unsafe fn single_key_blocked_by_modifiers(vk: u32, kb_flags: u32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    if !single_key_requires_bare_press(vk) {
        return false;
    }
    if kb_flags & LLKHF_ALTDOWN != 0 {
        return true;
    }
    MODIFIER_VK_CODES
        .iter()
        .any(|code| GetAsyncKeyState(*code as i32) < 0)
}

#[allow(dead_code)]
fn modifier_kind(setting: &str) -> Option<&'static str> {
    match setting {
        "AltLeft" | "AltRight" => Some("alt"),
        "ControlLeft" | "ControlRight" => Some("ctrl"),
        "ShiftLeft" | "ShiftRight" => Some("shift"),
        "MetaLeft" | "MetaRight" => Some("meta"),
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
    #[serde(rename = "metaKey")]
    meta_key: bool,
}

/// Shared state between the hook callback and the main thread
struct HookSharedState {
    ptt_vk_codes: Vec<u32>,
    ptt_setting: String,
    /// PTT 成员的已按下位图；只有位图首次达到 full_mask 才开始。
    ptt_pressed_mask: AtomicU64,
    ptt_full_mask: u64,
    /// 哪些 PTT 成员是修饰键，用于组合键的事件消费策略。
    ptt_modifier_mask: u64,
    /// 普通组合中已经吞掉 down 的主键位；仅对应位的 up 才能继续吞，避免孤立事件。
    ptt_consumed_down_mask: AtomicU64,
    /// 当前活动 PTT 代次；0 表示空闲，最高位表示某个释放方已认领、正在入队 up。
    /// 按下、释放归属和“允许下一次按下”由这一个原子量决定，避免拆分 bool/代次产生竞态。
    ptt_active_generation: AtomicU64,
    /// 单调递增的 PTT 代次分配器，仅在新按下时推进。
    ptt_generation: AtomicU64,
    /// 每个成员最近一次真实 keydown（包括 repeat）的时间。
    /// 各成员独立记录，避免仍按住成员的 repeat 掩盖另一个成员已经漏掉 key-up。
    ptt_last_down_ms: Vec<AtomicI64>,
    /// hook 生命周期标记，供独立成员状态看门狗在重配/停止时退出。
    ptt_hook_alive: AtomicBool,
    hands_free_active: AtomicBool,
    /// 免提键是否处于"已按下"状态。首个真实 keydown 触发 toggle，repeat down 被忽略；
    /// 配对 keyup（包括被标成 synthetic 的 up）负责清零，让下一次按下可以再次触发。
    hf_key_down: AtomicBool,
    /// VK codes for hands-free toggle key (empty = not using hook for hands-free)
    hf_vk_codes: Vec<u32>,
    hf_setting: String,
    /// AI 整理开关支持单键与鼠标按键；组合键仍由 global_shortcut 处理。
    ai_toggle_key_down: AtomicBool,
    ai_toggle_vk_codes: Vec<u32>,
    ai_toggle_setting: String,
    app_handle: AppHandle,
}

/// Message sent from the hook callback (non-blocking) to the dispatcher thread.
#[cfg(any(windows, target_os = "macos"))]
#[allow(dead_code)]
enum HookAction {
    PttDown { vk: u32, gen: u64 },
    PttUp { vk: u32, gen: u64, reason: &'static str },
    HfToggle { vk: u32 },
    AiToggle { vk: u32 },
    Escape { mode: u32, token: u64 },
    /// 悬浮窗卡片上的临时组合键（目前只有 Ctrl+C = 复制结果文本）。
    CardHotkey { action: u32, token: u64 },
    Diag { vk: u32, msg_name: &'static str, flags: u32, scan_code: u32 },
    Shutdown,
    /// 快捷键录制期间捕获到的鼠标侧键（vk=0x05/0x06），用于让设置页绑定侧键。
    MouseCaptured { vk: u32 },
    /// 切换润色模式。只有 mac 的 event tap 会发：系统快捷键接不住的、只带 ⌥ / ⇧ 的组合键
    /// （见 keyboard/macos.rs 的 TAP_COMBOS）。Windows 上这类组合仍由 global_shortcut 处理。
    PresetSwitch { preset_id: String },
}

const PTT_RELEASING_BIT: u64 = 1 << 63;

/// 开始一次新的 PTT 代次。只有 active=0 才能发布新代次；释放方把旧 up 放进
/// dispatcher 队列之前 active 始终非 0，因此不会出现 down(new) 排在 up(old) 前面。
fn begin_ptt_press(active_generation: &AtomicU64, generation: &AtomicU64) -> Option<u64> {
    if active_generation.load(Ordering::SeqCst) != 0 {
        return None;
    }

    let mut gen = generation
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1)
        & !PTT_RELEASING_BIT;
    if gen == 0 {
        gen = generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1)
            & !PTT_RELEASING_BIT;
    }

    active_generation
        .compare_exchange(0, gen, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| gen)
}

/// 免提键只在一次物理按下的首个 keydown 触发；Windows 随后的 repeat down 被忽略。
fn begin_hf_press(key_down: &AtomicBool) -> bool {
    !key_down.swap(true, Ordering::SeqCst)
}

/// 清除免提按下状态。返回 true 表示确实存在一枚需要配对消费的 keyup。
fn end_hf_press(key_down: &AtomicBool) -> bool {
    key_down.swap(false, Ordering::SeqCst)
}

/// 幂等认领一次释放，但暂不允许下一次 down。认领者必须在 up 成功入队后调用
/// `complete_ptt_release`；dispatcher 断开时也 complete，优先避免 native 状态永久卡住。
fn claim_ptt_release(
    active_generation: &AtomicU64,
    expected_generation: Option<u64>,
) -> Option<u64> {
    loop {
        let active = active_generation.load(Ordering::SeqCst);
        if active == 0 || (active & PTT_RELEASING_BIT) != 0 {
            return None;
        }
        if expected_generation.is_some_and(|expected| expected != active) {
            return None;
        }
        if active_generation
            .compare_exchange(
                active,
                active | PTT_RELEASING_BIT,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            return Some(active);
        }
    }
}

fn complete_ptt_release(active_generation: &AtomicU64, gen: u64) -> bool {
    active_generation
        .compare_exchange(
            gen | PTT_RELEASING_BIT,
            0,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
}

fn clear_ptt_press(active_generation: &AtomicU64) -> Option<u64> {
    let gen = claim_ptt_release(active_generation, None)?;
    let _ = complete_ptt_release(active_generation, gen);
    Some(gen)
}

fn cancel_ptt_press_start(active_generation: &AtomicU64, gen: u64) {
    let _ = active_generation.compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst);
}

fn ptt_member_index(vk_codes: &[u32], vk: u32) -> Option<usize> {
    vk_codes.iter().position(|configured| *configured == vk)
}

/// 记录成员 down；仅在该成员由 up→down 且本次使完整位图成立时返回 true。
fn press_ptt_member(pressed_mask: &AtomicU64, index: usize, full_mask: u64) -> bool {
    let bit = 1_u64 << index;
    let previous = pressed_mask.fetch_or(bit, Ordering::SeqCst);
    (previous & bit) == 0 && (previous | bit) == full_mask
}

/// 记录成员 up；孤立或重复 up 返回 false。
fn release_ptt_member(pressed_mask: &AtomicU64, index: usize) -> bool {
    let bit = 1_u64 << index;
    (pressed_mask.fetch_and(!bit, Ordering::SeqCst) & bit) != 0
}

fn should_consume_combo_main_down(
    pressed_mask: u64,
    consumed_down_mask: u64,
    member_bit: u64,
    modifier_mask: u64,
) -> bool {
    if pressed_mask & member_bit != 0 {
        consumed_down_mask & member_bit != 0
    } else {
        pressed_mask & modifier_mask == modifier_mask
    }
}

fn clear_ptt_members(state: &HookSharedState) {
    state.ptt_pressed_mask.store(0, Ordering::SeqCst);
    state.ptt_consumed_down_mask.store(0, Ordering::SeqCst);
}

fn ptt_modifier_flags(setting: &str) -> (bool, bool, bool, bool) {
    let codes = setting.split('+');
    let mut alt = false;
    let mut ctrl = false;
    let mut shift = false;
    let mut meta = false;
    for code in codes {
        alt |= code.starts_with("Alt");
        ctrl |= code.starts_with("Control");
        shift |= code.starts_with("Shift");
        meta |= code.starts_with("Meta");
    }
    (alt, ctrl, shift, meta)
}

#[cfg(target_os = "macos")]
unsafe fn is_ptt_member_physically_down(vk: u32) -> bool {
    macos::is_physically_down(vk)
}

#[cfg(windows)]
unsafe fn is_ptt_member_physically_down(vk: u32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    let configured_key_down = GetAsyncKeyState(vk as i32) < 0;
    let mapped_side_button_down = match vk {
        // 罗技等驱动常把标准侧键改写成 BrowserBack/Forward；同时检查原始
        // XBUTTON，避免注入后的浏览器 VK 不维护异步键状态。
        0xA6 => GetAsyncKeyState(0x05) < 0,
        0xA7 => GetAsyncKeyState(0x06) < 0,
        _ => false,
    };
    configured_key_down || mapped_side_button_down
}

/// 供 WebView 聚焦回退路径确认组合成员的真实物理状态。
/// 返回值与输入 code 一一对应；未知 code 安全返回 false。
pub fn ptt_physical_key_states(codes: &[String]) -> Vec<bool> {
    #[cfg(windows)]
    {
        return codes
            .iter()
            .map(|code| {
                vk_for_ptt_code(code)
                    .is_some_and(|vk| unsafe { is_ptt_member_physically_down(vk) })
            })
            .collect();
    }

    #[cfg(target_os = "macos")]
    {
        return codes
            .iter()
            .map(|code| {
                vk_for_ptt_code(code)
                    .is_some_and(|vk| unsafe { is_ptt_member_physically_down(vk) })
            })
            .collect();
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        vec![false; codes.len()]
    }
}

/// 新成员 down 到来前，先清掉其它成员中物理上已经松开的残位。
/// 这既覆盖录音结束后的漏 up，也避免在 1.5 秒后台看门狗窗口内误拼出完整组合。
#[cfg(any(windows, target_os = "macos"))]
unsafe fn reconcile_stale_ptt_members_before_down(
    state: &HookSharedState,
    current_index: usize,
) {
    let pressed = state.ptt_pressed_mask.load(Ordering::SeqCst);
    for (index, &member_vk) in state.ptt_vk_codes.iter().enumerate() {
        if index == current_index {
            continue;
        }
        let bit = 1_u64 << index;
        if pressed & bit != 0 && !is_ptt_member_physically_down(member_vk) {
            let _ = release_ptt_member(&state.ptt_pressed_mask, index);
            state
                .ptt_consumed_down_mask
                .fetch_and(!bit, Ordering::SeqCst);
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn queue_ptt_release(
    sender: &std::sync::mpsc::Sender<HookAction>,
    active_generation: &AtomicU64,
    expected_generation: Option<u64>,
    vk: u32,
    reason: &'static str,
) -> bool {
    let Some(gen) = claim_ptt_release(active_generation, expected_generation) else {
        return false;
    };

    if sender.send(HookAction::PttUp { vk, gen, reason }).is_ok() {
        // up 已经在线性 FIFO 中排队；现在才允许下一次 down 发布新代次。
        let _ = complete_ptt_release(active_generation, gen);
        true
    } else {
        // dispatcher 已断开时不可能再投递前端事件；至少释放 native 状态，避免
        // 永久拒绝后续 down/持续吞 PTT 键。健康看门狗会记录 dispatcher 失效。
        let _ = complete_ptt_release(active_generation, gen);
        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
        false
    }
}

/// 独立于“当前是否正在录音”的 PTT 成员物理状态看门狗。
///
/// 活动代次可能因任一成员正常 up 而结束，但其它成员的 up 仍可能丢失；如果只让录音
/// watchdog 工作到代次结束，残留位会把下一次单键误拼成完整组合。此线程存活期等于 hook，
/// 会持续清理每个已物理松开且 repeat 静默足够久的成员，并在仍有活动代次时补发一次 up。
#[cfg(any(windows, target_os = "macos"))]
fn spawn_ptt_member_watchdog(
    state: Arc<HookSharedState>,
    action_tx: std::sync::mpsc::Sender<HookAction>,
) -> Option<thread::JoinHandle<()>> {
    const POLL_MS: u64 = 100;
    const REPEAT_SILENCE_MS: i64 = 1_500;
    const RELEASED_SAMPLES_REQUIRED: u8 = 3;

    match thread::Builder::new()
        .name("ptt-member-watchdog".to_string())
        .spawn(move || {
            let mut released_samples = vec![0_u8; state.ptt_vk_codes.len()];
            while state.ptt_hook_alive.load(Ordering::SeqCst) {
                thread::sleep(std::time::Duration::from_millis(POLL_MS));
                if !state.ptt_hook_alive.load(Ordering::SeqCst) {
                    break;
                }

                for (index, &member_vk) in state.ptt_vk_codes.iter().enumerate() {
                    let bit = 1_u64 << index;
                    if state.ptt_pressed_mask.load(Ordering::SeqCst) & bit == 0 {
                        released_samples[index] = 0;
                        continue;
                    }

                    // 鼠标按键必须跳过这套判据。它由「repeat 静默」+「异步键状态」两个
                    // 信号组成，而这两个对鼠标按键都不存在：鼠标按键没有自动重复，
                    // 异步键状态又因为我们吞掉了事件而不更新（见 is_mouse_vk）。
                    // 于是条件恒真、只会稳定误判。鼠标键的 up 由我们自己的钩子直接观测，
                    // 吞掉不影响我们收到事件；真丢了 up 还有 5 分钟硬释放兜底。
                    if is_mouse_vk(member_vk) {
                        released_samples[index] = 0;
                        continue;
                    }

                    let repeat_silence_ms = now_ms()
                        .saturating_sub(state.ptt_last_down_ms[index].load(Ordering::SeqCst));
                    let physically_down = unsafe { is_ptt_member_physically_down(member_vk) };
                    if repeat_silence_ms >= REPEAT_SILENCE_MS && !physically_down {
                        released_samples[index] = released_samples[index].saturating_add(1);
                    } else {
                        released_samples[index] = 0;
                    }

                    if released_samples[index] < RELEASED_SAMPLES_REQUIRED {
                        continue;
                    }

                    released_samples[index] = 0;
                    if !release_ptt_member(&state.ptt_pressed_mask, index) {
                        continue;
                    }
                    state
                        .ptt_consumed_down_mask
                        .fetch_and(!bit, Ordering::SeqCst);
                    let active_before = state.ptt_active_generation.load(Ordering::SeqCst);
                    let queued_release = queue_ptt_release(
                        &action_tx,
                        &state.ptt_active_generation,
                        None,
                        member_vk,
                        "member_watchdog_release",
                    );
                    crate::commands::system::write_log_line(&format!(
                        "[RUST] [ptt] member watchdog cleared vk={} setting={} member={} repeat_silence_ms={} active_before={} queued_release={}",
                        member_vk,
                        state.ptt_setting,
                        index,
                        repeat_silence_ms,
                        active_before,
                        queued_release,
                    ));
                }
            }
        }) {
        Ok(handle) => Some(handle),
        Err(error) => {
            crate::commands::system::write_log_line(&format!(
                "[RUST] [ptt] failed to start member watchdog error={}",
                error,
            ));
            None
        }
    }
}

fn emit_ptt_release(state: &HookSharedState, vk: u32, gen: u64, reason: &'static str) {
    crate::commands::system::write_log_line(&format!(
        "[RUST] [ptt] release vk={} setting={} gen={} reason={}",
        vk, state.ptt_setting, gen, reason,
    ));
    let (alt_key, ctrl_key, shift_key, meta_key) = ptt_modifier_flags(&state.ptt_setting);
    let event = PTTEvent {
        source: "rust_hook".to_string(),
        reason: reason.to_string(),
        vk,
        ptt_setting: state.ptt_setting.clone(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        alt_key,
        ctrl_key,
        shift_key,
        meta_key,
    };
    let _ = state.app_handle.emit("ptt-up", &event);
}

#[cfg(any(windows, target_os = "macos"))]
fn spawn_ptt_release_watchdog(
    state: Arc<HookSharedState>,
    action_tx: std::sync::mpsc::Sender<HookAction>,
    vk: u32,
    gen: u64,
) {
    const POLL_MS: u64 = 100;
    // Windows 可配置的首次键盘 repeat 延迟最长约 1 秒。留到 1.5 秒，且再要求
    // 连续三次看到物理键已松开，避免正常长按被短暂状态抖动提前结束。
    const REPEAT_SILENCE_MS: i64 = 1_500;
    const RELEASED_SAMPLES_REQUIRED: u8 = 3;
    const WARNING_AFTER_SECS: u64 = 4 * 60;
    const HARD_RELEASE_AFTER_SECS: u64 = 5 * 60;

    let fallback_state = state.clone();
    let result = thread::Builder::new()
        .name("ptt-release-watchdog".to_string())
        .spawn(move || {
            let started = std::time::Instant::now();
            let mut released_samples = vec![0_u8; state.ptt_vk_codes.len()];
            let mut warning_sent = false;

            loop {
                thread::sleep(std::time::Duration::from_millis(POLL_MS));

                if state.ptt_active_generation.load(Ordering::SeqCst) != gen {
                    return;
                }

                // 每个成员独立检查“repeat 静默 + 物理状态”。另一个仍按住成员的
                // repeat 不会再掩盖已经松开但漏掉 key-up 的成员。
                let mut recovered_member: Option<(usize, u32, i64)> = None;
                for (index, &member_vk) in state.ptt_vk_codes.iter().enumerate() {
                    let bit = 1_u64 << index;
                    if state.ptt_pressed_mask.load(Ordering::SeqCst) & bit == 0 {
                        released_samples[index] = 0;
                        continue;
                    }

                    // 见 member watchdog 里同一处的说明：这套「repeat 静默 + 异步键状态」
                    // 的判据对鼠标按键两个信号都缺，必然误判。实测按住侧键/中键 1.7 秒
                    // 就会被判成「漏了 keyup」而强制结束录音（reason=missing_keyup_release）。
                    if is_mouse_vk(member_vk) {
                        released_samples[index] = 0;
                        continue;
                    }

                    let repeat_silence_ms = now_ms()
                        .saturating_sub(state.ptt_last_down_ms[index].load(Ordering::SeqCst));
                    let physically_down = unsafe { is_ptt_member_physically_down(member_vk) };

                    if repeat_silence_ms >= REPEAT_SILENCE_MS && !physically_down {
                        released_samples[index] = released_samples[index].saturating_add(1);
                        if released_samples[index] >= RELEASED_SAMPLES_REQUIRED
                            && recovered_member.is_none()
                        {
                            recovered_member = Some((index, member_vk, repeat_silence_ms));
                        }
                    } else {
                        released_samples[index] = 0;
                    }
                }

                if let Some((index, member_vk, repeat_silence_ms)) = recovered_member {
                    // 一旦确认至少一个成员漏了 up，就同步清掉当前所有“物理已松开”的位。
                    // 这样两个成员同时漏 up 时不会留下半个组合；仍物理按住的成员保留，
                    // 避免 repeat 自动把完整组合重新拼起来。
                    let mut cleared_mask = 0_u64;
                    for (other_index, &other_vk) in state.ptt_vk_codes.iter().enumerate() {
                        let bit = 1_u64 << other_index;
                        // 同样跳过鼠标按键：它的物理状态查不到，清掉只会误伤。
                        // （鼠标键目前只允许单键格式，走不到这里，但判据要一致。）
                        if is_mouse_vk(other_vk) {
                            continue;
                        }
                        if state.ptt_pressed_mask.load(Ordering::SeqCst) & bit != 0
                            && !unsafe { is_ptt_member_physically_down(other_vk) }
                        {
                            let _ = release_ptt_member(&state.ptt_pressed_mask, other_index);
                            state
                                .ptt_consumed_down_mask
                                .fetch_and(!bit, Ordering::SeqCst);
                            cleared_mask |= bit;
                        }
                    }

                    let queued = queue_ptt_release(
                        &action_tx,
                        &state.ptt_active_generation,
                        Some(gen),
                        member_vk,
                        "missing_keyup_release",
                    );
                    if queued {
                        crate::commands::system::write_log_line(&format!(
                            "[RUST] [ptt] recovered missing keyup vk={} setting={} gen={} member={} repeat_silence_ms={} cleared_mask=0x{:X}",
                            member_vk,
                            state.ptt_setting,
                            gen,
                            index,
                            repeat_silence_ms,
                            cleared_mask,
                        ));
                    }
                    return;
                }

                let elapsed = started.elapsed();
                if !warning_sent && elapsed.as_secs() >= WARNING_AFTER_SECS {
                    warning_sent = true;
                    crate::commands::system::write_log_line(&format!(
                        "[RUST] [ptt] 4min timeout warning gen={}",
                        gen,
                    ));
                    let (alt_key, ctrl_key, shift_key, meta_key) =
                        ptt_modifier_flags(&state.ptt_setting);
                    let warn_event = PTTEvent {
                        source: "rust_hook".to_string(),
                        reason: "timeout_warning".to_string(),
                        vk,
                        ptt_setting: state.ptt_setting.clone(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                        alt_key,
                        ctrl_key,
                        shift_key,
                        meta_key,
                    };
                    let _ = state.app_handle.emit("ptt-timeout-warning", &warn_event);
                }

                if elapsed.as_secs() >= HARD_RELEASE_AFTER_SECS {
                    clear_ptt_members(&state);
                    if queue_ptt_release(
                        &action_tx,
                        &state.ptt_active_generation,
                        Some(gen),
                        vk,
                        "hard_timeout_release",
                    ) {
                        crate::commands::system::write_log_line(&format!(
                            "[RUST] [ptt] hard_timeout_release gen={}",
                            gen,
                        ));
                        return;
                    }
                }
            }
        });

    if let Err(error) = result {
        crate::commands::system::write_log_line(&format!(
            "[RUST] [ptt] failed to start release watchdog gen={} error={}",
            gen, error,
        ));
        // 无 watchdog 比立即结束本次录音更危险。此处本来就在 dispatcher 线程：
        // 先 emit，再清 active，仍保证旧 up 不会排到下一次 down 后面。
        clear_ptt_members(&fallback_state);
        if let Some(claimed_gen) =
            claim_ptt_release(&fallback_state.ptt_active_generation, Some(gen))
        {
            emit_ptt_release(&fallback_state, vk, claimed_gen, "watchdog_start_failed");
            let _ = complete_ptt_release(&fallback_state.ptt_active_generation, claimed_gen);
        }
    }
}

/// RAII 计时器：测量 `low_level_keyboard_proc` 单次调用耗时，drop 时更新
/// `MAX_CALLBACK_DURATION_US`。用 Drop 而非在每个 return 点手写更新，这样
/// 无论函数从哪条路径返回都会被覆盖到，不会漏记。
#[cfg(any(windows, target_os = "macos"))]
struct CallbackTimer(std::time::Instant);

#[cfg(any(windows, target_os = "macos"))]
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
         try_send_fail_count={} max_callback_duration_us={} hook_refreshes={}",
        reason, hook_running, dispatcher_alive, last_cb_age_ms, fail_count, max_dur_us,
        HOOK_REFRESH_COUNT.load(Ordering::SeqCst),
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
            // last_refresh_ms 只有 Windows 的「钩子被摘」判据用得到
            #[cfg_attr(not(windows), allow(unused_mut, unused_variables))]
            let mut last_refresh_ms: i64 = 0;
            let mut refresh_logged_at_ms: i64 = 0;
            loop {
                // 15 秒查一次：钩子被摘后最多一刻钟内（有输入的前提下）就能装回来。
                // 采样本身只是几次原子读和一次 GetLastInputInfo。
                thread::sleep(std::time::Duration::from_secs(15));

                // macOS 不会静默摘钩子，但会在回调超时 / 用户输入保护时把 tap 停用
                // （回调里收到 kCGEventTapDisabledBy* 时会立刻重开，这里是兜底）。
                #[cfg(target_os = "macos")]
                if HOOK_RUNNING.load(Ordering::SeqCst) && macos::reenable_tap_if_disabled() {
                    HOOK_REFRESH_COUNT.fetch_add(1, Ordering::SeqCst);
                    if now_ms() - refresh_logged_at_ms >= 30 * 60_000 {
                        refresh_logged_at_ms = now_ms();
                        crate::commands::system::write_log_line(&format!(
                            "[ptt-watchdog] event tap was disabled by the system; re-enabled, total refreshes={}",
                            HOOK_REFRESH_COUNT.load(Ordering::SeqCst),
                        ));
                    }
                }

                #[cfg(windows)]
                if HOOK_RUNNING.load(Ordering::SeqCst) && now_ms() - last_refresh_ms >= 60_000 {
                    let last_cb = LAST_CALLBACK_MS.load(Ordering::SeqCst);
                    let callback_age = if last_cb == 0 { -1 } else { now_ms() - last_cb };
                    let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
                    if let Some(input_age) = last_input_age_ms() {
                        if tid != 0 && hook_looks_removed(callback_age, input_age) {
                            last_refresh_ms = now_ms();
                            unsafe {
                                let _ = PostThreadMessageW(tid, WM_SAYIT_REFRESH_HOOKS, WPARAM(0), LPARAM(0));
                            }
                            // 只动鼠标时每分钟都会走到这里，日志半小时最多一行。
                            if now_ms() - refresh_logged_at_ms >= 30 * 60_000 {
                                refresh_logged_at_ms = now_ms();
                                crate::commands::system::write_log_line(&format!(
                                    "[ptt-watchdog] input without hook callback (callback_age_ms={} input_age_ms={}); reinstalling hooks, total refreshes={}",
                                    callback_age, input_age, HOOK_REFRESH_COUNT.load(Ordering::SeqCst),
                                ));
                            }
                        }
                    }
                }

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

/// Dispatcher 线程：日志与 emit（可能阻塞）都在这里做，钩子回调只往队列里投递。
/// Windows 的低级钩子与 macOS 的 event tap 共用这一份，事件名和载荷只有一处定义。
#[cfg(any(windows, target_os = "macos"))]
fn spawn_dispatcher(
    dispatch_state: Arc<HookSharedState>,
    action_rx: std::sync::mpsc::Receiver<HookAction>,
    watchdog_action_tx: std::sync::mpsc::Sender<HookAction>,
) -> thread::JoinHandle<()> {
        thread::Builder::new()
            .name("ptt-dispatcher".to_string())
            .spawn(move || {
            // Guard 存活期 = 本线程存活期；线程正常退出或 panic 展开都会触发 Drop，
            // 从而让看门狗快照立刻看到 dispatcher_alive=false。
            let _alive_guard = DispatcherAliveGuard::new();
            crate::commands::system::write_log_line("[ptt-dispatcher] thread started");
            while let Ok(action) = action_rx.recv() {
                match action {
                    HookAction::Shutdown => break,
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
                        let (alt_key, ctrl_key, shift_key, meta_key) =
                            ptt_modifier_flags(setting);
                        let event = PTTEvent {
                            source: "rust_hook".to_string(),
                            reason: "keydown".to_string(),
                            vk,
                            ptt_setting: setting.clone(),
                            timestamp: chrono::Utc::now().timestamp_millis(),
                            alt_key,
                            ctrl_key,
                            shift_key,
                            meta_key,
                        };
                        let _ = dispatch_state.app_handle.emit("ptt-down", &event);
                        spawn_ptt_release_watchdog(
                            dispatch_state.clone(),
                            watchdog_action_tx.clone(),
                            vk,
                            gen,
                        );
                    }
                    HookAction::PttUp { vk, gen, reason } => {
                        emit_ptt_release(&dispatch_state, vk, gen, reason);
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
                    HookAction::AiToggle { vk } => {
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [ai-toggle] vk={} setting={}", vk, dispatch_state.ai_toggle_setting)
                        );
                        let _ = dispatch_state.app_handle.emit("toggle-ai-cleanup", serde_json::json!({
                            "source": "rust_hook",
                            "vk": vk,
                        }));
                    }
                    HookAction::Escape { mode, token } => {
                        let mode_name = escape_action_mode_name(mode);
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [escape] action mode={mode_name} token={token}")
                        );
                        let _ = dispatch_state.app_handle.emit("escape-action", serde_json::json!({
                            "mode": mode_name,
                            "token": token,
                        }));
                    }
                    HookAction::CardHotkey { action, token } => {
                        let action_name = card_hotkey_action_name(action);
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [card-hotkey] action={action_name} token={token}")
                        );
                        let _ = dispatch_state.app_handle.emit("card-hotkey", serde_json::json!({
                            "action": action_name,
                            "token": token,
                        }));
                    }
                    HookAction::MouseCaptured { vk } => {
                        let setting = match vk {
                            0x04 => "MButton",
                            0x05 => "XButton1",
                            0x06 => "XButton2",
                            0xA6 => "BrowserBack",
                            0xA7 => "BrowserForward",
                            // mac 的 Fn / 🌐 键（内部 ID 0xFF，只有 mac 会产生）
                            0xFF => "Fn",
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
                    HookAction::PresetSwitch { preset_id } => {
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [preset] switch preset={} (event tap)", preset_id)
                        );
                        // 载荷与 commands/shortcuts.rs 里系统快捷键发的一致
                        let _ = dispatch_state.app_handle.emit("switch-preset", serde_json::json!({
                            "presetId": preset_id,
                        }));
                    }
                }
            }
            log::info!("[ptt] dispatcher thread exited");
            crate::commands::system::write_log_line(
                "[ptt-dispatcher] thread exited (shutdown or all senders dropped)"
            );
            // _alive_guard drops here, flips DISPATCHER_ALIVE back to false.
        }).expect("failed to spawn ptt-dispatcher thread")
}

// Thread-local storage for the hook callback
thread_local! {
    static HOOK_STATE: std::cell::RefCell<Option<Arc<HookSharedState>>> = std::cell::RefCell::new(None);
    /// Non-blocking channel sender for offloading work from the hook callback.
    static HOOK_ACTION_TX: std::cell::RefCell<Option<std::sync::mpsc::Sender<HookAction>>> = std::cell::RefCell::new(None);
}

pub struct KeyboardHookManager {
    hook_thread_id: Mutex<Option<u32>>,
    hook_thread: Mutex<Option<thread::JoinHandle<()>>>,
    shared_state: Mutex<Option<Arc<HookSharedState>>>,
    running: AtomicBool,
}

impl KeyboardHookManager {
    pub fn new() -> Self {
        Self {
            hook_thread_id: Mutex::new(None),
            hook_thread: Mutex::new(None),
            shared_state: Mutex::new(None),
            running: AtomicBool::new(false),
        }
    }

    /// Start the keyboard hook with PTT, hands-free, and AI-cleanup single-key settings.
    pub fn start(&self, app: &AppHandle, ptt_setting: &str, hf_setting: &str, ai_toggle_setting: &str) {
        crate::commands::system::write_log_line(&format!(
            "[ptt-lifecycle] start() called ptt_setting={} hf_setting={} ai_toggle_setting={}",
            ptt_setting, hf_setting, ai_toggle_setting,
        ));
        let has_hook_thread = self.hook_thread.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some();
        if self.running.load(Ordering::SeqCst) || has_hook_thread {
            self.stop();
        }

        let ptt_config = ptt_key_config(ptt_setting);
        let hf_vk_codes = if is_single_key_setting(hf_setting) {
            vk_codes_for_setting(hf_setting)
        } else {
            vec![] // combo key — handled by global_shortcut, not hook
        };
        let ai_toggle_vk_codes = if is_single_key_setting(ai_toggle_setting) {
            vk_codes_for_setting(ai_toggle_setting)
        } else {
            vec![] // combo key — handled by global_shortcut, not hook
        };
        let ptt_full_mask = if ptt_config.vk_codes.is_empty() {
            0
        } else {
            (1_u64 << ptt_config.vk_codes.len()) - 1
        };
        let ptt_last_down_ms = (0..ptt_config.vk_codes.len())
            .map(|_| AtomicI64::new(0))
            .collect();

        let state = Arc::new(HookSharedState {
            ptt_vk_codes: ptt_config.vk_codes,
            ptt_setting: ptt_config.setting,
            ptt_pressed_mask: AtomicU64::new(0),
            ptt_full_mask,
            ptt_modifier_mask: ptt_config.modifier_mask,
            ptt_consumed_down_mask: AtomicU64::new(0),
            ptt_active_generation: AtomicU64::new(0),
            ptt_generation: AtomicU64::new(0),
            ptt_last_down_ms,
            ptt_hook_alive: AtomicBool::new(true),
            hands_free_active: AtomicBool::new(false),
            hf_key_down: AtomicBool::new(false),
            hf_vk_codes,
            hf_setting: hf_setting.to_string(),
            ai_toggle_key_down: AtomicBool::new(false),
            ai_toggle_vk_codes,
            ai_toggle_setting: ai_toggle_setting.to_string(),
            app_handle: app.clone(),
        });

        *self.shared_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(state.clone());
        self.running.store(true, Ordering::SeqCst);

        let state_for_thread = state.clone();
        let (tx, rx) = std::sync::mpsc::channel::<u32>();

        let hook_thread = thread::spawn(move || {
            Self::hook_thread(state_for_thread, tx);
        });
        *self.hook_thread.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(hook_thread);

        // Wait for the thread to report its ID
        if let Ok(thread_id) = rx.recv_timeout(std::time::Duration::from_secs(5)) {
            *self.hook_thread_id.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(thread_id);
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

        // 先清成员位，但不在调用线程清活动代次。hook 线程退出时会在最后一个 callback
        // 完成后，用同一个 sender 依次排入配对 up 和 Shutdown，避免 stop 与 down 入队竞态。
        #[cfg(windows)]
        if let Some(state) = self.shared_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
            let had_active = state.ptt_active_generation.load(Ordering::SeqCst) != 0;
            clear_ptt_members(state);

            if had_active {
                // 保留既有的 synthetic keyup，用于清理由旧版本遗留在 Windows 中的状态。
                // 鼠标侧键不涉及键盘状态，无需（也不能）补发键盘 keyup。
                if !is_mouse_button_setting(&state.ptt_setting) {
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
                    log::info!("[ptt] sent synthetic keyup on stop to clear keyboard state");
                }
            }
        }

        // macOS：我们从不吞修饰键，系统的键盘状态不会被留住，不需要补发 keyup。
        #[cfg(target_os = "macos")]
        if let Some(state) = self.shared_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
            clear_ptt_members(state);
        }

        if let Some(thread_id) = self.hook_thread_id.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            #[cfg(windows)]
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            #[cfg(target_os = "macos")]
            {
                let _ = thread_id;
                macos::request_tap_thread_stop();
            }
        }

        // 等 hook 线程卸载钩子，并等它内部的 dispatcher 处理 Shutdown 后真正退出。
        // 这是重配的跨实例屏障：旧实例不可能在新实例 ptt-down 之后再发旧 ptt-up。
        if let Some(hook_thread) = self.hook_thread.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            if hook_thread.join().is_err() {
                crate::commands::system::write_log_line(
                    "[ptt-lifecycle] hook thread panicked while stopping",
                );
            }
        }

        #[cfg(any(windows, target_os = "macos"))]
        if let Some(state) = self.shared_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
            // 安装失败/panic 时 hook 线程可能没机会排 up；至少不要把 native 状态留住。
            clear_ptt_members(state);
            let _ = clear_ptt_press(&state.ptt_active_generation);
        }
        *self.shared_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Reconfigure with new PTT, hands-free, and AI-cleanup settings.
    pub fn reconfigure(&self, app: &AppHandle, ptt_setting: &str, hf_setting: &str, ai_toggle_setting: &str) {
        let count = RECONFIGURE_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
        crate::commands::system::write_log_line(&format!(
            "[ptt-lifecycle] reconfigure() #{} ptt_setting={} hf_setting={} ai_toggle_setting={} — waiting for old hook shutdown",
            count, ptt_setting, hf_setting, ai_toggle_setting,
        ));
        self.stop();
        // stop() 已 join 旧 hook 与 dispatcher，可直接启动新实例。
        self.start(app, ptt_setting, hf_setting, ai_toggle_setting);
    }

    /// Set hands-free mode active (suppresses PTT up events temporarily)
    #[allow(dead_code)]
    pub fn set_hands_free(&self, active: bool) {
        if let Some(state) = self.shared_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
            state.hands_free_active.store(active, Ordering::SeqCst);
            if active {
                clear_ptt_members(state);
                let _ = clear_ptt_press(&state.ptt_active_generation);
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

        // 无界 mpsc::Sender::send 不会等待消费者，可安全用于低级 hook 回调；相比原来的
        // 64 槽 sync_channel，它不会被按住热键产生的诊断 repeat 填满而丢失关键 up。
        let (action_tx, action_rx) = std::sync::mpsc::channel::<HookAction>();
        let watchdog_action_tx = action_tx.clone();
        let member_watchdog = spawn_ptt_member_watchdog(state.clone(), action_tx.clone());

        let dispatcher_thread = spawn_dispatcher(state.clone(), action_rx, watchdog_action_tx);

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

            let mut hook = match install_hook() {
                Some(h) => h,
                None => {
                    state.ptt_hook_alive.store(false, Ordering::SeqCst);
                    if let Some(handle) = member_watchdog {
                        let _ = handle.join();
                    }
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow_mut().take() {
                            let _ = sender.send(HookAction::Shutdown);
                        }
                    });
                    HOOK_STATE.with(|s| {
                        *s.borrow_mut() = None;
                    });
                    let _ = dispatcher_thread.join();
                    return;
                }
            };

            let install_mouse_hook = || -> Option<windows::Win32::UI::WindowsAndMessaging::HHOOK> {
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
                }
            };
            let mut mouse_hook = if needs_mouse_hook(
                &state.ptt_vk_codes,
                &state.hf_vk_codes,
                &state.ai_toggle_vk_codes,
                SHORTCUT_CAPTURE.load(Ordering::SeqCst),
            ) {
                install_mouse_hook()
            } else {
                crate::commands::system::write_log_line(
                    "[ptt-lifecycle] mouse hook not installed (no mouse button is bound)",
                );
                None
            };

            let thread_id = GetCurrentThreadId();
            let _ = tx.send(thread_id);
            HOOK_THREAD_ID.store(thread_id, Ordering::SeqCst);
            log::info!("keyboard hook message loop starting on thread {}", thread_id);
            // 消息循环开始前录制可能已经打开（那条消息发给了旧线程或还没线程），补一次。
            if mouse_hook.is_none() && SHORTCUT_CAPTURE.load(Ordering::SeqCst) {
                mouse_hook = install_mouse_hook();
            }

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.hwnd.0.is_null() && msg.message == WM_SAYIT_NEED_MOUSE_HOOK {
                    if mouse_hook.is_none() {
                        mouse_hook = install_mouse_hook();
                    }
                    continue;
                }
                if msg.hwnd.0.is_null() && msg.message == WM_SAYIT_REFRESH_HOOKS {
                    // 先装新的再卸旧的：这段代码跑在消息循环线程上，期间不会处理任何钩子回调。
                    if let Some(new_hook) = install_hook() {
                        let _ = UnhookWindowsHookEx(hook);
                        hook = new_hook;
                    }
                    if let Some(old_mouse) = mouse_hook {
                        if let Some(new_mouse) = install_mouse_hook() {
                            let _ = UnhookWindowsHookEx(old_mouse);
                            mouse_hook = Some(new_mouse);
                        }
                    }
                    HOOK_REFRESH_COUNT.fetch_add(1, Ordering::SeqCst);
                    continue;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = HOOK_THREAD_ID.compare_exchange(thread_id, 0, Ordering::SeqCst, Ordering::SeqCst);
            log::info!("keyboard hook message loop exited");
            let _ = UnhookWindowsHookEx(hook);
            if let Some(mh) = mouse_hook {
                let _ = UnhookWindowsHookEx(mh);
            }
        }

        // dispatcher 为 watchdog 持有 sender clone，不能再依赖“所有 sender drop”退出；
        // hook 消息循环结束时显式关闭，避免每次 reconfigure 泄漏线程和 AppHandle。
        // 与 callback 共用同一个 sender：最后一个 callback 已结束后，严格按 FIFO 排入
        // manager_stop up，再排 Shutdown。即使 stop 与 down callback 并发，也不会出现 up 先于 down。
        state.ptt_hook_alive.store(false, Ordering::SeqCst);
        if let Some(handle) = member_watchdog {
            if handle.join().is_err() {
                crate::commands::system::write_log_line(
                    "[ptt-lifecycle] member watchdog panicked while stopping",
                );
            }
        }
        HOOK_ACTION_TX.with(|s| {
            if let Some(sender) = s.borrow_mut().take() {
                clear_ptt_members(&state);
                let vk = state.ptt_vk_codes.first().copied().unwrap_or(0);
                let _ = queue_ptt_release(
                    &sender,
                    &state.ptt_active_generation,
                    None,
                    vk,
                    "manager_stop",
                );
                let _ = sender.send(HookAction::Shutdown);
            }
        });
        HOOK_STATE.with(|s| {
            *s.borrow_mut() = None;
        });
        if dispatcher_thread.join().is_err() {
            crate::commands::system::write_log_line(
                "[ptt-lifecycle] dispatcher thread panicked while stopping",
            );
        }
    }

    /// macOS：CGEventTap，见 keyboard/macos.rs。
    #[cfg(target_os = "macos")]
    fn hook_thread(state: Arc<HookSharedState>, tx: std::sync::mpsc::Sender<u32>) {
        macos::hook_thread(state, tx);
    }

    #[cfg(not(any(windows, target_os = "macos")))]
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
                    if sender.send(HookAction::MouseCaptured { vk }).is_err() {
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
            let ptt_member = ptt_member_index(&state.ptt_vk_codes, vk);
            let is_ptt_key = ptt_member.is_some();
            let is_hf_key = !state.hf_vk_codes.is_empty()
                && state.hf_vk_codes.contains(&vk)
                && !is_ptt_key; // 同一键时 PTT 优先
            let is_ai_toggle_key = !state.ai_toggle_vk_codes.is_empty()
                && state.ai_toggle_vk_codes.contains(&vk)
                && !is_ptt_key
                && !is_hf_key; // PTT / 免提高于 AI 开关

            if let Some(member_index) = ptt_member {
                // 鼠标按键只允许旧单键格式；按下和抬起都吞掉，避免误触发其它程序导航。
                consumed = true;

                if is_down {
                    state.ptt_last_down_ms[member_index].store(now_ms(), Ordering::SeqCst);
                    let became_complete = press_ptt_member(
                        &state.ptt_pressed_mask,
                        member_index,
                        state.ptt_full_mask,
                    );
                    if became_complete && !state.hands_free_active.load(Ordering::SeqCst) {
                        if let Some(gen) = begin_ptt_press(
                            &state.ptt_active_generation,
                            &state.ptt_generation,
                        ) {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    if sender.send(HookAction::PttDown { vk, gen }).is_err() {
                                        let _ = release_ptt_member(
                                            &state.ptt_pressed_mask,
                                            member_index,
                                        );
                                        cancel_ptt_press_start(&state.ptt_active_generation, gen);
                                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            });
                        }
                    }
                }

                if is_up && release_ptt_member(&state.ptt_pressed_mask, member_index) {
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            let _ = queue_ptt_release(
                                sender,
                                &state.ptt_active_generation,
                                None,
                                vk,
                                "keyup",
                            );
                        }
                    });
                }
            }

            if is_hf_key {
                // 免提在首个按下时立即触发；hf_key_down 过滤鼠标驱动可能产生的重复 down。
                if is_down {
                    consumed = true;
                    if begin_hf_press(&state.hf_key_down) {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                if sender.send(HookAction::HfToggle { vk }).is_err() {
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
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
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                if sender.send(HookAction::AiToggle { vk }).is_err() {
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
                    }
                }
                if is_up && end_hf_press(&state.ai_toggle_key_down) {
                    consumed = true;
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
        let is_kup = msg == WM_KEYUP || msg == WM_SYSKEYUP;

        // ── 侧键录制捕获（键盘侧）：必须放在下面的“幻影过滤”之前，因为罗技等改键鼠标
        //    发出的浏览器后退/前进键通常带“注入”标志，会被幻影过滤器直接丢掉。 ──
        if SHORTCUT_CAPTURE.load(Ordering::SeqCst) {
            // 捕获模式中的任何键都必须先结束仍活动的 PTT；放在 BrowserBack/Forward
            // 早退之前，否则这两个键可让前端录音只剩 5 分钟硬截止。
            HOOK_STATE.with(|s| {
                if let Some(state) = s.borrow().as_ref() {
                    clear_ptt_members(state);
                    if let Some(&ptt_vk) = state.ptt_vk_codes.first() {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                let _ = queue_ptt_release(
                                    sender,
                                    &state.ptt_active_generation,
                                    None,
                                    ptt_vk,
                                    "shortcut_capture",
                                );
                            }
                        });
                    }
                    state.hf_key_down.store(false, Ordering::SeqCst);
                }
            });

            // 浏览器后退/前进键 → 作为侧键绑定，并吞掉避免 webview 后退/前进导航。
            if vk == 0xA6 || vk == 0xA7 {
                if is_kdown {
                    SHORTCUT_CAPTURE.store(false, Ordering::SeqCst);
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            let _ = sender.send(HookAction::MouseCaptured { vk });
                        }
                    });
                }
                return LRESULT(1);
            }

            // 其余按键一律放行给 webview 去绑定，本轮不做任何 PTT/免提判定：
            // 录制时按到已绑定的热键（如免提的右 Alt）应该被录进设置或提示冲突，
            // 而不是触发录音弹出悬浮窗。
            return CallNextHookEx(None, n_code, w_param, l_param);
        }

        // 幻影过滤：注入或 scanCode==0 视为系统合成键，放行、不当作用户按键。
        // 例外见 is_injection_exempt_vk（侧键改写键、F13–F24）——这些键的正常来源就是
        // 注入，按幻影丢弃会让用户绑了不生效，且不留任何日志线索。
        let is_synthetic = ((kb.flags.0 & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0
            || kb.scanCode == 0)
            && !is_injection_exempt_vk(vk);
        if is_synthetic {
            // 只接受“已有真实 PTT down”的合成抬起作为释放信号。Windows 辅助功能、
            // 远程桌面或驱动可能把配对 up 标成 injected/scanCode=0；此前在这里直接
            // 早退会让录音永久卡住。孤立 synthetic up 因没有活动代次仍会被忽略。
            let mut consume_paired_up = false;
            if is_kup {
                HOOK_STATE.with(|s| {
                    if let Some(state) = s.borrow().as_ref() {
                        // 真实 HF down 的配对 up 偶尔会被远程桌面/驱动标成 synthetic。
                        // 即使不把它当作一次触发，也必须清掉按下状态，否则下一次真实按下
                        // 会被误认成 repeat 而没有反应。
                        if state.hf_vk_codes.contains(&vk) {
                            consume_paired_up = end_hf_press(&state.hf_key_down);
                        }
                        if let Some(member_index) = ptt_member_index(&state.ptt_vk_codes, vk) {
                            let member_bit = 1_u64 << member_index;
                            consume_paired_up = state
                                .ptt_consumed_down_mask
                                .fetch_and(!member_bit, Ordering::SeqCst)
                                & member_bit
                                != 0;
                            let physically_down = unsafe { is_ptt_member_physically_down(vk) };
                            if !physically_down
                                && release_ptt_member(&state.ptt_pressed_mask, member_index)
                            {
                                HOOK_ACTION_TX.with(|tx| {
                                    if let Some(sender) = tx.borrow().as_ref() {
                                        let _ = queue_ptt_release(
                                            sender,
                                            &state.ptt_active_generation,
                                            None,
                                            vk,
                                            "synthetic_keyup",
                                        );
                                    }
                                });
                            }
                        }
                    }
                });
            }
            if consume_paired_up {
                return LRESULT(1);
            }
            return CallNextHookEx(None, n_code, w_param, l_param);
        }

        // overlay 不聚焦，录音中/处理中/兜底卡片的 Esc 必须在这里全局捕获。
        // 只在前端短暂开启的模式下吞键；配对的 keyup 即使模式已被前端关闭也继续吞掉，
        // 避免目标应用只收到一个孤立的 Esc 抬起事件。
        const VK_ESCAPE: u32 = 0x1B;
        if vk == VK_ESCAPE {
            let is_kup = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if is_kdown {
                if ESCAPE_KEY_DOWN.load(Ordering::SeqCst) {
                    return LRESULT(1);
                }
                let (mode, token) = active_escape_action();
                if mode != ESCAPE_MODE_OFF {
                    let first_down = !ESCAPE_KEY_DOWN.swap(true, Ordering::SeqCst);
                    if first_down {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                if sender.send(HookAction::Escape { mode, token }).is_err() {
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
                    }
                    return LRESULT(1);
                }
            }
            if is_kup && ESCAPE_KEY_DOWN.swap(false, Ordering::SeqCst) {
                return LRESULT(1);
            }
        }

        // 悬浮窗卡片的 Ctrl+C。判据与上面的 Esc 同构（mask + token + deadline），
        // 额外两道：这一刻 Ctrl 必须按着，且前台窗口仍是卡片弹出时那个 —— 用户切走
        // 之后，他的 Ctrl+C 就该归他自己。
        const VK_C: u32 = 0x43;
        if vk == VK_C {
            if is_kdown {
                if CARD_HOTKEY_C_DOWN.load(Ordering::SeqCst) {
                    // 按住不放产生的 repeat：继续吞，但不重复投递动作。
                    return LRESULT(1);
                }
                let (mask, token) = active_card_hotkeys();
                if mask & CARD_HOTKEY_COPY != 0
                    && only_ctrl_is_down(kb_flags)
                    && card_hotkey_foreground_matches()
                {
                    CARD_HOTKEY_C_DOWN.store(true, Ordering::SeqCst);
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            if sender
                                .send(HookAction::CardHotkey { action: CARD_HOTKEY_COPY, token })
                                .is_err()
                            {
                                TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    });
                    return LRESULT(1);
                }
            }
            if is_kup && CARD_HOTKEY_C_DOWN.swap(false, Ordering::SeqCst) {
                return LRESULT(1);
            }
        }

        // ── CRITICAL: This callback MUST return within ~200ms or Windows
        // will silently remove the hook. NO blocking operations allowed.
        // All logging and emit are offloaded through the non-blocking action channel.

        let mut consumed = false;

        HOOK_STATE.with(|s| {
            if let Some(state) = s.borrow().as_ref() {
                let ptt_member = ptt_member_index(&state.ptt_vk_codes, vk);
                let is_ptt_key = ptt_member.is_some();
                let is_hf_key = !state.hf_vk_codes.is_empty()
                    && state.hf_vk_codes.contains(&vk)
                    && !is_ptt_key; // PTT takes priority if same key
                let is_ai_toggle_key = !state.ai_toggle_vk_codes.is_empty()
                    && state.ai_toggle_vk_codes.contains(&vk)
                    && !is_ptt_key
                    && !is_hf_key; // PTT / hands-free take priority if misconfigured

                // Alt 键（VK_LMENU=0xA4 / VK_RMENU=0xA5）作为单键热键时，keyup 也必须吞掉。
                // 否则被放行的 Alt 抬起会被 Windows 判为「单击了一下 Alt」→ 激活前台程序的
                // 菜单栏（如记事本显示「文件(F)」等加速键下划线），抢走输入框焦点，导致随后
                // 插字落到菜单上、实际没插进去（而 SendInput 仍上报成功，形成假成功）。
                // keydown 既已被吞、系统自始至终没见过这个 Alt，连 keyup 一起吞不会造成
                // 「修饰键卡住」。非 Alt 单键（F 键、Space、侧键等）维持原状：只吞 keydown。
                let is_alt_key = vk == 0xA4 || vk == 0xA5;

                // 单键热键必须是「裸按」才算命中：Alt+F4 不该唤起绑在 F4 上的免提。
                //
                // ⚠️ **只能用在 keydown 上。** keyup 一律照原样处理 —— 否则
                // 「按 F4 开始录音 → 再按住 Alt → 松开 F4」会因为松开那一刻有修饰键
                // 而跳过释放，录音就再也停不下来了（只能等 5 分钟硬截止）。
                let modifiers_block_down = single_key_blocked_by_modifiers(vk, kb_flags);

                // ── 诊断：仅在「当前配置的 PTT/免提热键」被按下时记录 flags/scanCode ──
                // 只记每个组合成员的首个 down，不把按住产生的 repeat 全部塞进无界队列；
                // 漏 key-up 看门狗直接刷新该成员的 last_down，不依赖诊断日志。
                let should_log_hotkey_down = is_kdown
                    && ((ptt_member.is_some_and(|index| {
                        state.ptt_pressed_mask.load(Ordering::SeqCst) & (1_u64 << index) == 0
                    }) && !state.hands_free_active.load(Ordering::SeqCst))
                        || (is_hf_key && !state.hf_key_down.load(Ordering::SeqCst)));
                if should_log_hotkey_down {
                    // 两种名字要分开：不然「按 Alt+F4 没反应」和「热键压根没送到」
                    // 在日志里长得一模一样，排查时无从下手。
                    // 组合键 PTT 命中时 modifiers_block_down 也可能为真（它就是要修饰键），
                    // 那种情况按下面 bare_press_violated 的规则放行，这条日志只作提示。
                    let msg_name = if modifiers_block_down {
                        "hotkey-down-with-modifier"
                    } else {
                        "hotkey-down"
                    };
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            if sender.send(HookAction::Diag {
                                vk, msg_name, flags: kb_flags, scan_code: kb_scan_code,
                            }).is_err() {
                                TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    });
                }

                if let Some(member_index) = ptt_member {
                    if is_kdown {
                        reconcile_stale_ptt_members_before_down(state, member_index);
                    }
                    let member_bit = 1_u64 << member_index;
                    let is_combo = state.ptt_vk_codes.len() > 1;
                    let is_pure_modifier_combo = is_combo
                        && state.ptt_modifier_mask == state.ptt_full_mask;
                    let is_main_key = state.ptt_modifier_mask & member_bit == 0;
                    // 「裸按」规则只套单键 PTT。组合键（Alt+F4 之类）本来就要求修饰键
                    // 按住，套上去等于把它自己永久挡死。
                    let bare_press_violated = !is_combo && modifiers_block_down;

                    // 旧单键维持原消费策略。普通组合仅当主键首次按下时所需修饰键
                    // 已全部按住，才吞主键 down，并用位图保证只吞它配对的 up。
                    // 若顺序是 K→Ctrl，组合仍可开始，但 K 的 down/up 都放行，不制造孤立事件。
                    if !is_combo {
                        // 带修饰键按下时整条放行：不吞，让 Alt+F4 这类系统/程序快捷键
                        // 照常送到前台程序。下面的按下记账也一并跳过。
                        if (is_kdown && !bare_press_violated) || (is_kup && is_alt_key) {
                            consumed = true;
                        }
                    } else if !is_pure_modifier_combo && is_main_key {
                        if is_kdown {
                            let pressed_before =
                                state.ptt_pressed_mask.load(Ordering::SeqCst);
                            let consume_this_press = should_consume_combo_main_down(
                                pressed_before,
                                state.ptt_consumed_down_mask.load(Ordering::SeqCst),
                                member_bit,
                                state.ptt_modifier_mask,
                            );
                            if consume_this_press {
                                state
                                    .ptt_consumed_down_mask
                                    .fetch_or(member_bit, Ordering::SeqCst);
                                consumed = true;
                            }
                        }
                        if is_kup
                            && state
                                .ptt_consumed_down_mask
                                .fetch_and(!member_bit, Ordering::SeqCst)
                                & member_bit
                                != 0
                        {
                            consumed = true;
                        }
                    }

                    // 记账也要跳过：否则 Alt+F4 虽然没被吞，录音照样开始了。
                    if is_kdown && !bare_press_violated {
                        state.ptt_last_down_ms[member_index].store(now_ms(), Ordering::SeqCst);
                        let became_complete = press_ptt_member(
                            &state.ptt_pressed_mask,
                            member_index,
                            state.ptt_full_mask,
                        );
                        if became_complete && !state.hands_free_active.load(Ordering::SeqCst) {
                            if let Some(gen) = begin_ptt_press(
                                &state.ptt_active_generation,
                                &state.ptt_generation,
                            ) {
                                HOOK_ACTION_TX.with(|tx| {
                                    if let Some(sender) = tx.borrow().as_ref() {
                                        if sender.send(HookAction::PttDown { vk, gen }).is_err() {
                                            let _ = release_ptt_member(
                                                &state.ptt_pressed_mask,
                                                member_index,
                                            );
                                            state
                                                .ptt_consumed_down_mask
                                                .fetch_and(!member_bit, Ordering::SeqCst);
                                            cancel_ptt_press_start(
                                                &state.ptt_active_generation,
                                                gen,
                                            );
                                            TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                        }
                                    }
                                });
                            }
                        }
                    }

                    // 活动时任意成员松开都结束；未完成组合时的成员 up 只更新位图。
                    if is_kup && release_ptt_member(&state.ptt_pressed_mask, member_index) {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                let _ = queue_ptt_release(
                                    sender,
                                    &state.ptt_active_generation,
                                    None,
                                    vk,
                                    "member_keyup",
                                );
                            }
                        });
                    }
                }

                // 免提键：首次 keydown 立即触发，后续 repeat down 忽略；keyup 只负责重新布防。
                // 合成 keydown 仍在上方被过滤，所以远程桌面的幻影 Alt 不会触发录音。
                if is_hf_key {
                    let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    // 带修饰键按下时整条放行。不 begin_hf_press ⇒ hf_key_down 仍是 false
                    // ⇒ 下面的 end_hf_press 也返回 false，配对的 keyup 同样不吞。
                    if is_down && !modifiers_block_down {
                        consumed = true; // 吞掉 keydown 防止系统处理
                        if begin_hf_press(&state.hf_key_down) {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    if sender.send(HookAction::HfToggle { vk }).is_err() {
                                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            });
                        }
                    }
                    if is_up {
                        // 吞掉与首个 down 配对的 up，避免向目标程序留下孤立的按键事件。
                        if end_hf_press(&state.hf_key_down) || is_alt_key {
                            consumed = true;
                        }
                    }
                }

                if is_ai_toggle_key {
                    let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    // 同免提：带修饰键就整条放行（见上面 modifiers_block_down 的注释）
                    if is_down && !modifiers_block_down {
                        consumed = true;
                        if begin_hf_press(&state.ai_toggle_key_down) {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    if sender.send(HookAction::AiToggle { vk }).is_err() {
                                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            });
                        }
                    }
                    if is_up && (end_hf_press(&state.ai_toggle_key_down) || is_alt_key) {
                        consumed = true;
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

#[cfg(test)]
mod tests {
    use super::{
        active_card_hotkeys, begin_hf_press, begin_ptt_press, card_hotkey_action_name,
        claim_ptt_release, complete_ptt_release, end_hf_press, escape_action_mode_name,
        is_injection_exempt_vk, is_mouse_button_setting, is_mouse_vk, modifier_kind,
        press_ptt_member, ptt_key_config, release_ptt_member, set_card_hotkeys,
        set_escape_action_mode, should_consume_combo_main_down, single_key_requires_bare_press,
        CARD_HOTKEY_COPY, CARD_HOTKEY_DEADLINE_MS, CARD_HOTKEY_FOREGROUND, DEFAULT_PTT_SETTING,
        DEFAULT_PTT_VK, SINGLE_KEY_TABLE, needs_mouse_hook, hook_looks_removed,
    };
    #[cfg(any(windows, target_os = "macos"))]
    use super::queue_ptt_release;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    /// 卡片快捷键的三道闸门与自清。
    ///
    /// 这些是进程级静态量，所以整组断言刻意放在**同一个** #[test] 里 —— 拆成多个会被
    /// 并行调度互相踩掉，表现为随机失败。
    #[test]
    fn card_hotkeys_are_scoped_to_one_card_and_expire_on_their_own() {
        // 未知动作必须报错，绝不能静默开成"什么都不接管"或"全都接管"。
        assert!(set_card_hotkeys(&["retry".to_string()], 1).is_err());

        set_card_hotkeys(&["copy".to_string()], 7).unwrap();
        assert_eq!(active_card_hotkeys(), (CARD_HOTKEY_COPY, 7));

        // 续期（同 token）绝不能重新取前台窗口：卡片可见期间用户可能已经切走，
        // 那正是要解除接管的情形，重新取会把新前台当成"卡片的主人"又接管回来。
        CARD_HOTKEY_FOREGROUND.store(0x1234, Ordering::SeqCst);
        set_card_hotkeys(&["copy".to_string()], 7).unwrap();
        assert_eq!(
            CARD_HOTKEY_FOREGROUND.load(Ordering::SeqCst),
            0x1234,
            "renewal must keep the foreground window captured when the card appeared",
        );

        // 过了硬截止就自己关掉，不依赖前端来解除（渲染端卡死时不能永久吞 Ctrl+C）。
        CARD_HOTKEY_DEADLINE_MS.store(1, Ordering::SeqCst);
        assert_eq!(active_card_hotkeys(), (0, 0));
        assert_eq!(
            CARD_HOTKEY_FOREGROUND.load(Ordering::SeqCst),
            0,
            "expiry must also drop the captured foreground window",
        );

        // 空数组 = 解除。
        set_card_hotkeys(&["copy".to_string()], 8).unwrap();
        set_card_hotkeys(&[], 8).unwrap();
        assert_eq!(active_card_hotkeys(), (0, 0));
    }

    /// 动作名与模式名是**跨进程契约**：前端按这两个字符串分派。
    /// 改名就会静默失效（事件照发、前端认不出来），所以在这里钉住。
    #[test]
    fn hotkey_and_escape_names_match_the_frontend_contract() {
        assert_eq!(card_hotkey_action_name(CARD_HOTKEY_COPY), "copy");

        for mode in [
            "off",
            "cancel_recording",
            "cancel_processing",
            "dismiss_fallback",
            "abandon_late_result",
        ] {
            set_escape_action_mode(mode, 1).unwrap();
            // off 的 token 会被清零，其余模式都该原样读回自己的名字。
            let value = super::ESCAPE_ACTION_MODE.load(Ordering::SeqCst);
            assert_eq!(escape_action_mode_name(value), mode, "mode name drifted: {mode}");
        }
        set_escape_action_mode("off", 0).unwrap();
    }

    #[test]
    fn hands_free_triggers_on_first_down_and_rearms_on_up() {
        let key_down = AtomicBool::new(false);

        assert!(begin_hf_press(&key_down));
        assert!(!begin_hf_press(&key_down), "repeat down must not toggle again");
        assert!(end_hf_press(&key_down));
        assert!(!end_hf_press(&key_down), "orphan up is ignored");
        assert!(begin_hf_press(&key_down), "next physical press is re-armed");
    }

    #[test]
    fn ptt_release_is_idempotent_for_normal_or_synthetic_keyup() {
        let active_generation = AtomicU64::new(0);
        let generation = AtomicU64::new(0);

        let gen = begin_ptt_press(&active_generation, &generation).expect("first down starts a run");
        assert_eq!(gen, 1);
        assert!(begin_ptt_press(&active_generation, &generation).is_none());
        assert_eq!(claim_ptt_release(&active_generation, None), Some(gen));
        assert!(claim_ptt_release(&active_generation, None).is_none());
        assert!(complete_ptt_release(&active_generation, gen));
        assert_eq!(active_generation.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn combo_starts_only_when_all_members_are_down_and_repeat_does_not_restart() {
        let pressed_mask = AtomicU64::new(0);
        let full_mask = 0b11;

        assert!(!press_ptt_member(&pressed_mask, 0, full_mask));
        assert_eq!(pressed_mask.load(Ordering::SeqCst), 0b01);
        assert!(press_ptt_member(&pressed_mask, 1, full_mask));
        assert_eq!(pressed_mask.load(Ordering::SeqCst), full_mask);
        assert!(!press_ptt_member(&pressed_mask, 1, full_mask));
    }

    #[test]
    fn combo_main_key_is_consumed_only_when_modifiers_precede_it() {
        let modifier_mask = 0b01;
        let main_bit = 0b10;

        assert!(!should_consume_combo_main_down(
            0,
            0,
            main_bit,
            modifier_mask,
        ));
        assert!(should_consume_combo_main_down(
            modifier_mask,
            0,
            main_bit,
            modifier_mask,
        ));
        // K 先按下且当时已放行；之后再按 Ctrl，K 的 repeat 也必须继续放行。
        assert!(!should_consume_combo_main_down(
            main_bit | modifier_mask,
            0,
            main_bit,
            modifier_mask,
        ));
        // 若最初的 K down 已吞，repeat 继续吞，直到配对 up 清掉 consumed bit。
        assert!(should_consume_combo_main_down(
            main_bit | modifier_mask,
            main_bit,
            main_bit,
            modifier_mask,
        ));
    }

    #[test]
    fn any_combo_member_up_releases_and_can_complete_again() {
        let pressed_mask = AtomicU64::new(0);
        let full_mask = 0b11;
        assert!(!press_ptt_member(&pressed_mask, 0, full_mask));
        assert!(press_ptt_member(&pressed_mask, 1, full_mask));

        assert!(release_ptt_member(&pressed_mask, 0));
        assert_eq!(pressed_mask.load(Ordering::SeqCst), 0b10);
        assert!(!release_ptt_member(&pressed_mask, 0));
        assert!(press_ptt_member(&pressed_mask, 0, full_mask));
    }

    #[test]
    fn parses_legacy_normal_and_modifier_only_ptt_settings() {
        let legacy = ptt_key_config("ShiftRight");
        assert_eq!(legacy.setting, "ShiftRight");
        assert_eq!(legacy.vk_codes, vec![0xA1]);
        assert_eq!(legacy.modifier_mask, 0b1);

        let normal_combo = ptt_key_config("ControlLeft+KeyK");
        assert_eq!(normal_combo.vk_codes, vec![0xA2, 0x4B]);
        assert_eq!(normal_combo.modifier_mask, 0b01);

        let modifier_combo = ptt_key_config("ControlLeft+MetaLeft");
        assert_eq!(modifier_combo.vk_codes, vec![0xA2, 0x5B]);
        assert_eq!(modifier_combo.modifier_mask, 0b11);
    }

    #[test]
    fn invalid_ptt_setting_safely_falls_back_to_the_default_key() {
        let config = ptt_key_config("ControlLeft+UnknownKey");
        assert_eq!(config.setting, DEFAULT_PTT_SETTING);
        assert_eq!(config.vk_codes, vec![DEFAULT_PTT_VK]);
        assert_eq!(config.modifier_mask, 0b1);

        let duplicate_family = ptt_key_config("ControlLeft+ControlRight+KeyK");
        assert_eq!(duplicate_family.setting, DEFAULT_PTT_SETTING);
        assert_eq!(duplicate_family.vk_codes, vec![DEFAULT_PTT_VK]);
    }

    /// 默认键绝不能是 Shift：那正是会触发 Windows 筛选键、让录音停不下来的键。
    /// 有人把默认值改回去时，这条会拦住。
    #[test]
    fn default_ptt_key_is_never_shift() {
        assert!(!DEFAULT_PTT_SETTING.contains("Shift"));
        assert_ne!(DEFAULT_PTT_VK, 0xA0);
        assert_ne!(DEFAULT_PTT_VK, 0xA1);
        // 默认键必须自身可解析，否则 fallback 会陷入"回退到一个非法值"
        assert_eq!(ptt_key_config(DEFAULT_PTT_SETTING).setting, DEFAULT_PTT_SETTING);
    }

    /// 老用户存的 ShiftRight 必须继续被解析、继续生效。
    /// 前端不再让人新设 Shift，但已经存在的绑定不能因为升级就失灵。
    #[test]
    fn legacy_shift_binding_still_parses() {
        let legacy = ptt_key_config("ShiftRight");
        assert_eq!(legacy.setting, "ShiftRight");
        assert_eq!(legacy.vk_codes, vec![0xA1]);
    }

    #[test]
    fn release_must_be_queued_before_the_next_ptt_run_can_start() {
        let active_generation = AtomicU64::new(0);
        let generation = AtomicU64::new(0);

        let old_gen = begin_ptt_press(&active_generation, &generation).expect("old run starts");
        assert_eq!(claim_ptt_release(&active_generation, Some(old_gen)), Some(old_gen));
        assert!(begin_ptt_press(&active_generation, &generation).is_none());
        assert!(complete_ptt_release(&active_generation, old_gen));

        let new_gen = begin_ptt_press(&active_generation, &generation).expect("new run starts");
        assert_ne!(new_gen, old_gen);
        assert!(claim_ptt_release(&active_generation, Some(old_gen)).is_none());
        assert_eq!(active_generation.load(Ordering::SeqCst), new_gen);
        assert_eq!(claim_ptt_release(&active_generation, Some(new_gen)), Some(new_gen));
        assert!(complete_ptt_release(&active_generation, new_gen));
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn disconnected_dispatcher_releases_native_ptt_state() {
        let active_generation = AtomicU64::new(0);
        let generation = AtomicU64::new(20);
        let active_gen =
            begin_ptt_press(&active_generation, &generation).expect("run starts");
        let (sender, receiver) = std::sync::mpsc::channel();
        drop(receiver);

        assert!(!queue_ptt_release(
            &sender,
            &active_generation,
            Some(active_gen),
            0xA1,
            "keyup",
        ));
        assert_eq!(active_generation.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn watchdog_release_requires_the_active_generation() {
        let active_generation = AtomicU64::new(0);
        let generation = AtomicU64::new(40);

        let active_gen =
            begin_ptt_press(&active_generation, &generation).expect("run starts");
        assert!(claim_ptt_release(&active_generation, Some(active_gen + 2)).is_none());
        assert_eq!(active_generation.load(Ordering::SeqCst), active_gen);
        assert_eq!(claim_ptt_release(&active_generation, Some(active_gen)), Some(active_gen));
        assert!(complete_ptt_release(&active_generation, active_gen));
    }

    #[test]
    fn hook_removal_is_suspected_only_when_input_outran_the_callback() {
        // 按键刚经过钩子：回调和输入一样新
        assert!(!hook_looks_removed(1_000, 1_000));
        // 用户已经很久没动：两边差不多一样旧
        assert!(!hook_looks_removed(600_000, 598_000));
        // 很久没按键、10 秒前动了下鼠标：也会判成可疑（没装鼠标钩子时的已知误报，代价只是重装一次）
        assert!(hook_looks_removed(600_000, 590_000));
        // 2 分钟没回调，但 3 秒前有输入：可能被摘了
        assert!(hook_looks_removed(120_000, 3_000));
        // 差距在 5 秒以内不算
        assert!(!hook_looks_removed(8_000, 4_000));
        // 还没收到过任何回调（-1）时不判
        assert!(!hook_looks_removed(-1, 0));
    }

    #[test]
    fn mouse_hook_is_only_needed_for_mouse_bindings_or_capture() {
        let keyboard = [0xA3u32];
        assert!(!needs_mouse_hook(&keyboard, &[0xA5], &[], false));
        assert!(needs_mouse_hook(&keyboard, &[0xA5], &[], true));
        assert!(needs_mouse_hook(&[0x05], &[0xA5], &[], false));
        assert!(needs_mouse_hook(&keyboard, &[0x06], &[], false));
        assert!(needs_mouse_hook(&keyboard, &[], &[0x04], false));
    }

    /// 鼠标按键清单必须与 `is_mouse_vk` 保持一致。
    ///
    /// 这两处一旦不同步就是静默失败：两个 PTT 看门狗靠 `is_mouse_vk` 绕开
    /// 「repeat 静默 + 异步键状态」判据，漏掉一个鼠标键的后果是按住它录音会在
    /// 1.7 秒后被强制结束（0.1.5 的实测症状），而编译和其它测试都不会报错。
    #[test]
    fn is_mouse_vk_covers_every_mouse_button_in_the_key_table() {
        for (code, vk) in SINGLE_KEY_TABLE {
            let listed_as_mouse = is_mouse_button_setting(code);
            assert_eq!(
                listed_as_mouse,
                is_mouse_vk(*vk),
                "{code} (vk={vk:#04x}): is_mouse_button_setting={listed_as_mouse} \
                 但 is_mouse_vk={}，两处判定必须一致",
                is_mouse_vk(*vk),
            );
        }
    }

    /// 「裸按」规则必须覆盖每一个主键，且必须放过每一个修饰键。
    ///
    /// 这两条各自对应一个真实故障：漏掉主键 → Alt+F4 会唤起绑在 F4 上的免提，
    /// 而且 F4 的 down 被吞掉、Alt+F4 本身也失效（用户报的就是这个）；
    /// 误伤修饰键 → 「按住说话」默认的右 Ctrl、免提默认的右 Alt 会永久失效
    /// （自己就是 Ctrl，再问「Ctrl 有没有按下」永远为真），而且是静默的：
    /// 编译过、其它测试全绿，只有真机上按下去没反应。
    #[test]
    fn bare_press_rule_covers_main_keys_and_spares_modifiers() {
        for (code, vk) in SINGLE_KEY_TABLE {
            let is_modifier = modifier_kind(code).is_some();
            let is_mouse = is_mouse_button_setting(code);
            let expected = !is_modifier && !is_mouse;
            assert_eq!(
                single_key_requires_bare_press(*vk),
                expected,
                "{code} (vk={vk:#04x})：modifier={is_modifier} mouse={is_mouse}，\
                 应当 requires_bare_press={expected}",
            );
        }
    }

    /// 几个点名的键，防止上面那条循环因为清单本身写错而一起错。
    #[test]
    fn bare_press_rule_named_cases() {
        assert!(single_key_requires_bare_press(0x73), "F4 是主键，必须要求裸按");
        assert!(single_key_requires_bare_press(0x20), "Space 是主键");
        assert!(single_key_requires_bare_press(0xA6), "BrowserBack 走键盘钩子，算主键");
        assert!(!single_key_requires_bare_press(0xA3), "右 Ctrl 是「按住说话」默认键，不能套");
        assert!(!single_key_requires_bare_press(0xA5), "右 Alt 是免提默认键，也是 AltGr 的一半");
        assert!(!single_key_requires_bare_press(0x05), "鼠标侧键走鼠标钩子，不套这条");
    }

    /// 鼠标按键只允许单键格式。两个看门狗跳过鼠标成员时依赖这一点：
    /// 单键设置只有一个成员，不存在「组合里半个键被清掉」的情况。
    #[test]
    fn mouse_buttons_are_single_key_only() {
        for combo in ["XButton1+KeyA", "ControlLeft+XButton1", "MButton+ShiftLeft"] {
            let config = ptt_key_config(combo);
            assert_ne!(
                config.setting, combo,
                "{combo} 不该被接受为有效组合（鼠标键只允许单键）",
            );
        }
        for single in ["XButton1", "XButton2", "MButton"] {
            let config = ptt_key_config(single);
            assert_eq!(config.setting, single, "{single} 应当是有效的单键设置");
            assert_eq!(config.vk_codes.len(), 1, "{single} 应当只有一个成员");
        }
    }

    /// F1–F24 必须全部在表里、且 vk 连续等于 0x70 + (n-1)。
    ///
    /// 这张表与前端 `lib/shortcutKeys.ts` 的 `SINGLE_KEYS` 是两份手写副本，只改一边
    /// 是**静默失败**：前端放行 F13、Rust 查不到它，`ptt_key_config` 的 valid_shape
    /// 落空后走 `fallback()` —— 用户界面上显示 F13，实际说话键悄悄变成右 Ctrl，
    /// 编译和其它测试都不报错。TS 侧有一条对称的断言。
    #[test]
    fn function_keys_f1_through_f24_are_all_present_with_contiguous_vks() {
        for n in 1..=24_u32 {
            let code = format!("F{n}");
            let expected_vk = 0x70 + n - 1;
            let found = SINGLE_KEY_TABLE
                .iter()
                .find(|(setting, _)| *setting == code.as_str());
            let Some((_, vk)) = found else {
                panic!("{code} 不在 SINGLE_KEY_TABLE 里（前端 SINGLE_KEYS 有 F1–F24，两边必须一致）");
            };
            assert_eq!(
                *vk, expected_vk,
                "{code} 的 vk 应当是 {expected_vk:#04x}（VK_F1..VK_F24 是连续的）",
            );

            // 解析必须真的接受它，而不是回落到默认键。
            let config = ptt_key_config(&code);
            assert_eq!(config.setting, code, "{code} 应当被接受为有效单键，而不是回落");
            assert_eq!(config.vk_codes, vec![expected_vk], "{code} 应当解析出对应 vk");
        }
    }

    /// 幻影过滤的例外范围：F13–F24 与两个侧键改写键在内，边界之外不在。
    ///
    /// 这些键带 injected 标志是正常来源（改键软件走 SendInput），漏掉任何一个的症状
    /// 都是「绑得上、按下去没反应、日志里也没有记录」。
    #[test]
    fn injection_exempt_vks_cover_f13_to_f24_and_side_button_remaps() {
        for vk in 0x7C..=0x87_u32 {
            assert!(is_injection_exempt_vk(vk), "{vk:#04x}（F13–F24 段）必须开例外");
        }
        assert!(is_injection_exempt_vk(0xA6), "BrowserBack 必须开例外");
        assert!(is_injection_exempt_vk(0xA7), "BrowserForward 必须开例外");

        // 边界：F12 及以下是物理真键，注入的 F12 没有正常来源，维持幻影过滤。
        assert!(!is_injection_exempt_vk(0x7B), "F12 不该开例外");
        assert!(!is_injection_exempt_vk(0x88), "0x88 已越过 F24，不该开例外");
        // 幻影过滤本来要防的就是合成 Alt，绝不能被例外放进来。
        assert!(!is_injection_exempt_vk(0xA4), "左 Alt 绝不能开例外");
        assert!(!is_injection_exempt_vk(0xA5), "右 Alt 绝不能开例外");
    }
}
