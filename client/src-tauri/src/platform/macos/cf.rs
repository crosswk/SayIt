//! CoreFoundation 小工具：拥有所有权的 CF 引用（Drop 时 CFRelease）、CFString 互转。

use super::ffi::*;
use std::ffi::c_void;

/// 持有一份 +1 引用的 CF 对象，离开作用域自动 CFRelease。
/// 只用于 Create/Copy 规则返回的对象（以及我们自己 CFRetain 过的）。
pub struct CfOwned(CFTypeRef);

impl CfOwned {
    /// 接管一个 Create/Copy 返回的引用；空指针返回 None。
    ///
    /// # Safety
    /// `ptr` 必须是调用方拥有的 +1 引用。
    pub unsafe fn from_create(ptr: CFTypeRef) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            Some(Self(ptr))
        }
    }

    /// 对一个借来的引用 CFRetain 一次后持有。
    ///
    /// # Safety
    /// `ptr` 必须是有效的 CF 对象。
    pub unsafe fn retain(ptr: CFTypeRef) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            CFRetain(ptr);
            Some(Self(ptr))
        }
    }

    pub fn as_ptr(&self) -> CFTypeRef {
        self.0
    }

    pub fn type_id(&self) -> CFTypeID {
        unsafe { CFGetTypeID(self.0) }
    }
}

impl Drop for CfOwned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

// CF 对象本身是线程安全的引用计数对象；这里只在持有期间读取。
unsafe impl Send for CfOwned {}
unsafe impl Sync for CfOwned {}

/// Rust 字符串 → CFString（+1）。
pub fn cfstr(s: &str) -> CfOwned {
    unsafe {
        let ptr = CFStringCreateWithBytes(
            std::ptr::null(),
            s.as_ptr(),
            s.len() as CFIndex,
            kCFStringEncodingUTF8,
            0,
        );
        CfOwned::from_create(ptr).expect("CFStringCreateWithBytes returned NULL")
    }
}

/// CFString → Rust String。不是 CFString 时返回 None。
///
/// # Safety
/// `s` 必须是有效的 CF 对象或空指针。
pub unsafe fn cfstring_to_string(s: CFTypeRef) -> Option<String> {
    if s.is_null() || CFGetTypeID(s) != CFStringGetTypeID() {
        return None;
    }
    let len = CFStringGetLength(s);
    let cap = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
    if cap <= 0 {
        return Some(String::new());
    }
    let mut buf = vec![0u8; cap as usize];
    if CFStringGetCString(s, buf.as_mut_ptr() as *mut _, cap, kCFStringEncodingUTF8) == 0 {
        return None;
    }
    let nul = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    buf.truncate(nul);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// CFBoolean → bool。不是 CFBoolean 时返回 None。
///
/// # Safety
/// `b` 必须是有效的 CF 对象或空指针。
pub unsafe fn cfboolean_to_bool(b: CFTypeRef) -> Option<bool> {
    if b.is_null() || CFGetTypeID(b) != CFBooleanGetTypeID() {
        return None;
    }
    Some(CFBooleanGetValue(b) != 0)
}

/// CFNumber → i64。
///
/// # Safety
/// `n` 必须是有效的 CF 对象或空指针。
pub unsafe fn cfnumber_to_i64(n: CFTypeRef) -> Option<i64> {
    if n.is_null() || CFGetTypeID(n) != CFNumberGetTypeID() {
        return None;
    }
    let mut value: i64 = 0;
    if CFNumberGetValue(n, kCFNumberSInt64Type, &mut value as *mut i64 as *mut c_void) != 0 {
        Some(value)
    } else {
        None
    }
}

/// 遍历 CFArray 里的字符串。
///
/// # Safety
/// `array` 必须是有效的 CFArray 或空指针。
pub unsafe fn cfarray_strings(array: CFTypeRef) -> Vec<String> {
    if array.is_null() || CFGetTypeID(array) != CFArrayGetTypeID() {
        return Vec::new();
    }
    let count = CFArrayGetCount(array);
    (0..count)
        .filter_map(|i| cfstring_to_string(CFArrayGetValueAtIndex(array, i)))
        .collect()
}

/// `{ key: true }` 这样只有一个布尔值的字典（给 AXIsProcessTrustedWithOptions 用）。
///
/// # Safety
/// `key` 必须是有效的 CFString。
pub unsafe fn single_bool_dictionary(key: CFStringRef, value: bool) -> Option<CfOwned> {
    let keys = [key as *const c_void];
    let values = [if value { kCFBooleanTrue } else { kCFBooleanFalse } as *const c_void];
    CfOwned::from_create(CFDictionaryCreate(
        std::ptr::null(),
        keys.as_ptr(),
        values.as_ptr(),
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cfstring_roundtrip_keeps_unicode() {
        let s = cfstr("说话 SayIt ✓");
        assert_eq!(unsafe { cfstring_to_string(s.as_ptr()) }.as_deref(), Some("说话 SayIt ✓"));
    }

    #[test]
    fn empty_string_roundtrip() {
        let s = cfstr("");
        assert_eq!(unsafe { cfstring_to_string(s.as_ptr()) }.as_deref(), Some(""));
    }
}
