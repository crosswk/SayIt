//! 界面语言：系统显示语言读取 + `ui.language` 偏好解析。
//!
//! 为什么这件事必须有 Rust 侧的一份：**托盘菜单是原生菜单、在 Rust 建**
//! （commands/tray.rs 的 build_tray），要它开机就是正确语言，就不能等前端起来再告诉它。
//!
//! 为什么不加 `sys-locale` 依赖：`Win32_Globalization` 已经在 Cargo.toml 的
//! windows feature 列表里，需要的 API 直接可用。这是 Windows 独占应用，
//! 没必要为一次读取多背一个 crate。
//!
//! ⚠️ **不要和 `commands/system.rs` 的 `get_system_locale()` 合并**，那个用的是
//! `GetUserDefaultLocaleName`（**区域格式**，如日期货币怎么写），报给诊断用；
//! 这里用 `GetUserDefaultUILanguage`（**显示语言**，Windows 界面本身什么语言）。
//! 两者可以不一致 —— 英文版 Windows 把区域设成中国是很常见的组合。
//! 界面语言只能跟显示语言，跟区域格式会把英文用户判成中文。

/// 受支持的界面语言。取值与前端 `Locale` 一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    ZhCn,
    En,
}

impl Lang {
    /// 前端 `Locale` 用的标签，也是这个模块对外的唯一字符串形态。
    pub fn tag(self) -> &'static str {
        match self {
            Lang::ZhCn => "zh-CN",
            Lang::En => "en",
        }
    }
}

/// Windows 主语言 ID（`PRIMARYLANGID`）→ 界面语言。
///
/// 任何中文变体（简/繁/港澳台）都判为简体：他们现在看到的就是简体界面，
/// 推到英文属于倒退。其余一律英文。
#[cfg_attr(not(windows), allow(dead_code))]
fn lang_from_primary_id(primary_id: u16) -> Lang {
    const LANG_CHINESE: u16 = 0x04;
    if primary_id == LANG_CHINESE {
        Lang::ZhCn
    } else {
        Lang::En
    }
}

/// 系统显示语言。取不到时按英文处理（英文是更安全的默认：看不懂中文的人更多）。
#[cfg(windows)]
pub fn system_ui_lang() -> Lang {
    use windows::Win32::Globalization::GetUserDefaultUILanguage;

    let langid = unsafe { GetUserDefaultUILanguage() };
    if langid == 0 {
        return Lang::En;
    }
    lang_from_primary_id(langid & 0x03ff)
}

/// macOS：「系统设置 → 通用 → 语言与地区」里排第一的首选语言。
///
/// 不能读 `LANG`：从 Finder / Dock / 登录项启动的 App 一般没有这个环境变量，
/// 中文系统会被误判成英文。
#[cfg(target_os = "macos")]
pub fn system_ui_lang() -> Lang {
    lang_from_language_tag(
        crate::platform::macos::sysinfo::preferred_languages()
            .first()
            .map(String::as_str)
            .unwrap_or(""),
    )
}

/// `zh-Hans-CN` / `zh_CN` / `zh-Hant-TW` → 中文；其它 → 英文。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn lang_from_language_tag(tag: &str) -> Lang {
    if tag.to_ascii_lowercase().starts_with("zh") {
        Lang::ZhCn
    } else {
        Lang::En
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn system_ui_lang() -> Lang {
    // 其它平台目前只有 cargo test 会走到。
    match std::env::var("LANG") {
        Ok(value) if value.to_ascii_lowercase().starts_with("zh") => Lang::ZhCn,
        _ => Lang::En,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_primary_id_maps_to_simplified() {
        assert_eq!(lang_from_primary_id(0x04), Lang::ZhCn);
    }

    #[test]
    fn other_primary_ids_map_to_english() {
        // 0x09 = 英语，0x11 = 日语，0x12 = 韩语，0x07 = 德语
        for id in [0x09, 0x11, 0x12, 0x07, 0x00] {
            assert_eq!(lang_from_primary_id(id), Lang::En, "primary_id={id:#x}");
        }
    }

    #[test]
    fn mac_language_tags_map_to_ui_languages() {
        assert_eq!(lang_from_language_tag("zh-Hans-CN"), Lang::ZhCn);
        assert_eq!(lang_from_language_tag("zh-Hant-TW"), Lang::ZhCn);
        assert_eq!(lang_from_language_tag("en-CN"), Lang::En);
        assert_eq!(lang_from_language_tag(""), Lang::En);
    }

    #[test]
    fn tags_match_frontend_locale_values() {
        assert_eq!(Lang::ZhCn.tag(), "zh-CN");
        assert_eq!(Lang::En.tag(), "en");
    }
}
