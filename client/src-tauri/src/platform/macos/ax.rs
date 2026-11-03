//! Accessibility（AXUIElement）封装。对应 Windows 侧的 UI Automation。
//!
//! 所有调用都是对目标进程的 IPC，目标卡住时会一直等；因此每个元素都要先设消息超时
//! （见 `set_timeout`），别让热键路径被别人的程序拖住。

use super::cf::{cfboolean_to_bool, cfnumber_to_i64, cfstr, cfstring_to_string, CfOwned};
use super::ffi::*;
use std::ffi::c_void;

/// AX 调用的默认超时。和 Windows 侧 UIA 查询的量级一致：正常目标几毫秒就回，
/// 超过这个时间就当拿不到，宁可少一条信号也不拖慢热键。
pub const DEFAULT_TIMEOUT_SECS: f32 = 0.25;

pub struct AxElement(CfOwned);

impl AxElement {
    /// 系统级元素：可以问「当前焦点在哪个程序 / 哪个元素」。
    pub fn system_wide() -> Option<Self> {
        unsafe { CfOwned::from_create(AXUIElementCreateSystemWide()).map(Self) }
    }

    /// 某个进程的应用元素。
    pub fn application(pid: i32) -> Option<Self> {
        if pid <= 0 {
            return None;
        }
        unsafe { CfOwned::from_create(AXUIElementCreateApplication(pid)).map(Self) }
    }

    pub fn as_ptr(&self) -> AXUIElementRef {
        self.0.as_ptr()
    }

    pub fn set_timeout(&self, secs: f32) {
        unsafe {
            let _ = AXUIElementSetMessagingTimeout(self.as_ptr(), secs);
        }
    }

    pub fn pid(&self) -> Option<i32> {
        let mut pid: i32 = 0;
        let err = unsafe { AXUIElementGetPid(self.as_ptr(), &mut pid) };
        (err == kAXErrorSuccess && pid > 0).then_some(pid)
    }

    /// 读属性（+1 引用）。失败、无值都返回 None。
    pub fn attr(&self, name: &str) -> Option<CfOwned> {
        let key = cfstr(name);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(self.as_ptr(), key.as_ptr(), &mut value) };
        if err != kAXErrorSuccess {
            return None;
        }
        unsafe { CfOwned::from_create(value) }
    }

    /// 读属性，并返回 AX 错误码（用来区分「没授权」与「没这个属性」）。
    pub fn attr_with_error(&self, name: &str) -> Result<CfOwned, AXError> {
        let key = cfstr(name);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(self.as_ptr(), key.as_ptr(), &mut value) };
        if err != kAXErrorSuccess {
            return Err(err);
        }
        unsafe { CfOwned::from_create(value) }.ok_or(err)
    }

    pub fn attr_string(&self, name: &str) -> Option<String> {
        let value = self.attr(name)?;
        unsafe { cfstring_to_string(value.as_ptr()) }
    }

    pub fn attr_bool(&self, name: &str) -> Option<bool> {
        let value = self.attr(name)?;
        unsafe { cfboolean_to_bool(value.as_ptr()) }
    }

    pub fn attr_i64(&self, name: &str) -> Option<i64> {
        let value = self.attr(name)?;
        unsafe { cfnumber_to_i64(value.as_ptr()) }
    }

    pub fn attr_element(&self, name: &str) -> Option<AxElement> {
        let value = self.attr(name)?;
        if value.type_id() != unsafe { AXUIElementGetTypeID() } {
            return None;
        }
        Some(AxElement(value))
    }

    fn attr_ax_value<T: Default>(&self, name: &str, value_type: AXValueType) -> Option<T> {
        let value = self.attr(name)?;
        if value.type_id() != unsafe { AXValueGetTypeID() } {
            return None;
        }
        let mut out = T::default();
        let ok = unsafe { AXValueGetValue(value.as_ptr(), value_type, &mut out as *mut T as *mut c_void) };
        (ok != 0).then_some(out)
    }

    pub fn attr_range(&self, name: &str) -> Option<CFRange> {
        self.attr_ax_value::<CFRange>(name, kAXValueTypeCFRange)
    }

    pub fn attr_point(&self, name: &str) -> Option<CGPoint> {
        self.attr_ax_value::<CGPoint>(name, kAXValueTypeCGPoint)
    }

    pub fn attr_size(&self, name: &str) -> Option<CGSize> {
        self.attr_ax_value::<CGSize>(name, kAXValueTypeCGSize)
    }

    pub fn is_settable(&self, name: &str) -> Option<bool> {
        let key = cfstr(name);
        let mut settable: Boolean = 0;
        let err = unsafe { AXUIElementIsAttributeSettable(self.as_ptr(), key.as_ptr(), &mut settable) };
        (err == kAXErrorSuccess).then_some(settable != 0)
    }

    /// `AXStringForRange`：按字符区间取文本（UTF-16 下标，与 CFString 一致）。
    pub fn string_for_range(&self, range: CFRange) -> Option<String> {
        if range.length <= 0 || range.location < 0 {
            return None;
        }
        let param = unsafe {
            CfOwned::from_create(AXValueCreate(
                kAXValueTypeCFRange,
                &range as *const CFRange as *const c_void,
            ))
        }?;
        let key = cfstr("AXStringForRange");
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyParameterizedAttributeValue(self.as_ptr(), key.as_ptr(), param.as_ptr(), &mut value)
        };
        if err != kAXErrorSuccess {
            return None;
        }
        let owned = unsafe { CfOwned::from_create(value) }?;
        unsafe { cfstring_to_string(owned.as_ptr()) }
    }

    pub fn set_bool(&self, name: &str, value: bool) -> bool {
        let key = cfstr(name);
        let v = if value { unsafe { kCFBooleanTrue } } else { unsafe { kCFBooleanFalse } };
        unsafe { AXUIElementSetAttributeValue(self.as_ptr(), key.as_ptr(), v) == kAXErrorSuccess }
    }

    pub fn set_string(&self, name: &str, value: &str) -> bool {
        let key = cfstr(name);
        let v = cfstr(value);
        unsafe { AXUIElementSetAttributeValue(self.as_ptr(), key.as_ptr(), v.as_ptr()) == kAXErrorSuccess }
    }
}

/// 本进程是否已获得「辅助功能」授权。
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// 检查授权；`prompt = true` 时如果还没授权，系统会弹出引导用户去「系统设置」的对话框。
pub fn is_trusted_with_prompt(prompt: bool) -> bool {
    unsafe {
        match super::cf::single_bool_dictionary(kAXTrustedCheckOptionPrompt, prompt) {
            Some(options) => AXIsProcessTrustedWithOptions(options.as_ptr()) != 0,
            None => AXIsProcessTrusted() != 0,
        }
    }
}

/// 当前拥有键盘焦点的应用的 pid（经由辅助功能，任何线程都可以调）。
pub fn focused_application_pid() -> Option<i32> {
    let system = AxElement::system_wide()?;
    system.set_timeout(DEFAULT_TIMEOUT_SECS);
    let app = system.attr_element("AXFocusedApplication")?;
    app.pid()
}
