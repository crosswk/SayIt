//! macOS 虚拟键码（kVK_*，Carbon Events.h）与 SayIt 内部键 ID 的互转。
//!
//! 热键状态机（keyboard/mod.rs）和前端都以 **Windows 虚拟键码** 作为键的内部 ID
//! （`SINGLE_KEY_TABLE`、`PTTEvent.keycode`）。mac 上不另起一套 ID，而是在事件入口把
//! macOS 键码翻译成同一套 VK，这样状态机、单测和前后端契约全部复用。
//!
//! Mac 键盘上不存在的键（ContextMenu / Pause / ScrollLock / BrowserBack / F21–F24 等）
//! 这里没有映射，按了也不会命中；前端在 mac 上不展示这些键。

use super::ffi::{
    CGEventFlags, CGKeyCode, kCGEventFlagMaskAlternate, kCGEventFlagMaskCommand, kCGEventFlagMaskControl,
    kCGEventFlagMaskSecondaryFn, kCGEventFlagMaskShift, NX_DEVICELALTKEYMASK, NX_DEVICELCMDKEYMASK,
    NX_DEVICELCTLKEYMASK, NX_DEVICELSHIFTKEYMASK, NX_DEVICERALTKEYMASK, NX_DEVICERCMDKEYMASK,
    NX_DEVICERCTLKEYMASK, NX_DEVICERSHIFTKEYMASK,
};

/// Fn / 🌐 键的内部 ID。Windows 没有对应的虚拟键，取保留值 0xFF；只有 mac 会产生它。
pub const VK_FN: u32 = 0xFF;

pub const KVK_ANSI_C: CGKeyCode = 0x08;
pub const KVK_ANSI_V: CGKeyCode = 0x09;
pub const KVK_ESCAPE: CGKeyCode = 0x35;
pub const KVK_COMMAND: CGKeyCode = 0x37;
pub const KVK_FUNCTION: CGKeyCode = 0x3F;
pub const KVK_CAPS_LOCK: CGKeyCode = 0x39;

/// (Windows VK, macOS 键码)。修饰键单独放在 MODIFIERS 里。
const KEYS: &[(u32, CGKeyCode)] = &[
    // 字母（ANSI 物理位置）
    (0x41, 0x00), // A
    (0x42, 0x0B), // B
    (0x43, 0x08), // C
    (0x44, 0x02), // D
    (0x45, 0x0E), // E
    (0x46, 0x03), // F
    (0x47, 0x05), // G
    (0x48, 0x04), // H
    (0x49, 0x22), // I
    (0x4A, 0x26), // J
    (0x4B, 0x28), // K
    (0x4C, 0x25), // L
    (0x4D, 0x2E), // M
    (0x4E, 0x2D), // N
    (0x4F, 0x1F), // O
    (0x50, 0x23), // P
    (0x51, 0x0C), // Q
    (0x52, 0x0F), // R
    (0x53, 0x01), // S
    (0x54, 0x11), // T
    (0x55, 0x20), // U
    (0x56, 0x09), // V
    (0x57, 0x0D), // W
    (0x58, 0x07), // X
    (0x59, 0x10), // Y
    (0x5A, 0x06), // Z
    // 数字行
    (0x30, 0x1D), // 0
    (0x31, 0x12), // 1
    (0x32, 0x13), // 2
    (0x33, 0x14), // 3
    (0x34, 0x15), // 4
    (0x35, 0x17), // 5
    (0x36, 0x16), // 6
    (0x37, 0x1A), // 7
    (0x38, 0x1C), // 8
    (0x39, 0x19), // 9
    // 功能键（F13–F20 有 kVK 码，F21–F24 没有）
    (0x70, 0x7A), // F1
    (0x71, 0x78), // F2
    (0x72, 0x63), // F3
    (0x73, 0x76), // F4
    (0x74, 0x60), // F5
    (0x75, 0x61), // F6
    (0x76, 0x62), // F7
    (0x77, 0x64), // F8
    (0x78, 0x65), // F9
    (0x79, 0x6D), // F10
    (0x7A, 0x67), // F11
    (0x7B, 0x6F), // F12
    (0x7C, 0x69), // F13
    (0x7D, 0x6B), // F14
    (0x7E, 0x71), // F15
    (0x7F, 0x6A), // F16
    (0x80, 0x40), // F17
    (0x81, 0x4F), // F18
    (0x82, 0x50), // F19
    (0x83, 0x5A), // F20
    // 其它
    (0x20, 0x31), // Space
    (0x1B, 0x35), // Escape
    (0x09, 0x30), // Tab
    (0x0D, 0x24), // Enter（Return）
    (0x08, 0x33), // Backspace（Mac 的 Delete）
    (0x2E, 0x75), // Delete（Mac 的 Forward Delete）
    (0x2D, 0x72), // Insert（PC 键盘接 Mac 时报成 Help）
    (0x26, 0x7E), // ArrowUp
    (0x28, 0x7D), // ArrowDown
    (0x25, 0x7B), // ArrowLeft
    (0x27, 0x7C), // ArrowRight
    (0x24, 0x73), // Home
    (0x23, 0x77), // End
    (0x21, 0x74), // PageUp
    (0x22, 0x79), // PageDown
    // 标点（ANSI 物理位置，对应 Windows 的 VK_OEM_*）：组合键的主键可能是它们
    (0xBA, 0x29), // ; Semicolon
    (0xBB, 0x18), // = Equal
    (0xBC, 0x2B), // , Comma
    (0xBD, 0x1B), // - Minus
    (0xBE, 0x2F), // . Period
    (0xBF, 0x2C), // / Slash
    (0xC0, 0x32), // ` Backquote
    (0xDB, 0x21), // [ BracketLeft
    (0xDC, 0x2A), // \ Backslash
    (0xDD, 0x1E), // ] BracketRight
    (0xDE, 0x27), // ' Quote
    // 数字小键盘（Enter 与主键盘的 Enter 在 Windows 上同一个 VK，不映射）
    (0x60, 0x52), // Numpad0
    (0x61, 0x53), // Numpad1
    (0x62, 0x54), // Numpad2
    (0x63, 0x55), // Numpad3
    (0x64, 0x56), // Numpad4
    (0x65, 0x57), // Numpad5
    (0x66, 0x58), // Numpad6
    (0x67, 0x59), // Numpad7
    (0x68, 0x5B), // Numpad8
    (0x69, 0x5C), // Numpad9
    (0x6A, 0x43), // NumpadMultiply
    (0x6B, 0x45), // NumpadAdd
    (0x6D, 0x4E), // NumpadSubtract
    (0x6E, 0x41), // NumpadDecimal
    (0x6F, 0x4B), // NumpadDivide
];

/// 修饰键：(Windows VK, macOS 键码, 设备相关位, 同族的设备相关位, 族掩码)。
///
/// flagsChanged 事件只告诉你「修饰状态变了」，要靠设备相关位判断是哪一侧、按下还是抬起。
/// 少数虚拟键盘/驱动不填设备相关位，此时退回看族掩码（见 `modifier_is_down`）。
const MODIFIERS: &[(u32, CGKeyCode, CGEventFlags, CGEventFlags, CGEventFlags)] = &[
    (0xA0, 0x38, NX_DEVICELSHIFTKEYMASK, NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK, kCGEventFlagMaskShift),
    (0xA1, 0x3C, NX_DEVICERSHIFTKEYMASK, NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK, kCGEventFlagMaskShift),
    (0xA2, 0x3B, NX_DEVICELCTLKEYMASK, NX_DEVICELCTLKEYMASK | NX_DEVICERCTLKEYMASK, kCGEventFlagMaskControl),
    (0xA3, 0x3E, NX_DEVICERCTLKEYMASK, NX_DEVICELCTLKEYMASK | NX_DEVICERCTLKEYMASK, kCGEventFlagMaskControl),
    (0xA4, 0x3A, NX_DEVICELALTKEYMASK, NX_DEVICELALTKEYMASK | NX_DEVICERALTKEYMASK, kCGEventFlagMaskAlternate),
    (0xA5, 0x3D, NX_DEVICERALTKEYMASK, NX_DEVICELALTKEYMASK | NX_DEVICERALTKEYMASK, kCGEventFlagMaskAlternate),
    (0x5B, 0x37, NX_DEVICELCMDKEYMASK, NX_DEVICELCMDKEYMASK | NX_DEVICERCMDKEYMASK, kCGEventFlagMaskCommand),
    (0x5C, 0x36, NX_DEVICERCMDKEYMASK, NX_DEVICELCMDKEYMASK | NX_DEVICERCMDKEYMASK, kCGEventFlagMaskCommand),
    // Fn 只有一个，没有设备相关位，直接看 SecondaryFn。
    (VK_FN, KVK_FUNCTION, kCGEventFlagMaskSecondaryFn, kCGEventFlagMaskSecondaryFn, kCGEventFlagMaskSecondaryFn),
];

/// 会让单键热键「不算裸按」的修饰键族（Fn 不算：方向键、F 键本身就带这个位）。
pub const BLOCKING_MODIFIER_MASK: CGEventFlags =
    kCGEventFlagMaskShift | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand;

/// 普通键（keyDown/keyUp）的键码 → 内部 VK。
pub fn vk_for_keycode(keycode: CGKeyCode) -> Option<u32> {
    KEYS.iter().find(|(_, kc)| *kc == keycode).map(|(vk, _)| *vk)
}

/// 内部 VK → 普通键键码。
pub fn keycode_for_vk(vk: u32) -> Option<CGKeyCode> {
    KEYS.iter()
        .find(|(v, _)| *v == vk)
        .map(|(_, kc)| *kc)
        .or_else(|| modifier_keycode_for_vk(vk))
}

/// 修饰键（flagsChanged）的键码 → 内部 VK。Caps Lock 不在表里：mac 上它只报切换、不报松开，
/// 中文用户还常用它切输入法，不支持当热键。
pub fn modifier_vk_for_keycode(keycode: CGKeyCode) -> Option<u32> {
    MODIFIERS.iter().find(|m| m.1 == keycode).map(|m| m.0)
}

fn modifier_keycode_for_vk(vk: u32) -> Option<CGKeyCode> {
    MODIFIERS.iter().find(|m| m.0 == vk).map(|m| m.1)
}

pub fn is_modifier_vk(vk: u32) -> bool {
    MODIFIERS.iter().any(|m| m.0 == vk)
}

/// 根据修饰标志判断某个修饰键此刻是否按着。`keycode` 必须是修饰键键码。
pub fn modifier_is_down(keycode: CGKeyCode, flags: CGEventFlags) -> bool {
    let Some(&(_, _, device_bit, family_device_bits, family_mask)) = MODIFIERS.iter().find(|m| m.1 == keycode) else {
        return false;
    };
    if flags & device_bit != 0 {
        return true;
    }
    // 没填设备相关位的键盘：只要同族一个设备位都没有、族掩码却在，就按「按着」算。
    flags & family_device_bits == 0 && flags & family_mask != 0
}

/// 按内部 VK 判断修饰键是否按着（给看门狗查物理状态用）。
pub fn modifier_vk_is_down(vk: u32, flags: CGEventFlags) -> Option<bool> {
    modifier_keycode_for_vk(vk).map(|kc| modifier_is_down(kc, flags))
}

/// 鼠标按钮号（kCGMouseEventButtonNumber）→ 内部 VK：2 中键、3 后退侧键、4 前进侧键。
pub fn vk_for_mouse_button(button: i64) -> Option<u32> {
    match button {
        2 => Some(0x04),
        3 => Some(0x05),
        4 => Some(0x06),
        _ => None,
    }
}

pub fn mouse_button_for_vk(vk: u32) -> Option<u32> {
    match vk {
        0x04 => Some(2),
        0x05 => Some(3),
        0x06 => Some(4),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn right_option_and_right_command_map_to_the_windows_vks_used_by_settings() {
        assert_eq!(modifier_vk_for_keycode(0x3D), Some(0xA5)); // 右 ⌥ = AltRight
        assert_eq!(modifier_vk_for_keycode(0x36), Some(0x5C)); // 右 ⌘ = MetaRight
        assert_eq!(modifier_vk_for_keycode(KVK_FUNCTION), Some(VK_FN));
        assert_eq!(modifier_vk_for_keycode(KVK_CAPS_LOCK), None);
    }

    #[test]
    fn every_key_mapping_roundtrips() {
        for &(vk, kc) in KEYS {
            assert_eq!(vk_for_keycode(kc), Some(vk), "keycode 0x{kc:X}");
            assert_eq!(keycode_for_vk(vk), Some(kc), "vk 0x{vk:X}");
        }
        for m in MODIFIERS {
            assert_eq!(keycode_for_vk(m.0), Some(m.1));
        }
    }

    #[test]
    fn keycodes_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for &(_, kc) in KEYS {
            assert!(seen.insert(kc), "duplicate keycode 0x{kc:X}");
        }
        for m in MODIFIERS {
            assert!(seen.insert(m.1), "duplicate modifier keycode 0x{:X}", m.1);
        }
    }

    #[test]
    fn modifier_sides_are_told_apart_by_device_bits() {
        // 只按着左 ⌥：右 ⌥ 不算按着
        let left_only = kCGEventFlagMaskAlternate | NX_DEVICELALTKEYMASK;
        assert!(modifier_is_down(0x3A, left_only));
        assert!(!modifier_is_down(0x3D, left_only));
        // 两侧都松开
        assert!(!modifier_is_down(0x3D, 0));
        // 不填设备位的键盘：退回族掩码
        assert!(modifier_is_down(0x3D, kCGEventFlagMaskAlternate));
        // Fn
        assert!(modifier_is_down(KVK_FUNCTION, kCGEventFlagMaskSecondaryFn));
        assert!(!modifier_is_down(KVK_FUNCTION, kCGEventFlagMaskCommand));
    }

    #[test]
    fn f21_to_f24_and_pc_only_keys_have_no_mac_keycode() {
        for vk in [0x84, 0x85, 0x86, 0x87, 0x5D, 0x13, 0x91, 0xA6, 0xA7, 0x14] {
            assert_eq!(keycode_for_vk(vk), None, "vk 0x{vk:X}");
        }
    }

    #[test]
    fn mouse_buttons_roundtrip() {
        for vk in [0x04, 0x05, 0x06] {
            let button = mouse_button_for_vk(vk).unwrap();
            assert_eq!(vk_for_mouse_button(button as i64), Some(vk));
        }
    }
}
