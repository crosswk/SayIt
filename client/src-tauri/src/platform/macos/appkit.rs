//! AppKit / Foundation（objc2）：前台应用、剪贴板、窗口层级。
//!
//! 线程：NSWindow 的方法必须在主线程调用（调用方负责 `run_on_main_thread`）；
//! NSWorkspace / NSPasteboard 在后台线程也能用，但都包在 autoreleasepool 里，
//! 避免后台线程上自动释放的对象没人回收。

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSArray, NSData, NSRect, NSString};
use std::ffi::{c_char, c_void, CStr};
use std::time::{Duration, Instant};

/// NSString → Rust String。
///
/// # Safety
/// `obj` 必须是 NSString 或空指针。
unsafe fn nsstring_to_string(obj: *mut AnyObject) -> Option<String> {
    if obj.is_null() {
        return None;
    }
    let utf8: *const c_char = msg_send![obj, UTF8String];
    if utf8.is_null() {
        return None;
    }
    Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
}

/// NSURL → 文件路径。
unsafe fn nsurl_path(url: *mut AnyObject) -> Option<String> {
    if url.is_null() {
        return None;
    }
    nsstring_to_string(msg_send![url, path])
}

// ─── 前台应用 ───

#[derive(Debug, Clone, Default)]
pub struct RunningApp {
    pub pid: i32,
    pub bundle_id: String,
    pub name: String,
    /// 可执行文件路径（`…/Contents/MacOS/xxx`）
    pub executable_path: String,
    /// `.app` 包路径
    pub bundle_path: String,
}

impl RunningApp {
    /// 可执行文件名（对应 Windows 的进程名，例如 `WeChat`、`Electron`）。
    pub fn executable_name(&self) -> String {
        std::path::Path::new(&self.executable_path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

unsafe fn running_app_info(app: *mut AnyObject) -> Option<RunningApp> {
    if app.is_null() {
        return None;
    }
    let pid: i32 = msg_send![app, processIdentifier];
    Some(RunningApp {
        pid,
        bundle_id: nsstring_to_string(msg_send![app, bundleIdentifier]).unwrap_or_default(),
        name: nsstring_to_string(msg_send![app, localizedName]).unwrap_or_default(),
        executable_path: nsurl_path(msg_send![app, executableURL]).unwrap_or_default(),
        bundle_path: nsurl_path(msg_send![app, bundleURL]).unwrap_or_default(),
    })
}

/// 当前前台应用（菜单栏属于它的那个）。
pub fn frontmost_app() -> Option<RunningApp> {
    autoreleasepool(|_| unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if ws.is_null() {
            return None;
        }
        let app: *mut AnyObject = msg_send![ws, frontmostApplication];
        running_app_info(app)
    })
}

/// 按 pid 取应用信息。
pub fn running_app_for_pid(pid: i32) -> Option<RunningApp> {
    if pid <= 0 {
        return None;
    }
    autoreleasepool(|_| unsafe {
        let app: *mut AnyObject =
            msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        running_app_info(app)
    })
}

// ─── 剪贴板（NSPasteboard）───

/// 纯文本类型（`NSPasteboardTypeString` 的值）。
pub const PASTEBOARD_TYPE_STRING: &str = "public.utf8-plain-text";
/// nspasteboard.org 约定：这份内容很快会被还原或替换，剪贴板管理器不要记进历史。
/// Maccy、Paste、Raycast、Alfred 等都认它（对应 Windows 侧的 ExcludeClipboardContentFromMonitorProcessing 等格式）。
pub const PASTEBOARD_TYPE_TRANSIENT: &str = "org.nspasteboard.TransientType";

unsafe fn general_pasteboard() -> *mut AnyObject {
    msg_send![class!(NSPasteboard), generalPasteboard]
}

/// 剪贴板的修改计数。每次有人写剪贴板它都会变（对应 GetClipboardSequenceNumber）。
pub fn pasteboard_change_count() -> isize {
    autoreleasepool(|_| unsafe {
        let pb = general_pasteboard();
        if pb.is_null() {
            return -1;
        }
        msg_send![pb, changeCount]
    })
}

pub fn pasteboard_get_text() -> Option<String> {
    autoreleasepool(|_| unsafe {
        let pb = general_pasteboard();
        if pb.is_null() {
            return None;
        }
        let ty = NSString::from_str(PASTEBOARD_TYPE_STRING);
        let value: *mut AnyObject = msg_send![pb, stringForType: &*ty];
        nsstring_to_string(value)
    })
}

/// 写入纯文本。`transient` 为真时附带 TransientType 标记，不进剪贴板管理器历史。
/// 返回写入后的 changeCount。
pub fn pasteboard_set_text(text: &str, transient: bool) -> Result<isize, String> {
    autoreleasepool(|_| unsafe {
        let pb = general_pasteboard();
        if pb.is_null() {
            return Err("step=generalPasteboard err=null".to_string());
        }
        let string_type = NSString::from_str(PASTEBOARD_TYPE_STRING);
        let transient_type = NSString::from_str(PASTEBOARD_TYPE_TRANSIENT);
        let types = if transient {
            NSArray::from_retained_slice(&[string_type.clone(), transient_type.clone()])
        } else {
            NSArray::from_retained_slice(&[string_type.clone()])
        };
        let _: isize = msg_send![pb, declareTypes: &*types, owner: std::ptr::null_mut::<AnyObject>()];
        let value = NSString::from_str(text);
        let ok: bool = msg_send![pb, setString: &*value, forType: &*string_type];
        if !ok {
            return Err("step=setString err=rejected".to_string());
        }
        if transient {
            let empty = NSData::with_bytes(&[]);
            let _: bool = msg_send![pb, setData: &*empty, forType: &*transient_type];
        }
        Ok(msg_send![pb, changeCount])
    })
}

pub fn pasteboard_clear() -> bool {
    autoreleasepool(|_| unsafe {
        let pb = general_pasteboard();
        if pb.is_null() {
            return false;
        }
        let _: isize = msg_send![pb, clearContents];
        true
    })
}

/// 插入前剪贴板里的全部内容：每个 item 的每种类型各一份字节。
#[derive(Debug, Default, Clone)]
pub struct PasteboardSnapshot {
    pub items: Vec<Vec<(String, Vec<u8>)>>,
}

impl PasteboardSnapshot {
    pub fn type_count(&self) -> usize {
        self.items.iter().map(Vec::len).sum()
    }
}

unsafe fn nsarray_count(array: *mut AnyObject) -> usize {
    if array.is_null() {
        0
    } else {
        msg_send![array, count]
    }
}

unsafe fn nsarray_get(array: *mut AnyObject, index: usize) -> *mut AnyObject {
    msg_send![array, objectAtIndex: index]
}

/// 给剪贴板拍快照。超时间预算或超字节上限返回 None（调用方退回只还原文字）；
/// 剪贴板为空时返回空快照。
///
/// 预算的理由与 Windows 侧相同：有些程序是「延迟提供」数据，读的那一刻才现场生成，
/// 可能很慢，而这一步在插字的关键路径上。
pub fn pasteboard_snapshot(budget: Duration, max_bytes: usize) -> Option<PasteboardSnapshot> {
    let started = Instant::now();
    autoreleasepool(|_| unsafe {
        let pb = general_pasteboard();
        if pb.is_null() {
            return None;
        }
        let items: *mut AnyObject = msg_send![pb, pasteboardItems];
        let mut snapshot = PasteboardSnapshot::default();
        let mut total = 0usize;
        for i in 0..nsarray_count(items) {
            let item = nsarray_get(items, i);
            let types: *mut AnyObject = msg_send![item, types];
            let mut entry = Vec::new();
            for j in 0..nsarray_count(types) {
                if started.elapsed() > budget {
                    return None;
                }
                let ty = nsarray_get(types, j);
                let Some(type_name) = nsstring_to_string(ty) else { continue };
                // 我们自己的标记不必还原
                if type_name == PASTEBOARD_TYPE_TRANSIENT {
                    continue;
                }
                let data: *mut AnyObject = msg_send![item, dataForType: ty];
                if data.is_null() {
                    continue;
                }
                let len: usize = msg_send![data, length];
                total = total.saturating_add(len);
                if total > max_bytes {
                    return None;
                }
                let bytes: *const c_void = msg_send![data, bytes];
                let copy = if len == 0 || bytes.is_null() {
                    Vec::new()
                } else {
                    std::slice::from_raw_parts(bytes as *const u8, len).to_vec()
                };
                entry.push((type_name, copy));
            }
            if !entry.is_empty() {
                snapshot.items.push(entry);
            }
        }
        if started.elapsed() > budget {
            return None;
        }
        Some(snapshot)
    })
}

/// 把快照写回剪贴板。`transient` 为真时给第一个 item 加 TransientType 标记，
/// 免得剪贴板管理器把「还原」再记成一条新历史。
pub fn pasteboard_restore(snapshot: &PasteboardSnapshot, transient: bool) -> bool {
    autoreleasepool(|_| unsafe {
        let pb = general_pasteboard();
        if pb.is_null() {
            return false;
        }
        let _: isize = msg_send![pb, clearContents];
        if snapshot.items.is_empty() {
            return true;
        }
        let transient_type = NSString::from_str(PASTEBOARD_TYPE_TRANSIENT);
        let mut new_items: Vec<Retained<AnyObject>> = Vec::with_capacity(snapshot.items.len());
        for (index, entry) in snapshot.items.iter().enumerate() {
            let item: Option<Retained<AnyObject>> = msg_send![class!(NSPasteboardItem), new];
            let Some(item) = item else { continue };
            for (type_name, bytes) in entry {
                let ty = NSString::from_str(type_name);
                let data = NSData::with_bytes(bytes);
                let _: bool = msg_send![&*item, setData: &*data, forType: &*ty];
            }
            if transient && index == 0 {
                let empty = NSData::with_bytes(&[]);
                let _: bool = msg_send![&*item, setData: &*empty, forType: &*transient_type];
            }
            new_items.push(item);
        }
        if new_items.is_empty() {
            return false;
        }
        let array = NSArray::from_retained_slice(&new_items);
        msg_send![pb, writeObjects: &*array]
    })
}

// ─── 系统提示框 ───

/// 弹一个系统警告框（对应 Windows 的 MessageBoxW）。走 osascript 独立进程：
/// 不占主线程，Tauri 还没起来（例如数据库损坏、在 Builder 之前）也能弹。
/// 文字经 argv 传给脚本，不拼进 AppleScript 源码，避免引号注入。
pub fn show_alert_async(title: &str, message: &str) {
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "display alert (item 1 of argv) message (item 2 of argv) as warning",
            "-e",
            "end run",
            title,
            message,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

// ─── 窗口（必须在主线程调用）───

/// NSStatusWindowLevel（kCGStatusWindowLevel）。比普通「置顶」(NSFloatingWindowLevel = 3) 高，
/// 能压过其它程序的置顶窗口，又低于菜单和系统弹窗。
const OVERLAY_WINDOW_LEVEL: isize = 25;

const COLLECTION_CAN_JOIN_ALL_SPACES: usize = 1 << 0;
const COLLECTION_STATIONARY: usize = 1 << 4;
const COLLECTION_IGNORES_CYCLE: usize = 1 << 6;
const COLLECTION_FULL_SCREEN_AUXILIARY: usize = 1 << 8;

/// 把一个 Tauri 窗口调成「悬浮层」：高窗口层级、出现在所有桌面空间与全屏应用之上、
/// 不参与 ⌘` 窗口切换、App 失去激活时也不隐藏。
///
/// # Safety
/// `ns_window` 必须是有效的 NSWindow 指针，且在主线程调用。
pub unsafe fn configure_overlay_window(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let window = ns_window as *mut AnyObject;
    let _: () = msg_send![window, setLevel: OVERLAY_WINDOW_LEVEL];
    let behavior: usize = COLLECTION_CAN_JOIN_ALL_SPACES
        | COLLECTION_STATIONARY
        | COLLECTION_IGNORES_CYCLE
        | COLLECTION_FULL_SCREEN_AUXILIARY;
    let _: () = msg_send![window, setCollectionBehavior: behavior];
    let _: () = msg_send![window, setHidesOnDeactivate: false];
    let _: () = msg_send![window, setCanHide: false];
}

/// 不激活本程序、不抢键盘焦点地把窗口放到最前（对应 Windows 的 SWP_NOACTIVATE）。
///
/// # Safety
/// `ns_window` 必须是有效的 NSWindow 指针，且在主线程调用。
pub unsafe fn order_front_regardless(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let window = ns_window as *mut AnyObject;
    let _: () = msg_send![window, orderFrontRegardless];
}

/// 窗口当前是否在屏幕上。
///
/// # Safety
/// `ns_window` 必须是有效的 NSWindow 指针，且在主线程调用。
pub unsafe fn window_is_visible(ns_window: *mut c_void) -> bool {
    if ns_window.is_null() {
        return false;
    }
    msg_send![ns_window as *mut AnyObject, isVisible]
}

// ─── 显示器 ───

/// 一块显示器的整屏矩形与可用区域（去掉菜单栏和程序坞），都是全局逻辑点 `(x, y, 宽, 高)`，
/// 左上角为原点、y 向下，与 CoreGraphics 和 Tauri 的显示器坐标一致。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenArea {
    pub frame: (f64, f64, f64, f64),
    pub visible: (f64, f64, f64, f64),
}

/// 枚举所有显示器的整屏矩形与可用区域。
///
/// 线程：和 Tauri 自己算 `Monitor::work_area()` 一样只读 NSScreen 的几何属性，调用方在哪个线程都行。
pub fn screen_areas() -> Vec<ScreenArea> {
    autoreleasepool(|_| unsafe {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        let count = nsarray_count(screens);
        if count == 0 {
            return Vec::new();
        }
        // Cocoa 坐标以主屏（第 0 个，带菜单栏的那块）左下角为原点、y 向上，这里翻成 y 向下
        let primary: NSRect = msg_send![nsarray_get(screens, 0), frame];
        let primary_height = primary.size.height;
        (0..count)
            .filter_map(|index| {
                let screen = nsarray_get(screens, index);
                if screen.is_null() {
                    return None;
                }
                let frame: NSRect = msg_send![screen, frame];
                let visible: NSRect = msg_send![screen, visibleFrame];
                Some(ScreenArea {
                    frame: flip_rect(frame, primary_height),
                    visible: flip_rect(visible, primary_height),
                })
            })
            .collect()
    })
}

fn flip_rect(rect: NSRect, primary_height: f64) -> (f64, f64, f64, f64) {
    (
        rect.origin.x,
        primary_height - (rect.origin.y + rect.size.height),
        rect.size.width,
        rect.size.height,
    )
}

// ─── 登录时重新打开 ───

/// 不让系统的「重新登录时重新打开窗口」在登录后把 SayIt 拉起来。
///
/// 系统会记下注销 / 关机时开着窗口的普通应用，登录后**不带参数**地重新打开它们。SayIt 主窗口
/// 开着时 Dock 里有图标，也会被记进去，于是登录后主窗口弹了出来；十几秒后登录项
/// （LaunchAgent，带 `--minimized`）又启动一次。实测日志：loginwindow 的
/// `PersistentAppsSupport persistentAppPreLaunch … bundleID:com.sayit.app`。
///
/// 登录时要不要启动，只由 SayIt 自己的「登录时自动启动」决定。必须在主线程调用；
/// 每次启动都要调（系统按进程记，不落盘）。
pub fn disable_relaunch_on_login() {
    autoreleasepool(|_| unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if !app.is_null() {
            let _: () = msg_send![app, disableRelaunchOnLogin];
        }
    });
}

// ─── WKWebView 文字输入 ───

/// WebKit 的「智能引号」「智能破折号」开关在 NSUserDefaults 里的键名（见 WebKit 的 TextCheckerMac.mm）。
const WEBKIT_SMART_SUBSTITUTION_KEYS: [&str; 2] = [
    "WebAutomaticQuoteSubstitutionEnabled",
    "WebAutomaticDashSubstitutionEnabled",
];

/// 关掉 WKWebView 输入框里的「智能引号」和「智能破折号」。
///
/// WebKit 在本进程里读 NSUserDefaults 决定这两项；没设置时跟随系统「键盘 → 文本输入」里的
/// 「使用智能引号和破折号」（默认开），于是在 Prompt、热词、文本替换规则里打的 `"`、`--`
/// 会被悄悄换成 “ ” 和 —。这里只在注册域里给默认值 NO：不写偏好文件，也不影响别的程序。
///
/// 拼写检查（红色波浪线）WebKit 默认就关着，拼写自动纠正又依赖它，所以不用管；
/// 系统的「文本替换」（用户自己定义的缩写）保持跟随系统。
///
/// 必须在创建第一个 WebView 之前调用：WebKit 第一次用到时读一次就缓存下来。
pub fn disable_webkit_smart_substitutions() {
    autoreleasepool(|_| unsafe {
        let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
        if no.is_null() {
            return;
        }
        let keys: Vec<Retained<NSString>> = WEBKIT_SMART_SUBSTITUTION_KEYS
            .iter()
            .map(|key| NSString::from_str(key))
            .collect();
        let key_ptrs: Vec<*mut AnyObject> =
            keys.iter().map(|key| Retained::as_ptr(key) as *mut AnyObject).collect();
        let values: Vec<*mut AnyObject> = vec![no; key_ptrs.len()];
        let dict: *mut AnyObject = msg_send![
            class!(NSDictionary),
            dictionaryWithObjects: values.as_ptr(),
            forKeys: key_ptrs.as_ptr(),
            count: key_ptrs.len()
        ];
        let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
        if dict.is_null() || defaults.is_null() {
            return;
        }
        let _: () = msg_send![defaults, registerDefaults: dict];
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webkit_smart_substitutions_default_to_off() {
        disable_webkit_smart_substitutions();
        autoreleasepool(|_| unsafe {
            let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
            for key in WEBKIT_SMART_SUBSTITUTION_KEYS {
                let name = NSString::from_str(key);
                // WebKit 先看有没有值（没有就跟随系统），再按 bool 读
                let value: *mut AnyObject = msg_send![defaults, objectForKey: &*name];
                assert!(!value.is_null(), "{key} should have a registered default");
                let enabled: bool = msg_send![defaults, boolForKey: &*name];
                assert!(!enabled, "{key} should default to NO");
            }
        });
    }

    #[test]
    fn frontmost_app_is_queryable() {
        // 在有图形会话的机器上总能拿到一个前台应用；CI 无头环境里可能是 None，不算失败。
        if let Some(app) = frontmost_app() {
            assert!(app.pid > 0);
        }
    }

    #[test]
    fn screen_areas_put_visible_frame_inside_screen() {
        // 无头环境可能一块屏都没有，不算失败
        for area in screen_areas() {
            let (fx, fy, fw, fh) = area.frame;
            let (vx, vy, vw, vh) = area.visible;
            assert!(vx >= fx - 0.5 && vy >= fy - 0.5, "{area:?}");
            assert!(vx + vw <= fx + fw + 0.5 && vy + vh <= fy + fh + 0.5, "{area:?}");
        }
    }
}
