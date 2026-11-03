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
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::time::Instant;

/// 每次剪贴板粘贴递增。旧恢复线程看到新一代粘贴后会放弃，避免覆盖新内容。
#[cfg(windows)]
static PASTE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
struct ClipboardRestoreGuard {
    enabled: bool,
    previous_text: Option<String>,
    /// 插入前剪贴板的全部格式。None = 没拍成（超预算 / 打不开），退回只还原文字。
    previous_snapshot: Option<ClipboardSnapshot>,
    injected_text: String,
    paste_id: u64,
}

#[cfg(windows)]
impl ClipboardRestoreGuard {
    fn new(
        enabled: bool,
        previous_text: Option<String>,
        previous_snapshot: Option<ClipboardSnapshot>,
        injected_text: &str,
        paste_id: u64,
    ) -> Self {
        Self {
            enabled,
            previous_text,
            previous_snapshot,
            injected_text: injected_text.to_owned(),
            paste_id,
        }
    }
}

/// 插入前剪贴板里的全部内容：每种能按字节复制的格式各一份。
///
/// 原来只存文字（CF_UNICODETEXT），用户刚复制的截图、文件、带格式的文本在口述一次之后
/// 就没了，或者被降级成纯文本。
#[cfg(windows)]
#[derive(Default)]
struct ClipboardSnapshot {
    formats: Vec<(u32, Vec<u8>)>,
}

/// 拍快照的预算：超了就放弃，退回只还原文字。
///
/// 有些程序是延迟渲染（Excel 复制一大片区域时，读取那一刻才现场生成几十种格式），
/// 读起来可能很慢，而这一步在插字的关键路径上，不能为了还原剪贴板把插字拖慢。
#[cfg(windows)]
const CLIPBOARD_SNAPSHOT_BUDGET_MS: u128 = 150;
#[cfg(windows)]
const CLIPBOARD_SNAPSHOT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// 这些格式的句柄不是 HGLOBAL（位图、调色板、元文件、自绘、私有/GDI 对象区间），不能按字节复制。
/// 图片靠 CF_DIB / CF_DIBV5 保存，系统会从它们合成 CF_BITMAP。
#[cfg(windows)]
fn clipboard_format_is_copyable(format: u32) -> bool {
    const CF_BITMAP: u32 = 2;
    const CF_METAFILEPICT: u32 = 3;
    const CF_PALETTE: u32 = 9;
    const CF_ENHMETAFILE: u32 = 14;
    !matches!(format, CF_BITMAP | CF_METAFILEPICT | CF_PALETTE | CF_ENHMETAFILE)
        && !(0x0080..=0x008F).contains(&format) // CF_OWNERDISPLAY / CF_DSP*
        && !(0x0200..=0x03FF).contains(&format) // CF_PRIVATEFIRST..CF_GDIOBJLAST
}

#[cfg(windows)]
impl Drop for ClipboardRestoreGuard {
    fn drop(&mut self) {
        if !self.enabled {
            return;
        }

        let previous_text = self.previous_text.take();
        let previous_snapshot = self.previous_snapshot.take();
        let injected_text = std::mem::take(&mut self.injected_text);
        let paste_id = self.paste_id;
        let scheduled_at = Instant::now();

        // Drop 发生在 WM_PASTE/SendInput 已执行之后，因此 400ms 从实际粘贴触发时开始计算。
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let elapsed_ms = scheduled_at.elapsed().as_millis();
            let current_generation = PASTE_GENERATION.load(Ordering::Acquire);
            if current_generation != paste_id {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [inject] clipboard restore skipped pasteId={} reason=superseded currentGeneration={} elapsedMs={}",
                    paste_id, current_generation, elapsed_ms
                ));
                return;
            }

            unsafe {
                // 用户或目标程序若已改写剪贴板，不再用旧内容覆盖它。
                let current_text = native_get_clipboard_text();
                if current_text.as_deref() != Some(injected_text.as_str()) {
                    crate::commands::system::write_log_line(&format!(
                        "[RUST] [inject] clipboard restore skipped pasteId={} reason=clipboard_changed currentUtf16Len={} elapsedMs={}",
                        paste_id,
                        current_text.as_deref().map(|value| value.encode_utf16().count()).unwrap_or(0),
                        elapsed_ms
                    ));
                    return;
                }

                let (restored, mode, format_count) = match &previous_snapshot {
                    Some(snapshot) if !snapshot.formats.is_empty() => {
                        (restore_clipboard_snapshot(snapshot, 3, 20), "all_formats", snapshot.formats.len())
                    }
                    Some(_) => (native_clear_clipboard(), "was_empty", 0),
                    None => match &previous_text {
                        Some(text) => (set_clipboard_with_retry(text, 3, 20), "text_only", 1),
                        None => (native_clear_clipboard(), "text_only_empty", 0),
                    },
                };
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [inject] clipboard restore finished pasteId={} restored={} mode={} formats={} previousUtf16Len={} elapsedMs={}",
                    paste_id,
                    restored,
                    mode,
                    format_count,
                    previous_text.as_deref().map(|value| value.encode_utf16().count()).unwrap_or(0),
                    elapsed_ms
                ));
            }
        });
    }
}

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
    OpenClipboard, CloseClipboard, EmptyClipboard, SetClipboardData, GetClipboardData,
    GetOpenClipboardWindow, GetClipboardSequenceNumber,
};
#[cfg(windows)]
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
#[cfg(windows)]
use windows::Win32::Foundation::HANDLE;

use crate::context;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{copy_to_clipboard, inject_text, inject_text_to_hwnd};

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
pub fn inject_text_to_hwnd(text: &str, target_hwnd_val: isize, focus_hwnd_val: isize, restore_clipboard: bool) -> InjectResult {
    let target = HWND(target_hwnd_val as *mut _);
    let focus = if focus_hwnd_val != 0 {
        HWND(focus_hwnd_val as *mut _)
    } else {
        target
    };

    unsafe { do_inject(target, focus, text, restore_clipboard) }
}

#[cfg(windows)]
pub fn inject_text(text: &str, restore_clipboard: bool) -> InjectResult {
    let ctx = context::capture_context("inject");

    if ctx.hwnd.is_empty() || ctx.hwnd == "0" {
        // 这个分支此前一行日志都不写，于是「插不进去」的排查里它是个盲区：用户看到
        // 兜底卡片，日志里却只有前端那条 reason=no_foreground_window，说不清是真的
        // 没有前台窗口，还是捕获本身失败了。
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] no foreground window hwnd={:?} focusHwnd={:?} process={:?}",
            ctx.hwnd, ctx.focus_hwnd, ctx.process_name
        ));
        return InjectResult {
            ok: false, strategy: None,
            reason: Some("no_foreground_window".to_string()), detail: None,
            uncertain: false,
        };
    }

    let gate = editability_gate(&ctx);
    if !gate.is_editable() {
        return InjectResult {
            ok: false,
            strategy: Some("overlay_fallback".to_string()),
            reason: Some("not_editable".to_string()),
            // gate 说明结论是哪一层判据给出的，后面四项是那四层各自的输入。缺了它们，
            // 日志只能说明"被拦了"，说不出是哪一层落空，排查得另跑一遍探测脚本
            // （2026-09 查微信 4.1 改名时吃过这个亏）。
            detail: Some(describe_editability(&ctx, gate)),
            uncertain: false,
        };
    }

    let target_hwnd = ctx.hwnd.parse::<isize>().unwrap_or(0);
    let focus_hwnd = ctx.focus_hwnd.parse::<isize>().unwrap_or(0);
    inject_text_to_hwnd(text, target_hwnd, focus_hwnd, restore_clipboard)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn inject_text_to_hwnd(_text: &str, _target: isize, _focus: isize, _restore_clipboard: bool) -> InjectResult {
    InjectResult { ok: false, strategy: None, reason: Some("not_windows".to_string()), detail: None, uncertain: false }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn inject_text(_text: &str, _restore_clipboard: bool) -> InjectResult {
    InjectResult { ok: false, strategy: None, reason: Some("not_windows".to_string()), detail: None, uncertain: false }
}

/// 「这里能不能打字」的结论，外加**是哪一层判据给出的**。
///
/// 为什么要带上「哪一层」而不只是 bool：判据一共四层（caret / 原生控件类名 / UIA /
/// 进程名白名单），任何一层都会因为第三方应用换 UI 框架、改进程名而失效，而失效的
/// 表现完全一样 —— 插字退化成兜底卡片，不报错。只有 bool 的话日志只能说明「被拦
/// 了」，说不出是哪一层落空，排查得另跑一遍 `dev-scripts/probe-foreground-target.ps1`
/// 才能定性（2026-09 微信 4.1 把 WeChat.exe 改名成 Weixin.exe 那次就是这么查的）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditableGate {
    /// explorer 的桌面图标列表：明确拒绝，优先级高于 caret
    ExplorerDesktopReject,
    /// 系统报告了文本光标，最可靠的信号
    Caret,
    /// 焦点或窗口类名命中原生可编辑控件（Edit / RichEdit / Scintilla / Word）
    NativeClass,
    /// UIA 报了 Edit / Document / ComboBox
    UiaEditableControl,
    /// UIA 报了 Custom/Group/Pane 且有 ValuePattern，即富文本编辑器
    UiaRichEditor,
    /// UIA 说这个可编辑控件是只读的
    UiaReadOnly,
    /// Chromium 窗口且能获得键盘焦点，乐观放行
    ChromiumOptimistic,
    /// 前面几层都没信号，靠进程名白名单放行
    ProcessAllowlist,
    /// 四层判据全部落空
    NoSignal,
    /// macOS：辅助功能没给出否定信号（拿不到焦点元素，或焦点不是按钮/菜单这类控件），乐观放行
    #[cfg(target_os = "macos")]
    AxOptimistic,
}

impl EditableGate {
    pub fn is_editable(self) -> bool {
        !matches!(
            self,
            Self::ExplorerDesktopReject | Self::UiaReadOnly | Self::NoSignal
        )
    }

    /// 写进日志和探测结果的稳定标识。改名等于改日志契约，排查脚本会对不上。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExplorerDesktopReject => "explorer_desktop_reject",
            Self::Caret => "caret",
            Self::NativeClass => "native_class",
            Self::UiaEditableControl => "uia_editable_control",
            Self::UiaRichEditor => "uia_rich_editor",
            Self::UiaReadOnly => "uia_read_only",
            Self::ChromiumOptimistic => "chromium_optimistic",
            Self::ProcessAllowlist => "process_allowlist",
            Self::NoSignal => "no_signal",
            #[cfg(target_os = "macos")]
            Self::AxOptimistic => "ax_optimistic",
        }
    }
}

/// `editability_gate` 的 bool 视图，只给测试用。
///
/// 加 `#[cfg(test)]` 是因为生产代码一处都不调它（真正的调用方要的是 gate 本身，
/// 好把"是哪一层放行的"写进日志），于是 release 构建每次都报一条 dead_code 警告。
/// 不删掉它是因为测试确实要断言"最终结论是可编辑"这一面 —— 见下面注释说的漂移风险。
#[cfg(test)]
pub fn is_likely_editable_pub(ctx: &context::AppContext) -> bool {
    windows_editability_gate(ctx).is_editable()
}

/// 判据只有这一份实现。别再复制一份出来只为了拿一个 bool 结论 —— 两份判据迟早漂移，
/// 而漂移的症状是「改了一处，另一条路径照旧」。需要 bool 就 `.is_editable()`。
pub fn editability_gate(ctx: &context::AppContext) -> EditableGate {
    #[cfg(target_os = "macos")]
    {
        macos::editability_gate(ctx)
    }
    #[cfg(not(target_os = "macos"))]
    {
        windows_editability_gate(ctx)
    }
}

/// Windows 的四层判据（caret / 原生控件类名 / UIA / 进程名白名单）。
/// 纯逻辑、不调系统 API，所以在 mac 上也编译，单测照样跑。
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn windows_editability_gate(ctx: &context::AppContext) -> EditableGate {
    let fc = ctx.focus_class.to_lowercase();
    let wc = ctx.window_class.to_lowercase();
    let proc = ctx.process_name.to_lowercase();

    // Windows 桌面也属于 explorer.exe，但 Progman / WorkerW 下的图标列表不是文本
    // 输入目标。必须在 caret/进程兜底之前明确拒绝，否则 SendInput 只会报告“按键已
    // 入队”，前端会误以为粘贴成功而不展示兜底卡片。
    let explorer_desktop_classes = ["progman", "workerw", "shelldll_defview", "syslistview32"];
    if proc.contains("explorer")
        && explorer_desktop_classes
            .iter()
            .any(|class_name| fc == *class_name || wc == *class_name)
    {
        return EditableGate::ExplorerDesktopReject;
    }

    if ctx.has_caret { return EditableGate::Caret; }

    // Native Win32 editable controls — always considered editable
    let native_editable_classes = [
        "edit", "richedit", "richedit20w", "richedit50w",
        "scintilla", "texteditorsid",
        // Office Word editor control (used by Outlook, Word, etc.)
        "_wwg",
    ];
    for cls in &native_editable_classes {
        if fc.contains(cls) || wc.contains(cls) { return EditableGate::NativeClass; }
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
                    return EditableGate::UiaReadOnly;
                }
                return if is_editable_control {
                    EditableGate::UiaEditableControl
                } else {
                    EditableGate::UiaRichEditor
                };
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
                return EditableGate::ChromiumOptimistic;
            }
        }

        // For non-Chromium windows with UIA data: if it's not an editable type,
        // fall through to process-based heuristic (don't hard-reject).
    }

    let editable_procs = [
        "notepad", "winword", "excel", "powerpnt", "outlook",
        "code", "devenv", "idea64",
        // VS Code 派生的 AI IDE：焦点常报为 Pane 且无 ValuePattern，
        // 与 code/devenv 同类，文本区可编辑，按进程名兜底放行
        "trae", "cursor", "windsurf", "kiro",
        "chrome", "msedge", "firefox", "opera", "brave",
        // 微信自 4.x 起整个界面用 Qt 重写（窗口类 Qt51514QWindowIcon，输入框自绘）：
        // 没有 Win32 caret、没有子控件 HWND（focusClass 就等于窗口类）、UIA 只能看到
        // 顶层 Window 且无 ValuePattern —— 上面三层判据对它全部为空，进程名是唯一
        // 的放行依据。而 4.1 又把 exe 从 WeChat.exe 改名成 Weixin.exe（装到
        // Tencent\Weixin\），只写 "wechat" 的话用户升级后就静默退化成兜底卡片
        // （2026-09-20 实测 4.1.13.65）。两个名字都要留：3.9 老版本和微信开发者
        // 工具（wechatdevtools.exe）仍然叫 wechat。
        "teams", "wechat", "weixin", "dingtalk", "slack",
        "windowsterminal", "cmd", "powershell",
        "mobaxterm", "putty", "securecrt", "xshell",
    ];
    for p in &editable_procs {
        if proc.contains(p) { return EditableGate::ProcessAllowlist; }
    }
    EditableGate::NoSignal
}

/// 把结论和四层判据各自的输入拼成一行，日志与探测结果共用同一份格式。
///
/// 刻意不含窗口标题和 exe 全路径：这行会进 sayit.log，而日志整份跟着诊断包发给
/// 开发者。类名、控件类型、进程名足够定位「为什么判成不可输入」，标题里的聊天
/// 对象名和路径里的 Windows 用户名对排查没有任何作用。
pub fn describe_editability(ctx: &context::AppContext, gate: EditableGate) -> String {
    format!(
        "gate={} editable={} class={} focusClass={} hasCaret={} controlType={} valuePattern={} kbFocusable={} enabled={} readOnly={} process={}",
        gate.as_str(),
        gate.is_editable(),
        ctx.window_class,
        ctx.focus_class,
        ctx.has_caret,
        if ctx.control_type.is_empty() { "-" } else { ctx.control_type.as_str() },
        ctx.is_value_pattern_available,
        ctx.is_keyboard_focusable,
        ctx.is_enabled,
        ctx.is_read_only.map_or("-", |v| if v { "true" } else { "false" }),
        ctx.process_name
    )
}

// ─── Core injection logic ───

/// WM_PASTE = 0x0302
#[cfg(windows)]
const WM_PASTE: u32 = 0x0302;

/// WM_COMMAND = 0x0111
#[cfg(windows)]
const WM_COMMAND: u32 = 0x0111;

/// conhost 系统菜单「粘贴」命令 ID（内置于 conhost）。
/// 参考：0xFFF0=复制 0xFFF1=粘贴 0xFFF2=滚动 0xFFF3=标记 0xFFF5=全选
#[cfg(windows)]
const ID_CONSOLE_PASTE: usize = 0xFFF1;

/// Main injection: try WM_PASTE first, then SendInput Ctrl+V as fallback.
///
/// `restore_clipboard`: 若为 true，在写入文本前先保存剪贴板原有文本内容，
/// 待粘贴指令发出、目标程序有机会读取剪贴板之后（延迟一小段时间，在独立线程里），
/// 再把剪贴板还原为原内容，避免用户之前复制的东西被覆盖丢失。
#[cfg(windows)]
unsafe fn do_inject(target: HWND, focus: HWND, text: &str, restore_clipboard: bool) -> InjectResult {
    let paste_id = PASTE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;

    // 保存原剪贴板内容（在写入新文本之前）。剪贴板本来为空/非文本时为 None，
    // 还原时会清空剪贴板而不是留着我们刚插入的文本。
    let previous_clipboard_text = if restore_clipboard {
        native_get_clipboard_text()
    } else {
        None
    };
    let previous_clipboard_snapshot = if restore_clipboard {
        snapshot_clipboard(paste_id)
    } else {
        None
    };

    // Step 1: Write text to clipboard
    let clipboard_ok = set_clipboard_with_retry(text, 5, 30);
    if !clipboard_ok {
        // 连 5 次都写不进剪贴板，基本就是被安全软件的剪贴板保护挡着。
        // 把命中的软件名写进日志和 detail，用户才知道该去哪儿加信任。
        let guards = detect_input_guard_software();
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] clipboard write failed pasteId={} utf8Len={} utf16Len={} inputGuards={} {}",
            paste_id,
            text.len(),
            text.encode_utf16().count(),
            guards,
            describe_clipboard_holder()
        ));
        return InjectResult {
            ok: false,
            strategy: Some("clipboard".to_string()),
            reason: Some("clipboard_blocked".to_string()),
            detail: Some(format!(
                "pasteId={} failed to write to the clipboard after 5 attempts inputGuards={}",
                paste_id, guards
            )),
            uncertain: false,
        };
    }

    let clipboard_matches = native_get_clipboard_text().as_deref() == Some(text);
    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] clipboard write ok pasteId={} utf8Len={} utf16Len={} clipboardMatches={} restoreRequested={}",
        paste_id,
        text.len(),
        text.encode_utf16().count(),
        clipboard_matches,
        restore_clipboard
    ));

    // 守卫在函数返回时才启动恢复计时，确保恢复延迟从实际粘贴触发之后开始。
    // generation 与剪贴板内容复核可阻止旧线程覆盖后续粘贴或用户新复制的内容。
    let _clipboard_restore_guard = ClipboardRestoreGuard::new(
        restore_clipboard,
        previous_clipboard_text,
        previous_clipboard_snapshot,
        text,
        paste_id,
    );

    // Step 1.5: 经典控制台窗口（conhost，类名 ConsoleWindowClass）——用控制台
    // 宿主自带的「粘贴」命令，而不是模拟 Ctrl+V 按键。
    //
    // 原因：当控制台里运行 TUI 程序（如 Claude Code）时，控制台被切到 raw 模式，
    // 合成的 Ctrl+V 按键会被该程序当作普通按键吃掉，不会触发粘贴，导致剪贴板内容
    // 根本没插入（但 SendInput 仍返回“成功”，形成假成功）。
    // WM_COMMAND + ID_CONSOLE_PASTE 由 conhost 自身处理，不经过子程序的按键流，
    // 且会遵循控制台当前输入模式（含 bracketed paste），因此 raw 模式下依然有效。
    let target_class = crate::context::read_class_name(target).to_lowercase();
    if target_class.contains("consolewindowclass") {
        crate::commands::system::write_log_line(
            &format!("[RUST] [inject] console paste attempt hwnd={} class={} textLen={}",
                target.0 as isize, target_class, text.len())
        );

        // 先把控制台置前台，确保粘贴落在正确的窗口上
        let fg_ok = force_foreground(target);

        let mut result_val: usize = 0;
        let send_ok = SendMessageTimeoutW(
            target,
            WM_COMMAND,
            windows::Win32::Foundation::WPARAM(ID_CONSOLE_PASTE),
            windows::Win32::Foundation::LPARAM(0),
            SMTO_ABORTIFHUNG,
            2000, // 2 second timeout
            Some(&mut result_val),
        );

        if send_ok.0 != 0 {
            crate::commands::system::write_log_line(
                &format!("[RUST] [inject] console paste ok hwnd={} fgOk={}", target.0 as isize, fg_ok)
            );
            return InjectResult {
                ok: true,
                strategy: Some("console_paste".to_string()),
                reason: None,
                detail: Some(format!(
                    "hwnd={} class={} textLen={} fgOk={}",
                    target.0 as isize, target_class, text.len(), fg_ok
                )),
                uncertain: false,
            };
        }
        crate::commands::system::write_log_line(
            "[RUST] [inject] console paste failed, fallback to SendInput"
        );
    }

    // Step 2: Try WM_PASTE — this is a message sent directly to the target
    // window handle, so it works even if the target is not the foreground
    // window. Most native Win32 controls (Edit, RichEdit) handle it.
    let probed_paste_target = if focus.0 != std::ptr::null_mut() { focus } else { target };
    // 焦点是录音开始时抓的。若那个控件此刻已经不可见（比如 Everything 原地重命名用的
    // 临时 Edit），WM_PASTE 照样返回成功、文本却进了看不见的地方，长度核实也会误判为
    // 成功 —— 所以先换到目标线程此刻真正的焦点上，前提是它仍在同一个顶层窗口里。
    let paste_target = rebind_invisible_focus(target, probed_paste_target);
    let focus_class = crate::context::read_class_name(paste_target).to_lowercase();

    // WM_PASTE works reliably for native Win32 edit controls
    let try_wm_paste = focus_class.contains("edit")
        || focus_class.contains("richedit")
        || focus_class.contains("scintilla");

    if try_wm_paste {
        if let Some(result) = wm_paste_verified(target, paste_target, &focus_class, text, paste_id) {
            return result;
        }
        crate::commands::system::write_log_line("[RUST] [inject] WM_PASTE failed, fallback to SendInput");
    }

    // Step 3: Fallback — force foreground + SendInput Ctrl+V
    let fg_ok = force_foreground(target);
    crate::commands::system::write_log_line(
        &format!("[RUST] [inject] SendInput fallback target={} fg_ok={} class={} textLen={} {}",
            target.0 as isize, fg_ok, focus_class, text.len(), describe_elevation(target))
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
    // 立刻抓 GetLastError（后面的 sleep/release_modifiers 会把它冲掉）。
    // sent=0 且 err=5(ERROR_ACCESS_DENIED) => UIPI 拦截：目标窗口权限比 SayIt 高
    // （目标以管理员运行而 SayIt 没有），解决办法是让 SayIt 以管理员身份运行。
    let last_err = windows::Win32::Foundation::GetLastError().0;

    std::thread::sleep(std::time::Duration::from_millis(10));
    release_modifiers();

    let detail = format!(
        "sent={} err={} class={} target={} focus={} textLen={} fgOk={}",
        sent, last_err, focus_class, target.0 as isize, focus.0 as isize, text.len(), fg_ok
    );

    // SendInput Ctrl+V is fire-and-forget. For Chromium-class windows we
    // used to mark ALL results as uncertain, but that was too aggressive —
    // it blocked every browser input field. Now we only mark as uncertain
    // when UIA says the focused element is NOT an editable control.
    let uncertain = false; // UIA-based editability is checked upstream in probe

    if sent >= 4 {
        return InjectResult {
            ok: true,
            strategy: Some("send_input".to_string()),
            reason: None,
            detail: Some(detail),
            uncertain,
        };
    }

    // ── SendInput 没被完整接受：模拟按键被挡在了 OS 层 ──
    //
    // err=5(ERROR_ACCESS_DENIED) 有两个常见来源，对用户来说解法不同：
    //   ① UIPI：目标程序以管理员运行、SayIt 没有 → SayIt 也要以管理员运行
    //   ② 安全软件的「防键盘模拟」拦截 → 要在那边给 SayIt 加信任
    // 两者都只能靠日志区分，所以把进程扫描结果一起记下来。
    const ERROR_ACCESS_DENIED: u32 = 5;
    let guards = detect_input_guard_software();
    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] SendInput blocked {} inputGuards={}",
        detail, guards
    ));

    // 最后一搏：改用 WM_PASTE。它是发给窗口的消息，不经过模拟输入那条通道，
    // 因此「按键被拦但消息能过」的情况下还能救回来。
    // 只在 SendInput 已经失败时做 —— 那时什么都没粘上，误伤的风险远小于彻底失败。
    if !try_wm_paste {
        let mut result_val: usize = 0;
        let send_ok = SendMessageTimeoutW(
            paste_target,
            WM_PASTE,
            windows::Win32::Foundation::WPARAM(0),
            windows::Win32::Foundation::LPARAM(0),
            SMTO_ABORTIFHUNG,
            2000,
            Some(&mut result_val),
        );
        if send_ok.0 != 0 {
            crate::commands::system::write_log_line(&format!(
                "[RUST] [inject] WM_PASTE last-resort ok hwnd={} class={}",
                paste_target.0 as isize, focus_class
            ));
            return InjectResult {
                ok: true,
                strategy: Some("wm_paste_last_resort".to_string()),
                reason: None,
                detail: Some(format!("{} inputGuards={}", detail, guards)),
                uncertain: false,
            };
        }
        crate::commands::system::write_log_line(
            "[RUST] [inject] WM_PASTE last-resort also failed",
        );
    }

    let blocked_by_privilege = sent == 0 && last_err == ERROR_ACCESS_DENIED;
    InjectResult {
        ok: false,
        strategy: Some("send_input".to_string()),
        reason: Some(
            if blocked_by_privilege {
                "input_blocked_access_denied"
            } else {
                "send_input_short_write"
            }
            .to_string(),
        ),
        detail: Some(format!("{} inputGuards={}", detail, guards)),
        uncertain: false,
    }
}

// ─── Verified WM_PASTE ───

#[cfg(windows)]
const WM_GETTEXTLENGTH: u32 = 0x000E;
#[cfg(windows)]
const EM_GETSEL: u32 = 0x00B0;
#[cfg(windows)]
const EM_REPLACESEL: u32 = 0x00C2;
#[cfg(windows)]
const GWL_STYLE: i32 = -16;
#[cfg(windows)]
const ES_MULTILINE: i32 = 0x0004;
#[cfg(windows)]
const ES_READONLY: i32 = 0x0800;

/// 核实用查询的超时。只取一个数字，正常目标 1ms 内就回；超时说明目标卡住，当作「核实不了」。
#[cfg(windows)]
const VERIFY_QUERY_TIMEOUT_MS: u32 = 150;
/// 每次 WM_PASTE 之后等长度变化的上限。WM_PASTE 是同步消息，标准 Edit 返回时文本已经
/// 进去了；多等这一会儿是防「目标自己异步处理粘贴」—— 没等够就重试，文本会插两遍。
#[cfg(windows)]
const VERIFY_WAIT_MS: u64 = 150;
/// 第 2、3 次 WM_PASTE 之前的等待，给正占着剪贴板的程序（剪贴板管理器等）让出时间。
#[cfg(windows)]
const WM_PASTE_RETRY_DELAYS_MS: [u64; 2] = [40, 120];

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;

    #[link(name = "user32")]
    extern "system" {
        pub fn IsWindowVisible(hwnd: HWND) -> i32;
        pub fn IsWindowEnabled(hwnd: HWND) -> i32;
        pub fn GetWindowLongW(hwnd: HWND, index: i32) -> i32;
        pub fn GetDlgCtrlID(hwnd: HWND) -> i32;
        pub fn GetParent(hwnd: HWND) -> HWND;
        pub fn IsChild(parent: HWND, child: HWND) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
        pub fn GetCurrentProcess() -> *mut c_void;
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        pub fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            info: *mut c_void,
            len: u32,
            ret_len: *mut u32,
        ) -> i32;
    }
}

/// 发 WM_PASTE 并核实文本确实进了输入框。
///
/// 为什么要核实：WM_PASTE 返回成功只说明消息被收下了。Edit 控件处理它时自己去
/// OpenClipboard，那一刻剪贴板若被别的程序占着就**静默什么都不做**。2026-09 有用户在
/// Everything 里连续几次日志都是 `WM_PASTE ok`，窗口标题（= 搜索框内容）却一个字没变；
/// 不核实的话这类失败日志里看不出来，用户也看不到兜底卡片。
///
/// 核实只用 WM_GETTEXTLENGTH：它只回一个数字、不复制内容，Edit / Scintilla 内部存着这个数，
/// 10MB 的文档也是直接返回（WM_GETTEXT 才会复制全文，别换成它）。判据只能是「长度变没变」，
/// 不能是「涨了插入的字数」—— 单行框会截断换行、有选区时是替换、还有 EM_LIMITTEXT 上限。
///
/// 返回 None 表示 WM_PASTE 消息本身没送达，调用方照旧走 SendInput。
#[cfg(windows)]
unsafe fn wm_paste_verified(
    target: HWND,
    paste_target: HWND,
    focus_class: &str,
    text: &str,
    paste_id: u64,
) -> Option<InjectResult> {
    let utf16_len = text.encode_utf16().count();
    let len_before = query_text_len(paste_target);
    let sel_before = query_selection(paste_target);

    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] WM_PASTE attempt pasteId={} hwnd={} class={} textLen={} utf16Len={} lenBefore={} sel={} {} {} clipSeq={} {}",
        paste_id,
        paste_target.0 as isize,
        focus_class,
        text.len(),
        utf16_len,
        fmt_opt(len_before),
        fmt_sel(sel_before),
        describe_paste_target(target, paste_target),
        describe_elevation(target),
        GetClipboardSequenceNumber(),
        describe_clipboard_holder()
    ));

    let base_detail = format!(
        "hwnd={} class={} textLen={}",
        paste_target.0 as isize, focus_class, text.len()
    );
    let succeeded = |strategy: &str, verify: &str, attempts: usize| {
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] WM_PASTE ok hwnd={} class={} pasteId={} strategy={} verify={} attempts={}",
            paste_target.0 as isize, focus_class, paste_id, strategy, verify, attempts
        ));
        InjectResult {
            ok: true,
            strategy: Some(strategy.to_string()),
            reason: None,
            detail: Some(format!("{} verify={} attempts={}", base_detail, verify, attempts)),
            uncertain: false,
        }
    };

    // 读不到长度（目标不回这条查询）或者没有可插的字：没法核实，退回老行为 ——
    // 发一次、信任返回值。这里绝不重试，否则一旦其实粘上了就是两遍。
    let before = match len_before {
        Some(n) if utf16_len > 0 => n,
        _ => {
            if !send_wm_paste(paste_target, paste_id, 1) {
                return None;
            }
            return Some(succeeded("wm_paste", "unavailable", 1));
        }
    };

    let mut attempts = 0usize;
    for attempt in 0..=WM_PASTE_RETRY_DELAYS_MS.len() {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(WM_PASTE_RETRY_DELAYS_MS[attempt - 1]));
            // 上一次没粘上的这段时间里，剪贴板可能被别的程序改写；重试前确认粘的还是我们的文本
            if native_get_clipboard_text().as_deref() != Some(text) {
                let rewritten = set_clipboard_with_retry(text, 3, 20);
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [inject] clipboard changed before retry pasteId={} attempt={} rewritten={} clipSeq={} {}",
                    paste_id,
                    attempt + 1,
                    rewritten,
                    GetClipboardSequenceNumber(),
                    describe_clipboard_holder()
                ));
                if !rewritten {
                    break;
                }
            }
        }

        attempts += 1;
        let seq_before = GetClipboardSequenceNumber();
        if !send_wm_paste(paste_target, paste_id, attempts) {
            if attempt == 0 {
                return None;
            }
            break;
        }
        let (after, waited_ms) = wait_for_text_len_change(paste_target, before);
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] WM_PASTE verify pasteId={} attempt={} lenBefore={} lenAfter={} waitedMs={} clipSeqBefore={} clipSeqAfter={}",
            paste_id,
            attempts,
            before,
            fmt_opt(after),
            waited_ms,
            seq_before,
            GetClipboardSequenceNumber()
        ));

        match after {
            // 发出去之后反而读不到了：不知道进没进，不能重试
            None => return Some(succeeded("wm_paste", "unreadable", attempts)),
            Some(n) if n != before => return Some(succeeded("wm_paste", "changed", attempts)),
            Some(_) => {
                // 选中的字数恰好等于插入字数时，替换成功长度也不变 —— 分不清就不重试
                if selection_len_matches(sel_before, before, utf16_len) {
                    return Some(succeeded("wm_paste", "ambiguous_same_length", attempts));
                }
            }
        }
    }

    // WM_PASTE 反复无效，多半是剪贴板这条路本身被卡住了。纯 Edit 控件还能用 EM_REPLACESEL
    // 把文字直接写进选区，完全不经过剪贴板。只限类名正好是 "edit"：系统会替它跨进程
    // 转送字符串参数（与 WM_SETTEXT 同理）；RichEdit / Scintilla / 各种改名的子类不保证。
    if focus_class == "edit" {
        let multiline = ffi::GetWindowLongW(paste_target, GWL_STYLE) & ES_MULTILINE != 0;
        let normalized = normalize_for_edit(text, multiline);
        let wide: Vec<u16> = normalized.encode_utf16().chain(std::iter::once(0)).collect();
        let mut result_val: usize = 0;
        let send_ok = SendMessageTimeoutW(
            paste_target,
            EM_REPLACESEL,
            windows::Win32::Foundation::WPARAM(1), // 可撤销
            windows::Win32::Foundation::LPARAM(wide.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            2000,
            Some(&mut result_val),
        );
        let after = if send_ok.0 != 0 { query_text_len(paste_target) } else { None };
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] EM_REPLACESEL fallback pasteId={} sent={} multiline={} lenBefore={} lenAfter={}",
            paste_id,
            send_ok.0 != 0,
            multiline,
            before,
            fmt_opt(after)
        ));
        if matches!(after, Some(n) if n != before) {
            return Some(succeeded("em_replacesel", "changed", attempts));
        }
    }

    // 确认没插进去：如实报失败，让前端弹兜底卡片。以前这里会报成功，用户什么都看不到。
    let detail = format!(
        "{} verify=no_effect attempts={} lenBefore={} sel={} {}",
        base_detail,
        attempts,
        before,
        fmt_sel(sel_before),
        describe_paste_target(target, paste_target)
    );
    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] WM_PASTE no effect pasteId={} {} clipSeq={} {}",
        paste_id,
        detail,
        GetClipboardSequenceNumber(),
        describe_clipboard_holder()
    ));
    Some(InjectResult {
        ok: false,
        strategy: Some("wm_paste".to_string()),
        reason: Some("paste_no_effect".to_string()),
        detail: Some(detail),
        uncertain: false,
    })
}

#[cfg(windows)]
unsafe fn send_wm_paste(hwnd: HWND, paste_id: u64, attempt: usize) -> bool {
    let mut result_val: usize = 0;
    let send_ok = SendMessageTimeoutW(
        hwnd,
        WM_PASTE,
        windows::Win32::Foundation::WPARAM(0),
        windows::Win32::Foundation::LPARAM(0),
        SMTO_ABORTIFHUNG,
        2000,
        Some(&mut result_val),
    );
    if send_ok.0 == 0 {
        let err = windows::Win32::Foundation::GetLastError().0;
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] WM_PASTE send failed pasteId={} attempt={} err={}",
            paste_id, attempt, err
        ));
        return false;
    }
    true
}

/// 文本长度（UTF-16 单位）。只取长度不取内容；拿不到返回 None，调用方当作「核实不了」。
#[cfg(windows)]
unsafe fn query_text_len(hwnd: HWND) -> Option<usize> {
    let mut out: usize = 0;
    let ok = SendMessageTimeoutW(
        hwnd,
        WM_GETTEXTLENGTH,
        windows::Win32::Foundation::WPARAM(0),
        windows::Win32::Foundation::LPARAM(0),
        SMTO_ABORTIFHUNG,
        VERIFY_QUERY_TIMEOUT_MS,
        Some(&mut out),
    );
    if ok.0 == 0 { None } else { Some(out) }
}

/// 选区 (start, end)。用的是返回值那种形式：两端各只有 16 位，超过 65535 字会被截断；
/// 指针参数那种形式跨进程不一定被转送，不敢用。所以它只进日志、只在短文本里参与判断。
#[cfg(windows)]
unsafe fn query_selection(hwnd: HWND) -> Option<(usize, usize)> {
    let mut out: usize = 0;
    let ok = SendMessageTimeoutW(
        hwnd,
        EM_GETSEL,
        windows::Win32::Foundation::WPARAM(0),
        windows::Win32::Foundation::LPARAM(0),
        SMTO_ABORTIFHUNG,
        VERIFY_QUERY_TIMEOUT_MS,
        Some(&mut out),
    );
    if ok.0 == 0 { None } else { Some((out & 0xFFFF, (out >> 16) & 0xFFFF)) }
}

#[cfg(windows)]
unsafe fn wait_for_text_len_change(hwnd: HWND, before: usize) -> (Option<usize>, u64) {
    let started = Instant::now();
    loop {
        let now = query_text_len(hwnd);
        let waited_ms = started.elapsed().as_millis() as u64;
        match now {
            Some(n) if n == before && waited_ms < VERIFY_WAIT_MS => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            _ => return (now, waited_ms),
        }
    }
}

#[cfg(any(windows, test))]
/// 替换选区时长度不变的那种情况。选区位置只有 16 位，文本超过 0xFFFF 时位置不可信，一律不认。
fn selection_len_matches(sel: Option<(usize, usize)>, text_len: usize, inserted_len: usize) -> bool {
    match sel {
        Some((start, end)) if text_len < 0xFFFF && end > start => end - start == inserted_len,
        _ => false,
    }
}

#[cfg(any(windows, test))]
/// EM_REPLACESEL 不像粘贴那样替你处理换行：多行框要 CRLF，单行框遇到换行会显示成乱码，换成空格。
fn normalize_for_edit(text: &str, multiline: bool) -> String {
    let unified = text.replace("\r\n", "\n");
    if multiline {
        unified.replace('\n', "\r\n")
    } else {
        unified.replace('\n', " ")
    }
}

/// 录音开始时抓到的焦点若已不可见，换成目标线程此刻的焦点（限同一个顶层窗口内）。
#[cfg(windows)]
unsafe fn rebind_invisible_focus(target: HWND, probed: HWND) -> HWND {
    if probed == target || ffi::IsWindowVisible(probed) != 0 {
        return probed;
    }
    let current = current_focus_of(target);
    let usable = current.filter(|cur| {
        *cur != probed
            && ffi::IsWindowVisible(*cur) != 0
            && (*cur == target || ffi::IsChild(target, *cur) != 0)
    });
    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] probed focus invisible hwnd={} class={} currentFocus={} rebound={}",
        probed.0 as isize,
        crate::context::read_class_name(probed),
        current.map_or(0, |h| h.0 as isize),
        usable.is_some()
    ));
    usable.unwrap_or(probed)
}

#[cfg(windows)]
unsafe fn current_focus_of(target: HWND) -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};
    let tid = GetWindowThreadProcessId(target, None);
    if tid == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if GetGUIThreadInfo(tid, &mut info).is_err() || info.hwndFocus.0.is_null() {
        return None;
    }
    Some(info.hwndFocus)
}

/// 粘贴目标控件此刻的状态。用来区分「粘进了看不见的控件」「焦点在录音期间换了」
/// 「控件只读 / 被禁用」这几种同样表现为"日志成功、框里没字"的情况。
#[cfg(windows)]
unsafe fn describe_paste_target(target: HWND, paste_target: HWND) -> String {
    let style = ffi::GetWindowLongW(paste_target, GWL_STYLE);
    let parent = ffi::GetParent(paste_target);
    let fg_now = GetForegroundWindow();
    let focus_now = current_focus_of(target);
    format!(
        "visible={} enabled={} readOnly={} multiline={} ctrlId={} parent={}/{} inTarget={} fgIsTarget={} focusNow={} focusUnchanged={}",
        ffi::IsWindowVisible(paste_target) != 0,
        ffi::IsWindowEnabled(paste_target) != 0,
        style & ES_READONLY != 0,
        style & ES_MULTILINE != 0,
        ffi::GetDlgCtrlID(paste_target),
        parent.0 as isize,
        if parent.0.is_null() { String::new() } else { crate::context::read_class_name(parent) },
        paste_target == target || ffi::IsChild(target, paste_target) != 0,
        fg_now == target,
        focus_now.map_or(0, |h| h.0 as isize),
        focus_now == Some(paste_target)
    )
}

/// SayIt 与目标进程是否以管理员运行。目标权限更高时往往连它的令牌都打不开，记成 "?"
/// —— 此时 "selfElevated=false targetElevated=?" 本身就强烈暗示目标是管理员进程。
#[cfg(windows)]
fn describe_elevation(target: HWND) -> String {
    use std::sync::OnceLock;
    static SELF_ELEVATED: OnceLock<Option<bool>> = OnceLock::new();
    let self_elevated = *SELF_ELEVATED.get_or_init(|| unsafe { token_elevated(ffi::GetCurrentProcess()) });

    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(target, Some(&mut pid)) };
    let target_elevated = if pid == 0 {
        None
    } else {
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        unsafe {
            let process = ffi::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                None
            } else {
                let elevated = token_elevated(process);
                ffi::CloseHandle(process);
                elevated
            }
        }
    };
    format!(
        "selfElevated={} targetElevated={}",
        fmt_bool_opt(self_elevated),
        fmt_bool_opt(target_elevated)
    )
}

#[cfg(windows)]
unsafe fn token_elevated(process: *mut std::ffi::c_void) -> Option<bool> {
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_ELEVATION_CLASS: u32 = 20;
    let mut token: *mut std::ffi::c_void = std::ptr::null_mut();
    if ffi::OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
        return None;
    }
    let mut elevation: u32 = 0;
    let mut ret_len: u32 = 0;
    let ok = ffi::GetTokenInformation(
        token,
        TOKEN_ELEVATION_CLASS,
        &mut elevation as *mut u32 as *mut std::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
        &mut ret_len,
    );
    ffi::CloseHandle(token);
    if ok == 0 { None } else { Some(elevation != 0) }
}

#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
fn fmt_opt(value: Option<usize>) -> String {
    value.map_or_else(|| "?".to_string(), |v| v.to_string())
}

#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
fn fmt_sel(sel: Option<(usize, usize)>) -> String {
    sel.map_or_else(|| "?".to_string(), |(start, end)| format!("{}-{}", start, end))
}

#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
fn fmt_bool_opt(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "true",
        Some(false) => "false",
        None => "?",
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

/// 指认「现在是谁占着剪贴板」。
///
/// 这是排查安全软件（360 安全卫士、火绒、QQ 电脑管家等）拦截剪贴板最直接的手段：
/// 它们的剪贴板保护会先把剪贴板打开，我们的 `OpenClipboard` 就拿不到、只能拿到一个
/// 含义模糊的 ERROR_ACCESS_DENIED。`GetOpenClipboardWindow` 能给出持有者窗口，
/// 顺着它拿到进程名，日志里就直接写着是哪个程序，不用再靠猜或者让用户逐个关软件。
#[cfg(windows)]
unsafe fn describe_clipboard_holder() -> String {
    // 拿不到持有者（Err 或空 HWND）却仍然打不开剪贴板：通常是驱动层/钩子拦截，
    // 而不是正常的「另一个程序刚好占着」的竞争
    let holder = match GetOpenClipboardWindow() {
        Ok(h) if !h.0.is_null() => h,
        _ => return "holder=<none>".to_string(),
    };
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(holder, Some(&mut pid));
    let name = crate::context::get_process_name(pid);
    format!(
        "holder_hwnd={} holder_pid={} holder_process={} holder_class={}",
        holder.0 as isize,
        pid,
        if name.is_empty() { "<unknown>" } else { &name },
        crate::context::read_class_name(holder)
    )
}

/// 已知会拦截模拟按键 / 剪贴板的安全软件进程名（小写）。
///
/// **只用于日志**：命中了不改任何行为，仅在插入失败时把它写进日志，让「文本插不进去」
/// 一眼能看出环境里有这类软件。绝不能拿它做拉黑或者绕过 —— 那既不可靠，也会让我们
/// 更像恶意程序（本来就已经有误报问题了）。
#[cfg(windows)]
const INPUT_GUARD_PROCESSES: &[&str] = &[
    // 360
    "360tray.exe", "360safe.exe", "zhudongfangyu.exe", "360sd.exe", "360rp.exe",
    // 火绒
    "hipstray.exe", "usysdiag.exe", "wsctrlsvc.exe",
    // 腾讯电脑管家
    "qqpctray.exe", "qqpcmgr.exe", "qqpcrtp.exe",
    // 金山毒霸
    "kxetray.exe", "kislive.exe", "kwsprotect64.exe",
    // 联想电脑管家 / 其他常见国产安全套件
    "lavasoft.exe", "baidusdtray.exe", "avp.exe",
];

/// 扫一遍进程，列出命中的安全软件。结果缓存 —— 这些软件不会在一次会话中途装上，
/// 而插入失败可能连续发生，没必要每次都枚举全部进程。
#[cfg(windows)]
fn detect_input_guard_software() -> &'static str {
    use std::sync::OnceLock;
    static DETECTED: OnceLock<String> = OnceLock::new();
    DETECTED.get_or_init(|| {
        use windows::Win32::System::ProcessStatus::K32EnumProcesses;
        let mut pids = vec![0u32; 1024];
        let mut needed: u32 = 0;
        let ok = unsafe {
            K32EnumProcesses(
                pids.as_mut_ptr(),
                (pids.len() * std::mem::size_of::<u32>()) as u32,
                &mut needed,
            )
        };
        if !ok.as_bool() {
            return String::from("<enum_failed>");
        }
        let count = needed as usize / std::mem::size_of::<u32>();
        let mut hits: Vec<String> = Vec::new();
        for &pid in pids.iter().take(count) {
            if pid == 0 {
                continue;
            }
            let name = crate::context::get_process_name(pid).to_lowercase();
            if name.is_empty() {
                continue;
            }
            if INPUT_GUARD_PROCESSES.contains(&name.as_str()) && !hits.contains(&name) {
                hits.push(name);
            }
        }
        if hits.is_empty() {
            String::from("<none>")
        } else {
            hits.join(",")
        }
    })
    .as_str()
}

#[cfg(windows)]
unsafe fn set_clipboard_with_retry(text: &str, max_retries: u32, retry_delay_ms: u64) -> bool {
    for attempt in 0..max_retries {
        match native_set_clipboard_text(text) {
            Ok(()) => return true,
            Err(why) => {
                // 每次都记：能区分「被占用一下、重试就成了」和「一直被拦」，
                // 这两种给用户的建议完全不同
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [inject] clipboard set attempt {}/{} failed {}",
                    attempt + 1,
                    max_retries,
                    why
                ));
            }
        }
        if attempt < max_retries - 1 {
            std::thread::sleep(std::time::Duration::from_millis(retry_delay_ms));
        }
    }
    false
}

/// 写剪贴板。失败时返回**具体卡在哪一步**，而不是一个笼统的 false ——
/// OpenClipboard 被拦、内存分配失败、SetClipboardData 被拒，三者成因完全不同。
#[cfg(windows)]
unsafe fn native_set_clipboard_text(text: &str) -> Result<(), String> {
    if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
        let err = windows::Win32::Foundation::GetLastError().0;
        return Err(format!(
            "step=OpenClipboard err={} {}",
            err,
            describe_clipboard_holder()
        ));
    }

    let result = (|| -> Result<(), String> {
        let _ = EmptyClipboard();
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let byte_len = wide.len() * 2;

        let hmem = match GlobalAlloc(GMEM_MOVEABLE, byte_len) {
            Ok(h) => h,
            Err(e) => return Err(format!("step=GlobalAlloc bytes={} err={}", byte_len, e)),
        };

        let locked = GlobalLock(hmem);
        if locked.is_null() {
            return Err("step=GlobalLock err=null".to_string());
        }

        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, locked as *mut u8, byte_len);
        let _ = GlobalUnlock(hmem);

        // CF_UNICODETEXT = 13
        if let Err(e) = SetClipboardData(13, HANDLE(hmem.0 as *mut _)) {
            let err = windows::Win32::Foundation::GetLastError().0;
            return Err(format!("step=SetClipboardData err={} detail={}", err, e));
        }

        // 标记本次剪贴板内容「不进入 Win+V 历史 / 不上传云剪贴板」。
        // 否则每次插入文本都会往剪贴板历史里塞一条（配合「保护剪贴板」还原时甚至塞两条）。
        // 与浏览器无痕模式、密码管理器用的是同一套机制。失败不影响粘贴，忽略即可。
        mark_clipboard_history_excluded();

        Ok(())
    })();

    let _ = CloseClipboard();
    result
}

/// 往当前剪贴板会话写入排除标记，阻止内容进入剪贴板历史(Win+V)与云剪贴板。
/// 必须在 OpenClipboard/EmptyClipboard 之后、CloseClipboard 之前调用。
#[cfg(windows)]
unsafe fn mark_clipboard_history_excluded() {
    use windows::core::PCWSTR;
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;

    // 写一个 4 字节值为 0 的 DWORD 到指定格式。
    let write_dword_format = |format_name: &[u16], value: u32| {
        let fmt = RegisterClipboardFormatW(PCWSTR(format_name.as_ptr()));
        if fmt == 0 { return; }
        let hmem = match GlobalAlloc(GMEM_MOVEABLE, 4) {
            Ok(h) => h,
            Err(_) => return,
        };
        let locked = GlobalLock(hmem);
        if locked.is_null() { return; }
        std::ptr::copy_nonoverlapping(&value as *const u32 as *const u8, locked as *mut u8, 4);
        let _ = GlobalUnlock(hmem);
        // 标记写失败几乎不会发生；与上面 CF_UNICODETEXT 的处理一致，失败时不额外释放。
        let _ = SetClipboardData(fmt, HANDLE(hmem.0 as *mut _));
    };

    // "CanIncludeInClipboardHistory" = 0 → 不进 Win+V 历史
    let hist: Vec<u16> = "CanIncludeInClipboardHistory\0".encode_utf16().collect();
    write_dword_format(&hist, 0);

    // "CanUploadToCloudClipboard" = 0 → 不同步到云剪贴板
    let cloud: Vec<u16> = "CanUploadToCloudClipboard\0".encode_utf16().collect();
    write_dword_format(&cloud, 0);

    // "ExcludeClipboardContentFromMonitorProcessing" → 兜底：整体排除监控处理
    // 该格式只要存在即生效，值内容不限，这里同样写 0。
    let exclude: Vec<u16> = "ExcludeClipboardContentFromMonitorProcessing\0".encode_utf16().collect();
    write_dword_format(&exclude, 0);

    // "Clipboard Viewer Ignore" → 给第三方剪贴板管理器看的，KeePass 2.x 用的也是它。
    // 上面三个是微软的约定，Ditto 的正式版（截至 3.25.113，2025-09）一个都不认，只认这个。
    // 它的源码 2025-12 才补上微软那两个，2026-01 又挂到一个可关的选项后面；而这个格式
    // 一直是无条件跳过（ClipboardViewer.cpp 的 GetIgnoreClipboardChange）。所以别以为
    // 有了上面三个就可以删掉它。只要存在就生效，值不限。KeePass 早年默认不开它，是因为
    // 配 .NET/OLE 剪贴板接口时会让 Office 剪贴板扩展崩溃；我们走原生 SetClipboardData，
    // 不是那条路。（issue #84）
    let viewer_ignore: Vec<u16> = "Clipboard Viewer Ignore\0".encode_utf16().collect();
    write_dword_format(&viewer_ignore, 0);
}

#[cfg(windows)]
pub unsafe fn set_clipboard_with_retry_pub(text: &str, max_retries: u32, retry_delay_ms: u64) -> bool {
    set_clipboard_with_retry(text, max_retries, retry_delay_ms)
}

/// 给剪贴板拍快照。超预算、打不开时返回 None（调用方退回只还原文字）；剪贴板为空时返回空快照。
#[cfg(windows)]
unsafe fn snapshot_clipboard(paste_id: u64) -> Option<ClipboardSnapshot> {
    use windows::Win32::System::DataExchange::EnumClipboardFormats;
    use windows::Win32::System::Memory::GlobalSize;

    let started = Instant::now();
    if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
        return None;
    }
    let result = (|| -> Result<ClipboardSnapshot, &'static str> {
        let mut snapshot = ClipboardSnapshot::default();
        let mut total = 0usize;
        let mut format = 0u32;
        loop {
            format = EnumClipboardFormats(format);
            if format == 0 {
                break;
            }
            if started.elapsed().as_millis() > CLIPBOARD_SNAPSHOT_BUDGET_MS {
                return Err("over_time_budget");
            }
            if !clipboard_format_is_copyable(format) {
                continue;
            }
            let Ok(handle) = GetClipboardData(format) else { continue };
            let hmem = windows::Win32::Foundation::HGLOBAL(handle.0);
            let size = GlobalSize(hmem);
            if size == 0 {
                continue;
            }
            total += size;
            if total > CLIPBOARD_SNAPSHOT_MAX_BYTES {
                return Err("over_size_budget");
            }
            let locked = GlobalLock(hmem);
            if locked.is_null() {
                continue;
            }
            let bytes = std::slice::from_raw_parts(locked as *const u8, size).to_vec();
            let _ = GlobalUnlock(hmem);
            snapshot.formats.push((format, bytes));
        }
        Ok(snapshot)
    })();
    let _ = CloseClipboard();
    match result {
        Ok(snapshot) => Some(snapshot),
        Err(reason) => {
            crate::commands::system::write_log_line(&format!(
                "[RUST] [inject] clipboard snapshot skipped pasteId={} reason={} elapsedMs={}; restoring text only",
                paste_id,
                reason,
                started.elapsed().as_millis()
            ));
            None
        }
    }
}

/// 把快照整份写回剪贴板。剪贴板被别的程序占着时按 retry 重试。
#[cfg(windows)]
unsafe fn restore_clipboard_snapshot(snapshot: &ClipboardSnapshot, max_retries: u32, retry_delay_ms: u64) -> bool {
    use windows::Win32::Foundation::GlobalFree;
    for attempt in 0..=max_retries {
        if OpenClipboard(HWND(std::ptr::null_mut())).is_ok() {
            let _ = EmptyClipboard();
            let mut written = 0usize;
            for (format, bytes) in &snapshot.formats {
                let Ok(hmem) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else { continue };
                let locked = GlobalLock(hmem);
                if locked.is_null() {
                    let _ = GlobalFree(hmem);
                    continue;
                }
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), locked as *mut u8, bytes.len());
                let _ = GlobalUnlock(hmem);
                if SetClipboardData(*format, HANDLE(hmem.0 as *mut _)).is_ok() {
                    written += 1;
                } else {
                    let _ = GlobalFree(hmem);
                }
            }
            // 还原的是用户自己复制的内容，它进剪贴板历史那一次已经记过了，别再记一条。
            mark_clipboard_history_excluded();
            let _ = CloseClipboard();
            return written > 0;
        }
        if attempt < max_retries {
            std::thread::sleep(std::time::Duration::from_millis(retry_delay_ms));
        }
    }
    false
}

/// 清空剪贴板（还原场景：插入前剪贴板本来就没有文本内容）。
#[cfg(windows)]
unsafe fn native_clear_clipboard() -> bool {
    if OpenClipboard(HWND(std::ptr::null_mut())).is_err() { return false; }
    let ok = EmptyClipboard().is_ok();
    let _ = CloseClipboard();
    ok
}

/// 读取剪贴板当前的 Unicode 文本内容（CF_UNICODETEXT=13）。
/// 用于「插入前保存、插入后还原」——避免用户之前复制的内容被覆盖丢失。
/// 剪贴板为空、或内容不是文本（图片/文件等）时返回 None，不做处理即等价于「插入前剪贴板本来就没有可还原的文本」。
#[cfg(windows)]
unsafe fn native_get_clipboard_text() -> Option<String> {
    if OpenClipboard(HWND(std::ptr::null_mut())).is_err() { return None; }

    let result = (|| -> Option<String> {
        let handle = GetClipboardData(13).ok()?; // CF_UNICODETEXT
        let hmem = windows::Win32::Foundation::HGLOBAL(handle.0);
        let locked = GlobalLock(hmem);
        if locked.is_null() { return None; }

        // Unicode 文本以 NUL 结尾，逐 u16 扫描找长度（内存块可能比字符串长）
        let mut len = 0usize;
        let ptr = locked as *const u16;
        loop {
            if *ptr.add(len) == 0 { break; }
            len += 1;
            if len > 10_000_000 { break; } // 防御性上限，避免异常内存导致死循环
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        let text = String::from_utf16_lossy(slice);
        let _ = GlobalUnlock(hmem);
        Some(text)
    })();

    let _ = CloseClipboard();
    result
}

#[cfg(all(test, windows))]
mod clipboard_format_tests {
    use super::clipboard_format_is_copyable;

    #[test]
    fn byte_copyable_formats_are_kept_and_gdi_handles_skipped() {
        // 文字、DIB 图片、文件列表、注册格式（HTML / PNG 之类）都保留
        for keep in [1u32, 7, 8, 13, 15, 16, 17, 0xC000, 0xC1A3] {
            assert!(clipboard_format_is_copyable(keep), "{keep:#x}");
        }
        for skip in [2u32, 3, 9, 14, 0x80, 0x82, 0x8E, 0x200, 0x2FF, 0x300, 0x3FF] {
            assert!(!clipboard_format_is_copyable(skip), "{skip:#x}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        describe_editability, is_likely_editable_pub, normalize_for_edit, selection_len_matches,
        windows_editability_gate as editability_gate, EditableGate,
    };
    use crate::context::AppContext;

    /// 这条判据决定「长度没变」时要不要重试。认错成「替换成功」只是少救一次；
    /// 认错成「没粘上」会重试，文本就插两遍 —— 所以边界都往「分不清、不重试」那边收。
    #[test]
    fn same_length_replacement_is_treated_as_ambiguous() {
        // 选中 3 个字、插入 3 个字：替换成功长度也不变
        assert!(selection_len_matches(Some((2, 5)), 100, 3));
        // 没有选区时长度不变就是真没粘上
        assert!(!selection_len_matches(Some((5, 5)), 100, 3));
        assert!(!selection_len_matches(Some((2, 4)), 100, 3));
        assert!(!selection_len_matches(None, 100, 3));
    }

    #[test]
    fn selection_positions_are_distrusted_beyond_16_bits() {
        // EM_GETSEL 返回值两端各只有 16 位，长文本里位置被截断，不能据此下结论
        assert!(!selection_len_matches(Some((2, 5)), 0x1_0000, 3));
    }

    #[test]
    fn edit_newlines_are_normalized_per_style() {
        assert_eq!(normalize_for_edit("a\nb\r\nc", true), "a\r\nb\r\nc");
        assert_eq!(normalize_for_edit("a\nb\r\nc", false), "a b c");
    }

    /// 微信 4.1.13.65 的真实取值，来自 dev-scripts/probe-foreground-target.ps1：
    /// Qt 自绘窗口，caret / 原生类名 / UIA 三层判据全部为空，只有进程名能放行它。
    fn weixin_4x_ctx(process_name: &str) -> AppContext {
        AppContext {
            process_name: process_name.to_string(),
            window_class: "Qt51514QWindowIcon".to_string(),
            // Qt 整个窗口只有一个 HWND，GetFocus 返回的就是顶层窗口本身
            focus_class: "Qt51514QWindowIcon".to_string(),
            has_caret: false,
            // UIA 只能看到顶层窗口，看不到自绘的输入框
            control_type: "Window".to_string(),
            is_value_pattern_available: false,
            is_keyboard_focusable: false,
            is_enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn weixin_4x_is_editable_via_process_allowlist() {
        // 4.1 起 exe 叫 Weixin.exe。这条 2026-09-20 之前是 false，表现为用户升级微信后
        // 插不进文本、只能从兜底卡片手动复制。
        //
        // 断言的是 gate 而不只是"能插"：前三层判据对 Qt 自绘窗口全都是空的，唯一放行
        // 它的是进程名白名单。只断言 bool 的话，将来若有人给 Qt 类名开了个后门，结论
        // 照样是 true，测试照样全绿，而真正在起作用的机制已经换了。
        let ctx = weixin_4x_ctx("Weixin.exe");
        assert_eq!(editability_gate(&ctx), EditableGate::ProcessAllowlist);
        assert!(is_likely_editable_pub(&ctx));
    }

    #[test]
    fn wechat_3x_name_still_editable() {
        // 老版本与微信开发者工具仍然叫 WeChat.exe，改名后不能把它们丢掉
        assert_eq!(
            editability_gate(&weixin_4x_ctx("WeChat.exe")),
            EditableGate::ProcessAllowlist
        );
        assert_eq!(
            editability_gate(&weixin_4x_ctx("wechatdevtools.exe")),
            EditableGate::ProcessAllowlist
        );
    }

    /// 明确否掉的方案：不能因为"Qt 窗口拿不到 UIA 信息"就把所有 Qt 应用当成可编辑。
    /// 判错的代价不对称 —— 漏判只是让用户从兜底卡片手动粘一次，误判会让前端报
    /// 插入成功而目标一个字都没收到（SendInput 成功不等于插进去了，见 pitfalls #28）。
    #[test]
    fn unknown_qt_app_falls_through_all_gates() {
        let ctx = weixin_4x_ctx("qbittorrent.exe");
        // 与上面那条微信用例唯一的差别就是进程名，所以这一对测试合起来证明：
        // 放行微信的确实是进程名那一层，不是别的判据顺手放过去的。
        assert_eq!(editability_gate(&ctx), EditableGate::NoSignal);
        assert!(!is_likely_editable_pub(&ctx));
    }

    /// 桌面图标重命名时 explorer 确实有 caret，但那里不是文本注入目标；
    /// 这条钉住 caret 之前的那道明确拒绝没有被后来的放宽绕过。
    #[test]
    fn explorer_desktop_is_rejected_before_caret() {
        let ctx = AppContext {
            process_name: "explorer.exe".to_string(),
            window_class: "Progman".to_string(),
            focus_class: "SysListView32".to_string(),
            has_caret: true,
            is_enabled: true,
            ..Default::default()
        };
        // has_caret=true 却仍然拒绝，说明那道明确拒绝排在 caret 之前 —— 这正是它存在
        // 的理由，改动判据顺序会让它失效。
        assert_eq!(editability_gate(&ctx), EditableGate::ExplorerDesktopReject);
        assert!(!is_likely_editable_pub(&ctx));
    }

    /// 这行诊断串会进 sayit.log，而日志整份跟着诊断包发给开发者。窗口标题里可能是
    /// 聊天对象名或文档名，exe 路径里带 Windows 用户名，两者对排查毫无作用。
    #[test]
    fn describe_editability_never_leaks_title_or_path() {
        let mut ctx = weixin_4x_ctx("Weixin.exe");
        ctx.window_title = "文件传输助手 - 季度奖金方案".to_string();
        ctx.exe_path = r"C:\Users\zhangsan\AppData\Local\Programs\Weixin.exe".to_string();

        let line = describe_editability(&ctx, editability_gate(&ctx));

        assert!(!line.contains("季度奖金"), "window title leaked: {line}");
        assert!(!line.contains("zhangsan"), "exe path leaked: {line}");
        // 同时确认该有的还在，别把这条测试变成"什么都不记也能过"
        assert!(line.contains("gate=process_allowlist"), "{line}");
        assert!(line.contains("process=Weixin.exe"), "{line}");
        assert!(line.contains("focusClass=Qt51514QWindowIcon"), "{line}");
    }
}
