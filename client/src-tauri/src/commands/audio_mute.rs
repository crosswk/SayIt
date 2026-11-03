//! 录音期间静音系统输出（默认扬声器）——防止外放的声音被麦克风回采。
//!
//! 只在采集期间静音，松开热键立即恢复到用户原本的静音状态：
//! - `mute_system_output`：记录当前默认输出设备的静音状态，然后静音。
//! - `restore_system_output`：恢复到之前记录的状态（若用户本来就是静音，则保持静音）。
//!
//! 用「保存/恢复原状态」而非「无脑取消静音」，避免录完后把用户原本的静音误开成有声。

use serde::Serialize;

#[cfg(any(windows, target_os = "macos"))]
use once_cell::sync::Lazy;
#[cfg(any(windows, target_os = "macos"))]
use std::sync::Mutex;

/// 查询麦克风静音状态的结果。
/// - `matched`：是否成功定位到目标设备（默认设备总能定位；指定设备需按名字唯一匹配到）。
///   为 false 时前端不应据此判定，应退回基于音频信号的检测。
/// - `muted`：目标设备在系统层面是否被静音。
#[derive(Debug, Clone, Serialize)]
pub struct MicMuteState {
    pub matched: bool,
    pub muted: bool,
}

/// 保存的「静音前的原始状态」。None 表示当前未处于我们施加的静音中。
#[cfg(windows)]
static SAVED_MUTE_STATE: Lazy<Mutex<Option<bool>>> = Lazy::new(|| Mutex::new(None));

/// macOS：静音前默认输出设备的状态（Mute 属性或各通道音量）。None = 当前不在我们施加的静音中。
#[cfg(target_os = "macos")]
static SAVED_OUTPUT_STATE: Lazy<Mutex<Option<crate::platform::macos::audio::SavedOutputState>>> =
    Lazy::new(|| Mutex::new(None));

/// 获取默认渲染端点（扬声器）的音量控制接口，并在其上执行闭包。
#[cfg(windows)]
unsafe fn with_endpoint_volume<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume) -> Result<R, String>,
{
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<R, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance MMDeviceEnumerator: {}", e))?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint: {}", e))?;

        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioEndpointVolume: {}", e))?;

        f(&endpoint)
    })();

    if need_co_uninit {
        CoUninitialize();
    }

    result
}

/// 记录当前默认输出设备静音状态并将其静音。
/// 返回 true 表示已处理（Windows），false 表示非 Windows 平台跳过。
#[tauri::command]
pub fn mute_system_output() -> Result<bool, String> {
    #[cfg(windows)]
    unsafe {
        with_endpoint_volume(|ep| {
            let was_muted = ep
                .GetMute()
                .map_err(|e| format!("GetMute: {}", e))?
                .as_bool();

            // 仅在首次静音时保存原状态，避免重复调用覆盖真实原值
            {
                let mut saved = SAVED_MUTE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if saved.is_none() {
                    *saved = Some(was_muted);
                }
            }

            if !was_muted {
                ep.SetMute(true, std::ptr::null())
                    .map_err(|e| format!("SetMute(true): {}", e))?;
            }

            crate::commands::system::write_log_line(&format!(
                "[RUST] [audio_mute] muted output (prev_muted={})",
                was_muted
            ));
            Ok(true)
        })
    }
    #[cfg(target_os = "macos")]
    {
        let mut saved = SAVED_OUTPUT_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 仅在首次静音时保存原状态，避免重复调用覆盖真实原值
        if saved.is_some() {
            return Ok(true);
        }
        let state = crate::platform::macos::audio::mute_default_output()?;
        crate::commands::system::write_log_line(&format!("[RUST] [audio_mute] muted output (saved={:?})", state));
        *saved = Some(state);
        Ok(true)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Ok(false)
    }
}

/// 恢复到 `mute_system_output` 之前记录的静音状态。
/// 若没有记录（未曾静音），则不做任何操作。
#[tauri::command]
pub fn restore_system_output() -> Result<bool, String> {
    #[cfg(windows)]
    unsafe {
        let saved = {
            let mut s = SAVED_MUTE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            s.take()
        };

        match saved {
            Some(prev) => with_endpoint_volume(|ep| {
                ep.SetMute(windows::Win32::Foundation::BOOL::from(prev), std::ptr::null())
                    .map_err(|e| format!("SetMute restore: {}", e))?;
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [audio_mute] restored output (mute={})",
                    prev
                ));
                Ok(true)
            }),
            None => Ok(false),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let saved = SAVED_OUTPUT_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        match saved {
            Some(state) => {
                let restored = crate::platform::macos::audio::restore_output(state);
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [audio_mute] restored output (restored={} saved={:?})",
                    restored, state
                ));
                Ok(restored)
            }
            None => Ok(false),
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Ok(false)
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 麦克风静音状态查询
// ─────────────────────────────────────────────────────────────────────────

/// 浏览器会给默认设备名加上 Default/Communications 前缀；Windows 端点友好名没有。
/// 这里只做名字规范化以定位本次实际打开的端点，不参与静音与否的判断。
fn normalize_mic_label(label: &str) -> String {
    let trimmed = label.trim();
    let lower = trimmed.to_lowercase();
    let without_route_prefix = ["default", "communications", "默认值", "默认", "通信"]
        .iter()
        .find_map(|prefix| {
            let prefix_lower = prefix.to_lowercase();
            lower.starts_with(&prefix_lower).then(|| {
                trimmed[prefix.len()..].trim_start_matches(|c: char| {
                    c.is_whitespace() || matches!(c, '-' | '–' | '—' | ':')
                })
            })
        })
        .unwrap_or(trimmed);

    without_route_prefix
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(windows)]
unsafe fn get_device_friendly_name(
    device: &windows::Win32::Media::Audio::IMMDevice,
) -> Result<String, String> {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc,
    };
    use windows::Win32::System::Com::{CoTaskMemFree, STGM_READ};

    let store = device
        .OpenPropertyStore(STGM_READ)
        .map_err(|e| format!("OpenPropertyStore: {}", e))?;
    let mut value = store
        .GetValue(&PKEY_Device_FriendlyName)
        .map_err(|e| format!("GetValue(PKEY_Device_FriendlyName): {}", e))?;

    let name_result = (|| -> Result<String, String> {
        let ptr = PropVariantToStringAlloc(&value)
            .map_err(|e| format!("PropVariantToStringAlloc: {}", e))?;
        let text = ptr
            .to_string()
            .map_err(|e| format!("FriendlyName to_string: {}", e));
        CoTaskMemFree(Some(ptr.0.cast()));
        text
    })();
    let clear_result = PropVariantClear(&mut value)
        .map_err(|e| format!("PropVariantClear: {}", e));
    clear_result?;
    name_result
}

/// 查询采集设备的静音状态。
///
/// 前端传入 getUserMedia 实际打开的 MediaStreamTrack.label。这里枚举 Windows 采集端点，
/// 按规范化后的友好名唯一匹配，再读取该端点真实的 IAudioEndpointVolume::GetMute 状态。
/// 找不到或出现同名多个端点时返回 matched=false，绝不猜测静音。
#[cfg(windows)]
unsafe fn query_mic_mute(label: Option<&str>) -> Result<MicMuteState, String> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<MicMuteState, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance MMDeviceEnumerator: {}", e))?;

        let device: IMMDevice = if let Some(target_label) =
            label.map(str::trim).filter(|s| !s.is_empty())
        {
            let target = normalize_mic_label(target_label);
            let devices = enumerator
                .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
                .map_err(|e| format!("EnumAudioEndpoints(eCapture): {}", e))?;
            let count = devices
                .GetCount()
                .map_err(|e| format!("IMMDeviceCollection.GetCount: {}", e))?;
            let mut matched: Option<IMMDevice> = None;

            for index in 0..count {
                let candidate = devices
                    .Item(index)
                    .map_err(|e| format!("IMMDeviceCollection.Item({}): {}", index, e))?;
                let friendly_name = match get_device_friendly_name(&candidate) {
                    Ok(name) => name,
                    Err(_) => continue,
                };
                if normalize_mic_label(&friendly_name) != target {
                    continue;
                }
                if matched.is_some() {
                    // 同名设备无法可靠区分；宁可回退信号检测，也不查询错端点。
                    return Ok(MicMuteState {
                        matched: false,
                        muted: false,
                    });
                }
                matched = Some(candidate);
            }

            match matched {
                Some(device) => device,
                None => {
                    return Ok(MicMuteState {
                        matched: false,
                        muted: false,
                    })
                }
            }
        } else {
            enumerator
                .GetDefaultAudioEndpoint(eCapture, eConsole)
                .map_err(|e| format!("GetDefaultAudioEndpoint(eCapture): {}", e))?
        };

        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioEndpointVolume: {}", e))?;
        let muted = endpoint
            .GetMute()
            .map_err(|e| format!("GetMute: {}", e))?
            .as_bool();
        Ok(MicMuteState { matched: true, muted })
    })();

    if need_co_uninit {
        CoUninitialize();
    }

    result
}

/// 查询麦克风是否被系统静音。
/// `device_label`：本次 MediaStreamTrack 实际打开的设备名；传 None/空才回退查询系统默认麦克风。
/// 返回 `matched=false` 时表示无法可靠定位设备（如选了特定设备但同名多个），前端应退回信号检测。
#[tauri::command]
pub fn get_mic_mute_state(device_label: Option<String>) -> MicMuteState {
    #[cfg(windows)]
    unsafe {
        match query_mic_mute(device_label.as_deref()) {
            Ok(state) => state,
            Err(e) => {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [audio_mute] get_mic_mute_state failed: {}",
                    e
                ));
                MicMuteState { matched: false, muted: false }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        query_mic_mute_macos(device_label.as_deref())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = device_label;
        MicMuteState { matched: false, muted: false }
    }
}

/// macOS：按名字唯一匹配输入设备，读输入方向的 Mute 属性。
/// 多数内置麦克风没有 Mute 属性，这时返回 matched=false，前端退回信号检测。
#[cfg(target_os = "macos")]
fn query_mic_mute_macos(label: Option<&str>) -> MicMuteState {
    use crate::platform::macos::audio;
    let not_matched = MicMuteState { matched: false, muted: false };
    let device = match label.map(str::trim).filter(|s| !s.is_empty()) {
        Some(target_label) => {
            let target = normalize_mic_label(target_label);
            let mut matched = None;
            for id in audio::input_devices() {
                let Some(name) = audio::device_name(id) else { continue };
                if normalize_mic_label(&name) != target {
                    continue;
                }
                if matched.is_some() {
                    // 同名设备无法可靠区分；宁可回退信号检测，也不查询错设备。
                    return not_matched;
                }
                matched = Some(id);
            }
            match matched {
                Some(id) => id,
                None => return not_matched,
            }
        }
        None => match audio::default_device(true) {
            Some(id) => id,
            None => return not_matched,
        },
    };
    match audio::device_muted(device, true) {
        Some(muted) => MicMuteState { matched: true, muted },
        None => not_matched,
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_mic_label;

    #[test]
    fn browser_route_prefix_does_not_change_endpoint_identity() {
        assert_eq!(
            normalize_mic_label("Default - Headset Microphone (Plantronics Blackwire 5220 Series)"),
            normalize_mic_label("Headset Microphone (Plantronics Blackwire 5220 Series)")
        );
        assert_eq!(
            normalize_mic_label("Communications: USB Microphone"),
            "usb microphone"
        );
    }

    #[test]
    fn ordinary_device_name_is_preserved_for_matching() {
        assert_eq!(normalize_mic_label("  Studio   Mic  "), "studio mic");
    }
}
