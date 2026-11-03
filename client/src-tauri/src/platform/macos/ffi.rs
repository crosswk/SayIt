//! macOS 系统 C 接口声明：CoreFoundation / CoreGraphics / Accessibility / Carbon / CoreAudio。
//!
//! 只声明 SayIt 用得到的那一小撮。这些都是十几年没变过签名的稳定 C API，
//! 直接声明比再拉一套绑定 crate 更可控（Windows 侧 `windows 0.58` 与 `windows-core 0.61`
//! 两套类型不能混用的坑，这里不想再踩一遍）。AppKit / Foundation 的 Objective-C 对象
//! 走 objc2（见 appkit.rs）。
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code)]

use std::ffi::{c_char, c_void};

// ─── CoreFoundation ───

pub type CFTypeRef = *const c_void;
pub type CFStringRef = *const c_void;
pub type CFArrayRef = *const c_void;
pub type CFDictionaryRef = *const c_void;
pub type CFAllocatorRef = *const c_void;
pub type CFDataRef = *const c_void;
pub type CFBooleanRef = *const c_void;
pub type CFNumberRef = *const c_void;
pub type CFLocaleRef = *const c_void;
pub type CFMachPortRef = *mut c_void;
pub type CFRunLoopRef = *mut c_void;
pub type CFRunLoopSourceRef = *mut c_void;
pub type CFIndex = isize;
pub type CFTypeID = usize;
pub type CFStringEncoding = u32;
pub type CFNumberType = CFIndex;
/// Carbon 风格的 `Boolean`（unsigned char），与 C99 `bool` 不是一回事。
pub type Boolean = u8;

pub const kCFStringEncodingUTF8: CFStringEncoding = 0x0800_0100;
pub const kCFNumberSInt32Type: CFNumberType = 3;
pub const kCFNumberSInt64Type: CFNumberType = 4;
pub const kCFNumberFloat64Type: CFNumberType = 6;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CFRange {
    pub location: CFIndex,
    pub length: CFIndex,
}

/// 不透明结构：只取地址传给 CFDictionaryCreate。
#[repr(C)]
pub struct CFDictionaryKeyCallBacks {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct CFDictionaryValueCallBacks {
    _opaque: [u8; 0],
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub static kCFRunLoopCommonModes: CFStringRef;
    pub static kCFRunLoopDefaultMode: CFStringRef;
    pub static kCFBooleanTrue: CFBooleanRef;
    pub static kCFBooleanFalse: CFBooleanRef;
    pub static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
    pub static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;

    pub fn CFRelease(cf: CFTypeRef);
    pub fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    pub fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
    pub fn CFStringGetTypeID() -> CFTypeID;
    pub fn CFBooleanGetTypeID() -> CFTypeID;
    pub fn CFArrayGetTypeID() -> CFTypeID;
    pub fn CFNumberGetTypeID() -> CFTypeID;

    pub fn CFStringCreateWithBytes(
        alloc: CFAllocatorRef,
        bytes: *const u8,
        num_bytes: CFIndex,
        encoding: CFStringEncoding,
        is_external_representation: Boolean,
    ) -> CFStringRef;
    pub fn CFStringGetLength(s: CFStringRef) -> CFIndex;
    pub fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: CFStringEncoding) -> CFIndex;
    pub fn CFStringGetCString(
        s: CFStringRef,
        buffer: *mut c_char,
        buffer_size: CFIndex,
        encoding: CFStringEncoding,
    ) -> Boolean;

    pub fn CFBooleanGetValue(b: CFBooleanRef) -> Boolean;
    pub fn CFNumberGetValue(n: CFNumberRef, the_type: CFNumberType, value_ptr: *mut c_void) -> Boolean;
    pub fn CFArrayGetCount(a: CFArrayRef) -> CFIndex;
    pub fn CFArrayGetValueAtIndex(a: CFArrayRef, idx: CFIndex) -> *const c_void;
    pub fn CFDictionaryCreate(
        alloc: CFAllocatorRef,
        keys: *const *const c_void,
        values: *const *const c_void,
        num_values: CFIndex,
        key_callbacks: *const CFDictionaryKeyCallBacks,
        value_callbacks: *const CFDictionaryValueCallBacks,
    ) -> CFDictionaryRef;
    pub fn CFDataGetBytePtr(d: CFDataRef) -> *const u8;

    pub fn CFMachPortCreateRunLoopSource(
        alloc: CFAllocatorRef,
        port: CFMachPortRef,
        order: CFIndex,
    ) -> CFRunLoopSourceRef;
    pub fn CFMachPortInvalidate(port: CFMachPortRef);
    pub fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    pub fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    pub fn CFRunLoopRemoveSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    pub fn CFRunLoopRunInMode(mode: CFStringRef, seconds: f64, return_after_source_handled: Boolean) -> i32;
    pub fn CFRunLoopStop(rl: CFRunLoopRef);
    pub fn CFRunLoopWakeUp(rl: CFRunLoopRef);

    pub fn CFLocaleCopyPreferredLanguages() -> CFArrayRef;
    pub fn CFLocaleCopyCurrent() -> CFLocaleRef;
    pub fn CFLocaleGetIdentifier(locale: CFLocaleRef) -> CFStringRef;
}

// ─── CoreGraphics（事件）───

pub type CGEventRef = *mut c_void;
pub type CGEventSourceRef = *mut c_void;
pub type CGEventTapProxy = *mut c_void;
pub type CGEventType = u32;
pub type CGEventMask = u64;
pub type CGEventFlags = u64;
pub type CGKeyCode = u16;
pub type CGEventField = u32;
pub type CGEventTapLocation = u32;
pub type CGEventTapPlacement = u32;
pub type CGEventTapOptions = u32;
pub type CGEventSourceStateID = i32;
pub type CGMouseButton = u32;
pub type CGEventTapCallBack = unsafe extern "C" fn(
    proxy: CGEventTapProxy,
    event_type: CGEventType,
    event: CGEventRef,
    user_info: *mut c_void,
) -> CGEventRef;

pub const kCGHIDEventTap: CGEventTapLocation = 0;
pub const kCGSessionEventTap: CGEventTapLocation = 1;
pub const kCGHeadInsertEventTap: CGEventTapPlacement = 0;
pub const kCGEventTapOptionDefault: CGEventTapOptions = 0;
pub const kCGEventTapOptionListenOnly: CGEventTapOptions = 1;

pub const kCGEventKeyDown: CGEventType = 10;
pub const kCGEventKeyUp: CGEventType = 11;
pub const kCGEventFlagsChanged: CGEventType = 12;
pub const kCGEventOtherMouseDown: CGEventType = 25;
pub const kCGEventOtherMouseUp: CGEventType = 26;
pub const kCGEventTapDisabledByTimeout: CGEventType = 0xFFFF_FFFE;
pub const kCGEventTapDisabledByUserInput: CGEventType = 0xFFFF_FFFF;
/// `kCGAnyInputEventType`：任意输入事件（给「最后一次输入距今多久」用）。
pub const kCGAnyInputEventType: CGEventType = 0xFFFF_FFFF;

pub const kCGMouseEventButtonNumber: CGEventField = 3;
pub const kCGKeyboardEventAutorepeat: CGEventField = 8;
pub const kCGKeyboardEventKeycode: CGEventField = 9;
pub const kCGEventSourceUnixProcessID: CGEventField = 41;
pub const kCGEventSourceUserData: CGEventField = 42;

pub const kCGEventSourceStatePrivate: CGEventSourceStateID = -1;
pub const kCGEventSourceStateCombinedSessionState: CGEventSourceStateID = 0;
pub const kCGEventSourceStateHIDSystemState: CGEventSourceStateID = 1;

pub const kCGEventFlagMaskAlphaShift: CGEventFlags = 0x0001_0000;
pub const kCGEventFlagMaskShift: CGEventFlags = 0x0002_0000;
pub const kCGEventFlagMaskControl: CGEventFlags = 0x0004_0000;
pub const kCGEventFlagMaskAlternate: CGEventFlags = 0x0008_0000;
pub const kCGEventFlagMaskCommand: CGEventFlags = 0x0010_0000;
pub const kCGEventFlagMaskSecondaryFn: CGEventFlags = 0x0080_0000;

// IOKit 的「设备相关」修饰位（NX_DEVICE*KEYMASK）：区分左右侧修饰键。
pub const NX_DEVICELCTLKEYMASK: CGEventFlags = 0x0000_0001;
pub const NX_DEVICELSHIFTKEYMASK: CGEventFlags = 0x0000_0002;
pub const NX_DEVICERSHIFTKEYMASK: CGEventFlags = 0x0000_0004;
pub const NX_DEVICELCMDKEYMASK: CGEventFlags = 0x0000_0008;
pub const NX_DEVICERCMDKEYMASK: CGEventFlags = 0x0000_0010;
pub const NX_DEVICELALTKEYMASK: CGEventFlags = 0x0000_0020;
pub const NX_DEVICERALTKEYMASK: CGEventFlags = 0x0000_0040;
pub const NX_DEVICERCTLKEYMASK: CGEventFlags = 0x0000_2000;

pub const kCGMouseButtonCenter: CGMouseButton = 2;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGEventTapCreate(
        tap: CGEventTapLocation,
        place: CGEventTapPlacement,
        options: CGEventTapOptions,
        events_of_interest: CGEventMask,
        callback: CGEventTapCallBack,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    pub fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    pub fn CGEventTapIsEnabled(tap: CFMachPortRef) -> bool;

    pub fn CGEventGetIntegerValueField(event: CGEventRef, field: CGEventField) -> i64;
    pub fn CGEventSetIntegerValueField(event: CGEventRef, field: CGEventField, value: i64);
    pub fn CGEventGetFlags(event: CGEventRef) -> CGEventFlags;
    pub fn CGEventSetFlags(event: CGEventRef, flags: CGEventFlags);

    pub fn CGEventSourceCreate(state: CGEventSourceStateID) -> CGEventSourceRef;
    pub fn CGEventCreateKeyboardEvent(source: CGEventSourceRef, key: CGKeyCode, key_down: bool) -> CGEventRef;
    pub fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, string: *const u16);
    pub fn CGEventPost(tap: CGEventTapLocation, event: CGEventRef);

    pub fn CGEventSourceKeyState(state: CGEventSourceStateID, key: CGKeyCode) -> bool;
    pub fn CGEventSourceFlagsState(state: CGEventSourceStateID) -> CGEventFlags;
    pub fn CGEventSourceButtonState(state: CGEventSourceStateID, button: CGMouseButton) -> bool;
    pub fn CGEventSourceSecondsSinceLastEventType(state: CGEventSourceStateID, event_type: CGEventType) -> f64;

    pub fn CGPreflightPostEventAccess() -> bool;
    pub fn CGRequestPostEventAccess() -> bool;
    pub fn CGPreflightListenEventAccess() -> bool;
    pub fn CGRequestListenEventAccess() -> bool;
}

// ─── Accessibility（HIServices，属于 ApplicationServices）───

pub type AXUIElementRef = *const c_void;
pub type AXValueRef = *const c_void;
pub type AXError = i32;
pub type AXValueType = u32;

pub const kAXErrorSuccess: AXError = 0;
pub const kAXErrorAPIDisabled: AXError = -25211;
pub const kAXValueTypeCGPoint: AXValueType = 1;
pub const kAXValueTypeCGSize: AXValueType = 2;
pub const kAXValueTypeCFRange: AXValueType = 4;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub static kAXTrustedCheckOptionPrompt: CFStringRef;

    pub fn AXIsProcessTrusted() -> Boolean;
    pub fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> Boolean;
    pub fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    pub fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    pub fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    pub fn AXUIElementSetAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) -> AXError;
    pub fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut Boolean,
    ) -> AXError;
    pub fn AXUIElementCopyParameterizedAttributeValue(
        element: AXUIElementRef,
        parameterized_attribute: CFStringRef,
        parameter: CFTypeRef,
        result: *mut CFTypeRef,
    ) -> AXError;
    pub fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    pub fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_in_seconds: f32) -> AXError;
    pub fn AXValueCreate(the_type: AXValueType, value_ptr: *const c_void) -> AXValueRef;
    pub fn AXValueGetValue(value: AXValueRef, the_type: AXValueType, value_ptr: *mut c_void) -> Boolean;
    pub fn AXValueGetTypeID() -> CFTypeID;
    pub fn AXUIElementGetTypeID() -> CFTypeID;
}

// ─── Carbon（键盘布局、安全输入）───

pub type TISInputSourceRef = *mut c_void;
pub type OSStatus = i32;

/// UCKeyTranslate 的 keyAction：kUCKeyActionDisplay。
pub const kUCKeyActionDisplay: u16 = 3;
/// UCKeyTranslate 的选项：kUCKeyTranslateNoDeadKeysMask。
pub const kUCKeyTranslateNoDeadKeysMask: u32 = 1;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    pub static kTISPropertyUnicodeKeyLayoutData: CFStringRef;

    pub fn TISCopyCurrentKeyboardLayoutInputSource() -> TISInputSourceRef;
    pub fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> TISInputSourceRef;
    pub fn TISGetInputSourceProperty(source: TISInputSourceRef, key: CFStringRef) -> *mut c_void;
    pub fn LMGetKbdType() -> u8;
    pub fn UCKeyTranslate(
        key_layout_ptr: *const c_void,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        key_translate_options: u32,
        dead_key_state: *mut u32,
        max_string_length: usize,
        actual_string_length: *mut usize,
        unicode_string: *mut u16,
    ) -> OSStatus;
    pub fn IsSecureEventInputEnabled() -> Boolean;
}

// ─── CoreAudio ───

pub type AudioObjectID = u32;
pub type AudioObjectPropertySelector = u32;
pub type AudioObjectPropertyScope = u32;
pub type AudioObjectPropertyElement = u32;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct AudioObjectPropertyAddress {
    pub mSelector: AudioObjectPropertySelector,
    pub mScope: AudioObjectPropertyScope,
    pub mElement: AudioObjectPropertyElement,
}

/// 四字符码，例如 `fourcc(b"dOut")`。
pub const fn fourcc(code: &[u8; 4]) -> u32 {
    ((code[0] as u32) << 24) | ((code[1] as u32) << 16) | ((code[2] as u32) << 8) | (code[3] as u32)
}

pub const kAudioObjectSystemObject: AudioObjectID = 1;
pub const kAudioObjectUnknown: AudioObjectID = 0;
pub const kAudioObjectPropertyElementMain: AudioObjectPropertyElement = 0;
pub const kAudioObjectPropertyScopeGlobal: AudioObjectPropertyScope = fourcc(b"glob");
pub const kAudioDevicePropertyScopeInput: AudioObjectPropertyScope = fourcc(b"inpt");
pub const kAudioDevicePropertyScopeOutput: AudioObjectPropertyScope = fourcc(b"outp");
pub const kAudioHardwarePropertyDevices: AudioObjectPropertySelector = fourcc(b"dev#");
pub const kAudioHardwarePropertyDefaultInputDevice: AudioObjectPropertySelector = fourcc(b"dIn ");
pub const kAudioHardwarePropertyDefaultOutputDevice: AudioObjectPropertySelector = fourcc(b"dOut");
pub const kAudioDevicePropertyMute: AudioObjectPropertySelector = fourcc(b"mute");
pub const kAudioDevicePropertyVolumeScalar: AudioObjectPropertySelector = fourcc(b"volm");
pub const kAudioDevicePropertyStreams: AudioObjectPropertySelector = fourcc(b"stm#");
pub const kAudioObjectPropertyName: AudioObjectPropertySelector = fourcc(b"lnam");

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    pub fn AudioObjectHasProperty(id: AudioObjectID, address: *const AudioObjectPropertyAddress) -> Boolean;
    pub fn AudioObjectIsPropertySettable(
        id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        out_is_settable: *mut Boolean,
    ) -> OSStatus;
    pub fn AudioObjectGetPropertyDataSize(
        id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        out_data_size: *mut u32,
    ) -> OSStatus;
    pub fn AudioObjectGetPropertyData(
        id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        io_data_size: *mut u32,
        out_data: *mut c_void,
    ) -> OSStatus;
    pub fn AudioObjectSetPropertyData(
        id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        data_size: u32,
        data: *const c_void,
    ) -> OSStatus;
}
