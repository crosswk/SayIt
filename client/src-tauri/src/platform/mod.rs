//! 平台相关的系统集成。
//!
//! Windows 的实现目前仍分散在 keyboard / inject / context / window 等模块里的
//! `#[cfg(windows)]` 分支中（历史原因，暂不搬动，避免在无法编译 Windows 的环境里改动它）。
//! macOS 的实现集中在 `macos` 子模块，各业务模块在自己的 `#[cfg(target_os = "macos")]`
//! 分支里调用它。

#[cfg(target_os = "macos")]
pub mod macos;
