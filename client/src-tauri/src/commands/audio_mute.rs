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
    get_device_string_property(device, &PKEY_Device_FriendlyName)
}

#[cfg(windows)]
unsafe fn get_device_string_property(
    device: &windows::Win32::Media::Audio::IMMDevice,
    key: &windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY,
) -> Result<String, String> {
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc,
    };
    use windows::Win32::System::Com::{CoTaskMemFree, STGM_READ};

    let store = device
        .OpenPropertyStore(STGM_READ)
        .map_err(|e| format!("OpenPropertyStore: {}", e))?;
    let mut value = store
        .GetValue(key)
        .map_err(|e| format!("GetValue({:?},{}): {}", key.fmtid, key.pid, e))?;

    let name_result = (|| -> Result<String, String> {
        let ptr = PropVariantToStringAlloc(&value)
            .map_err(|e| format!("PropVariantToStringAlloc: {}", e))?;
        let text = ptr
            .to_string()
            .map_err(|e| format!("property to_string: {}", e));
        CoTaskMemFree(Some(ptr.0.cast()));
        text
    })();
    let clear_result = PropVariantClear(&mut value)
        .map_err(|e| format!("PropVariantClear: {}", e));
    clear_result?;
    name_result
}

// ─────────────────────────────────────────────────────────────────────────
// 录音端点清单：前端靠它判断「系统默认」是不是虚拟设备
// ─────────────────────────────────────────────────────────────────────────

/// 一个处于启用状态的录音端点。
///
/// `name` 是 Windows 的端点友好名（`耳机式麦克风 (Plantronics Blackwire 5220 Series)`），
/// 与 Chromium 的 MediaDeviceInfo.label 去掉结尾 `(vid:pid)` 后相同，前端按它对应。
/// macOS 上是 CoreAudio 的设备名，与 WebKit 的 label 相同（静音查询也按它对应）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEndpoint {
    pub name: String,
    /// 端点所属音频设备挂在哪条总线上：USB / HDAUDIO / INTELAUDIO / BTHENUM / ROOT ……
    /// macOS 上是 CoreAudio 的连接类型四字符码：bltn / usb / blue / virt ……（只用于日志和排查）
    pub enumerator: String,
    pub is_virtual: bool,
    pub is_default: bool,
    pub is_default_communications: bool,
}

/// 按总线判断是不是虚拟设备，**不按设备名**。
///
/// 真实麦克风一定挂在某条硬件总线下（USB、HD Audio、英特尔智音、蓝牙）；VB-Cable、
/// Voicemeeter 这类纯软件驱动没有硬件可挂，由系统直接在根上枚举，总线名是 `ROOT`。
/// 本机实测：CABLE Output 是 ROOT，其余五个真实麦克风是 USB / INTELAUDIO / HDAUDIO。
///
/// 刻意没把 `SWD`（软件设备 API）算进来：它也是软件枚举，但没有实测样本，
/// 误判的代价不对称 —— 把真麦克风当成虚拟会让 SayIt 跳过用户要用的设备，
/// 漏判只是退回原来「跟随系统默认」的行为。
/// 「立体声混音」这类回采端点挂在真实声卡下，这条判据认不出来；它默认是禁用的，暂不处理。
#[cfg(any(windows, test))]
fn is_virtual_enumerator(enumerator: &str) -> bool {
    enumerator.trim().eq_ignore_ascii_case("ROOT")
}

/// macOS 的 kAudioDeviceTransportTypeVirtual（`virt`）。
#[cfg(any(target_os = "macos", test))]
const MAC_TRANSPORT_VIRTUAL: u32 = u32::from_be_bytes(*b"virt");

/// macOS 版的同一条判据：按 CoreAudio 报的连接类型，不按名字。
///
/// BlackHole、Loopback、Teams / Zoom 自带的虚拟音频设备都报 `virt`；内置麦克风是 `bltn`、
/// USB 是 `usb `、蓝牙是 `blue`、iPhone 连续互通是 `ccwl`。
/// 聚合设备（`grup` / `fgrp`）刻意不算：它是用户在「音频 MIDI 设置」里自己把真实设备拼起来的，
/// 选它多半是有意为之；拿不到类型（0）也不算，理由同 Windows 那条（误判比漏判代价大）。
#[cfg(any(target_os = "macos", test))]
fn is_virtual_transport(transport: u32) -> bool {
    transport == MAC_TRANSPORT_VIRTUAL
}

/// 把四字符码转成可读文字，写进 `enumerator` 方便看日志。拿不到类型时是空串。
#[cfg(any(target_os = "macos", test))]
fn fourcc_text(code: u32) -> String {
    if code == 0 {
        return String::new();
    }
    code.to_be_bytes()
        .iter()
        .map(|b| if b.is_ascii_graphic() || *b == b' ' { *b as char } else { '?' })
        .collect::<String>()
        .trim_end()
        .to_string()
}

#[cfg(target_os = "macos")]
fn query_capture_endpoints_macos() -> Vec<CaptureEndpoint> {
    use crate::platform::macos::audio;
    let default_input = audio::default_device(true);
    audio::input_devices()
        .into_iter()
        .filter_map(|id| {
            let name = audio::device_name(id)?;
            let transport = audio::transport_type(id).unwrap_or(0);
            Some(CaptureEndpoint {
                name,
                enumerator: fourcc_text(transport),
                is_virtual: is_virtual_transport(transport),
                is_default: default_input == Some(id),
                // macOS 没有单独的「默认通信设备」
                is_default_communications: false,
            })
        })
        .collect()
}

#[cfg(windows)]
unsafe fn endpoint_id(device: &windows::Win32::Media::Audio::IMMDevice) -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    let ptr = device.GetId().ok()?;
    let id = ptr.to_string().ok();
    CoTaskMemFree(Some(ptr.0.cast()));
    id
}

#[cfg(windows)]
unsafe fn query_capture_endpoints() -> Result<Vec<CaptureEndpoint>, String> {
    use windows::core::GUID;
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    // PKEY_Device_EnumeratorName。windows crate 只以 DEVPROPKEY 形式导出它，
    // IPropertyStore 要的是 PROPERTYKEY，两者 fmtid/pid 相同，这里直接写出来。
    const PKEY_DEVICE_ENUMERATOR_NAME: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 24,
    };

    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<Vec<CaptureEndpoint>, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance MMDeviceEnumerator: {}", e))?;
        let default_console = enumerator
            .GetDefaultAudioEndpoint(eCapture, eConsole)
            .ok()
            .and_then(|device| endpoint_id(&device));
        let default_comms = enumerator
            .GetDefaultAudioEndpoint(eCapture, eCommunications)
            .ok()
            .and_then(|device| endpoint_id(&device));

        let devices = enumerator
            .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("EnumAudioEndpoints(eCapture): {}", e))?;
        let count = devices
            .GetCount()
            .map_err(|e| format!("IMMDeviceCollection.GetCount: {}", e))?;

        let mut endpoints = Vec::new();
        for index in 0..count {
            let Ok(device) = devices.Item(index) else { continue };
            let Ok(name) = get_device_friendly_name(&device) else { continue };
            let enumerator_name =
                get_device_string_property(&device, &PKEY_DEVICE_ENUMERATOR_NAME).unwrap_or_default();
            let id = endpoint_id(&device);
            endpoints.push(CaptureEndpoint {
                name,
                is_virtual: is_virtual_enumerator(&enumerator_name),
                enumerator: enumerator_name,
                is_default: id.is_some() && id == default_console,
                is_default_communications: id.is_some() && id == default_comms,
            });
        }
        Ok(endpoints)
    })();

    if need_co_uninit {
        CoUninitialize();
    }

    result
}

/// 列出启用中的录音端点，标出哪个是系统默认、哪个是虚拟设备。
/// 失败或其他平台一律返回空表：前端拿到空表就照旧跟随系统默认，不做任何替换。
#[tauri::command]
pub fn list_capture_endpoints() -> Vec<CaptureEndpoint> {
    #[cfg(windows)]
    unsafe {
        match query_capture_endpoints() {
            Ok(endpoints) => endpoints,
            Err(e) => {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [audio_devices] list_capture_endpoints failed: {}",
                    e
                ));
                Vec::new()
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        query_capture_endpoints_macos()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Vec::new()
    }
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
    use super::{fourcc_text, is_virtual_enumerator, is_virtual_transport, normalize_mic_label};

    #[test]
    fn only_virt_transport_counts_as_virtual_on_macos() {
        let code = |s: &[u8; 4]| u32::from_be_bytes(*s);
        assert!(is_virtual_transport(code(b"virt")));
        // 内置、USB、蓝牙、连续互通、聚合设备、拿不到类型：都不算
        for real in [b"bltn", b"usb ", b"blue", b"ccwl", b"grup", b"fgrp"] {
            assert!(!is_virtual_transport(code(real)));
        }
        assert!(!is_virtual_transport(0));
        assert_eq!(fourcc_text(code(b"usb ")), "usb");
        assert_eq!(fourcc_text(code(b"virt")), "virt");
        assert_eq!(fourcc_text(0), "");
    }

    #[test]
    fn only_root_enumerated_endpoints_count_as_virtual() {
        // 本机实测值：CABLE Output 是 ROOT，真实麦克风是 USB / INTELAUDIO / HDAUDIO。
        assert!(is_virtual_enumerator("ROOT"));
        assert!(is_virtual_enumerator(" root "));
        for real in ["USB", "INTELAUDIO", "HDAUDIO", "BTHENUM", "BTHHFENUM", ""] {
            assert!(!is_virtual_enumerator(real), "{real} must not be treated as virtual");
        }
        // SWD 刻意不算（见 is_virtual_enumerator 的注释）
        assert!(!is_virtual_enumerator("SWD"));
    }

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
