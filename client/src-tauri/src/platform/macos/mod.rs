//! macOS 系统集成。
//!
//! - `ffi`：CoreFoundation / CoreGraphics / Accessibility / Carbon / CoreAudio 的 C 声明
//! - `cf`：CF 对象所有权与字符串互转
//! - `ax`：Accessibility（对应 Windows 的 UI Automation）
//! - `keycodes`：macOS 键码 ↔ 内部键 ID（沿用 Windows VK）
//! - `appkit`：NSWorkspace / NSPasteboard / NSWindow（objc2）
//! - `audio`：CoreAudio 静音
//! - `sysinfo`：系统版本、内存、语言
//! - `permissions`：辅助功能 / 麦克风授权状态与引导

// 平台封装层：部分接口给诊断与后续功能预留，未全部被调用。
#![allow(dead_code)]

pub mod appkit;
pub mod audio;
pub mod ax;
pub mod cf;
pub mod ffi;
pub mod keycodes;
pub mod permissions;
pub mod sysinfo;
