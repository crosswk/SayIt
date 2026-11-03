//! 系统信息：版本、物理内存、进程内存、首选语言与区域。

use super::cf::{cfarray_strings, cfstring_to_string, CfOwned};
use super::ffi::{CFLocaleCopyCurrent, CFLocaleCopyPreferredLanguages, CFLocaleGetIdentifier};
use std::ffi::{c_void, CString};

fn sysctl_string(name: &str) -> Option<String> {
    let cname = CString::new(name).ok()?;
    let mut size: libc::size_t = 0;
    unsafe {
        if libc::sysctlbyname(cname.as_ptr(), std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) != 0 || size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size];
        if libc::sysctlbyname(cname.as_ptr(), buf.as_mut_ptr() as *mut c_void, &mut size, std::ptr::null_mut(), 0) != 0 {
            return None;
        }
        let nul = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        buf.truncate(nul);
        Some(String::from_utf8_lossy(&buf).into_owned())
    }
}

fn sysctl_u64(name: &str) -> Option<u64> {
    let cname = CString::new(name).ok()?;
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>() as libc::size_t;
    let rc = unsafe {
        libc::sysctlbyname(cname.as_ptr(), &mut value as *mut u64 as *mut c_void, &mut size, std::ptr::null_mut(), 0)
    };
    (rc == 0).then_some(value)
}

/// 形如 "macOS 26.6.2 (25G83)"。
pub fn os_version() -> String {
    let version = sysctl_string("kern.osproductversion").unwrap_or_default();
    let build = sysctl_string("kern.osversion").unwrap_or_default();
    match (version.is_empty(), build.is_empty()) {
        (false, false) => format!("macOS {version} ({build})"),
        (false, true) => format!("macOS {version}"),
        _ => "macOS".to_string(),
    }
}

/// 主版本号（14 = Sonoma、15 = Sequoia、26 = Tahoe）。
pub fn os_major_version() -> Option<u32> {
    sysctl_string("kern.osproductversion")?.split('.').next()?.parse().ok()
}

pub fn total_memory_mb() -> u64 {
    sysctl_u64("hw.memsize").map(|b| b / (1024 * 1024)).unwrap_or(0)
}

/// CPU 型号，例如 "Apple M3 Pro"。
pub fn cpu_brand() -> String {
    sysctl_string("machdep.cpu.brand_string").unwrap_or_default()
}

#[repr(C)]
#[derive(Default)]
struct RusageInfoV2 {
    ri_uuid: [u8; 16],
    ri_user_time: u64,
    ri_system_time: u64,
    ri_pkg_idle_wkups: u64,
    ri_interrupt_wkups: u64,
    ri_pageins: u64,
    ri_wired_size: u64,
    ri_resident_size: u64,
    ri_phys_footprint: u64,
    ri_proc_start_abstime: u64,
    ri_proc_exit_abstime: u64,
    ri_child_user_time: u64,
    ri_child_system_time: u64,
    ri_child_pkg_idle_wkups: u64,
    ri_child_interrupt_wkups: u64,
    ri_child_pageins: u64,
    ri_child_elapsed_abstime: u64,
    ri_diskio_bytesread: u64,
    ri_diskio_byteswritten: u64,
}

const RUSAGE_INFO_V2: i32 = 2;

extern "C" {
    fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut c_void) -> i32;
}

/// 进程的物理内存占用（phys_footprint，与「活动监视器」的「内存」列一致），MB。
pub fn process_memory_mb() -> u64 {
    let mut info = RusageInfoV2::default();
    let rc = unsafe { proc_pid_rusage(std::process::id() as i32, RUSAGE_INFO_V2, &mut info as *mut RusageInfoV2 as *mut c_void) };
    if rc == 0 {
        info.ri_phys_footprint / (1024 * 1024)
    } else {
        0
    }
}

/// 用户在「系统设置 → 通用 → 语言与地区」里排的首选语言，例如 ["zh-Hans-CN", "en-CN"]。
///
/// 不能用 `LANG` 环境变量：从 Finder / Dock / 登录项启动的 App 一般没有这个变量。
pub fn preferred_languages() -> Vec<String> {
    unsafe {
        match CfOwned::from_create(CFLocaleCopyPreferredLanguages()) {
            Some(array) => cfarray_strings(array.as_ptr()),
            None => Vec::new(),
        }
    }
}

/// 区域格式，BCP-47 写法（`zh_CN` → `zh-CN`），对应 Windows 的 GetUserDefaultLocaleName。
pub fn locale_identifier() -> Option<String> {
    unsafe {
        let locale = CfOwned::from_create(CFLocaleCopyCurrent())?;
        let id = cfstring_to_string(CFLocaleGetIdentifier(locale.as_ptr()))?;
        // "zh_CN@calendar=gregorian" 这类带关键字的去掉后缀
        let base = id.split('@').next().unwrap_or(&id).replace('_', "-");
        (!base.is_empty()).then_some(base)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_version_and_memory_are_reported() {
        assert!(os_version().starts_with("macOS"));
        assert!(os_major_version().unwrap_or(0) >= 11);
        assert!(total_memory_mb() > 0);
        assert!(process_memory_mb() > 0);
    }

    #[test]
    fn locale_information_is_available() {
        assert!(!preferred_languages().is_empty());
        assert!(locale_identifier().is_some());
    }
}
