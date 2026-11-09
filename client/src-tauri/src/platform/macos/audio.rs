//! CoreAudio：静音默认输出设备、查询输入设备静音状态。对应 Windows 侧的 IAudioEndpointVolume。

use super::cf::{cfstring_to_string, CfOwned};
use super::ffi::*;
use std::ffi::c_void;

fn address(selector: u32, scope: u32, element: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: element,
    }
}

unsafe fn get_u32(id: AudioObjectID, addr: &AudioObjectPropertyAddress) -> Option<u32> {
    if AudioObjectHasProperty(id, addr) == 0 {
        return None;
    }
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = AudioObjectGetPropertyData(id, addr, 0, std::ptr::null(), &mut size, &mut value as *mut u32 as *mut c_void);
    (status == 0).then_some(value)
}

unsafe fn set_u32(id: AudioObjectID, addr: &AudioObjectPropertyAddress, value: u32) -> bool {
    if AudioObjectHasProperty(id, addr) == 0 {
        return false;
    }
    let mut settable: Boolean = 0;
    if AudioObjectIsPropertySettable(id, addr, &mut settable) != 0 || settable == 0 {
        return false;
    }
    AudioObjectSetPropertyData(
        id,
        addr,
        0,
        std::ptr::null(),
        std::mem::size_of::<u32>() as u32,
        &value as *const u32 as *const c_void,
    ) == 0
}

unsafe fn get_f32(id: AudioObjectID, addr: &AudioObjectPropertyAddress) -> Option<f32> {
    if AudioObjectHasProperty(id, addr) == 0 {
        return None;
    }
    let mut value: f32 = 0.0;
    let mut size = std::mem::size_of::<f32>() as u32;
    let status = AudioObjectGetPropertyData(id, addr, 0, std::ptr::null(), &mut size, &mut value as *mut f32 as *mut c_void);
    (status == 0).then_some(value)
}

unsafe fn set_f32(id: AudioObjectID, addr: &AudioObjectPropertyAddress, value: f32) -> bool {
    if AudioObjectHasProperty(id, addr) == 0 {
        return false;
    }
    let mut settable: Boolean = 0;
    if AudioObjectIsPropertySettable(id, addr, &mut settable) != 0 || settable == 0 {
        return false;
    }
    AudioObjectSetPropertyData(
        id,
        addr,
        0,
        std::ptr::null(),
        std::mem::size_of::<f32>() as u32,
        &value as *const f32 as *const c_void,
    ) == 0
}

pub fn default_device(input: bool) -> Option<AudioObjectID> {
    let selector = if input {
        kAudioHardwarePropertyDefaultInputDevice
    } else {
        kAudioHardwarePropertyDefaultOutputDevice
    };
    let addr = address(selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain);
    let id = unsafe { get_u32(kAudioObjectSystemObject, &addr)? };
    (id != kAudioObjectUnknown).then_some(id)
}

/// 设备的名称（kAudioObjectPropertyName）。
pub fn device_name(id: AudioObjectID) -> Option<String> {
    let addr = address(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain);
    unsafe {
        if AudioObjectHasProperty(id, &addr) == 0 {
            return None;
        }
        let mut value: CFStringRef = std::ptr::null();
        let mut size = std::mem::size_of::<CFStringRef>() as u32;
        let status = AudioObjectGetPropertyData(id, &addr, 0, std::ptr::null(), &mut size, &mut value as *mut CFStringRef as *mut c_void);
        if status != 0 {
            return None;
        }
        let owned = CfOwned::from_create(value)?;
        cfstring_to_string(owned.as_ptr())
    }
}

/// 设备挂在哪种连接上（kAudioDevicePropertyTransportType）：内置 `bltn`、USB `usb `、
/// 蓝牙 `blue`、纯软件驱动 `virt`……拿不到时返回 None。
pub fn transport_type(id: AudioObjectID) -> Option<u32> {
    let addr = address(kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain);
    unsafe { get_u32(id, &addr) }
}

/// 有输入流的设备（麦克风）。
pub fn input_devices() -> Vec<AudioObjectID> {
    let addr = address(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain);
    unsafe {
        let mut size: u32 = 0;
        if AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, std::ptr::null(), &mut size) != 0 {
            return Vec::new();
        }
        let count = size as usize / std::mem::size_of::<AudioObjectID>();
        let mut ids = vec![0 as AudioObjectID; count];
        if AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, std::ptr::null(), &mut size, ids.as_mut_ptr() as *mut c_void) != 0 {
            return Vec::new();
        }
        ids.into_iter()
            .filter(|id| {
                let streams = address(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput, kAudioObjectPropertyElementMain);
                let mut stream_size: u32 = 0;
                AudioObjectGetPropertyDataSize(*id, &streams, 0, std::ptr::null(), &mut stream_size) == 0 && stream_size > 0
            })
            .collect()
    }
}

/// 要检查的通道：主元素优先，没有主元素静音的设备（部分 USB / HDMI）逐通道看。
const MUTE_ELEMENTS: [u32; 3] = [kAudioObjectPropertyElementMain, 1, 2];

/// 设备在给定方向上是否静音。拿不到静音属性时返回 None。
pub fn device_muted(id: AudioObjectID, input: bool) -> Option<bool> {
    let scope = if input { kAudioDevicePropertyScopeInput } else { kAudioDevicePropertyScopeOutput };
    let mut seen = false;
    for element in MUTE_ELEMENTS {
        let addr = address(kAudioDevicePropertyMute, scope, element);
        if let Some(value) = unsafe { get_u32(id, &addr) } {
            seen = true;
            if value != 0 {
                return Some(true);
            }
            if element == kAudioObjectPropertyElementMain {
                return Some(false);
            }
        }
    }
    seen.then_some(false)
}

/// 输出静音前保存的状态，用于原样还原。
#[derive(Debug, Clone, Copy)]
pub enum SavedOutputState {
    /// 走的是 Mute 属性：记下原来是否静音
    Mute { device: AudioObjectID, was_muted: bool },
    /// 设备不支持 Mute，只能把音量调成 0：记下原来的各通道音量
    Volume { device: AudioObjectID, volumes: [Option<f32>; 3] },
}

/// 静音默认输出设备。返回之前的状态（还原用）。
pub fn mute_default_output() -> Result<SavedOutputState, String> {
    let device = default_device(false).ok_or("no default output device")?;
    // 1. Mute 属性（主元素或各通道）
    let mut mute_elements = Vec::new();
    for element in MUTE_ELEMENTS {
        let addr = address(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput, element);
        if unsafe { get_u32(device, &addr) }.is_some() {
            mute_elements.push(element);
        }
    }
    if !mute_elements.is_empty() {
        let was_muted = device_muted(device, false).unwrap_or(false);
        let mut any = false;
        for element in &mute_elements {
            let addr = address(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput, *element);
            any |= unsafe { set_u32(device, &addr, 1) };
        }
        if any || was_muted {
            return Ok(SavedOutputState::Mute { device, was_muted });
        }
    }
    // 2. 退回音量：记下各通道音量后设 0
    let mut volumes = [None; 3];
    let mut any = false;
    for (slot, element) in MUTE_ELEMENTS.iter().enumerate() {
        let addr = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, *element);
        if let Some(volume) = unsafe { get_f32(device, &addr) } {
            volumes[slot] = Some(volume);
            any |= unsafe { set_f32(device, &addr, 0.0) };
        }
    }
    if any {
        Ok(SavedOutputState::Volume { device, volumes })
    } else {
        Err("default output device supports neither mute nor volume control".to_string())
    }
}

pub fn restore_output(saved: SavedOutputState) -> bool {
    match saved {
        SavedOutputState::Mute { device, was_muted } => {
            let mut any = false;
            for element in MUTE_ELEMENTS {
                let addr = address(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput, element);
                any |= unsafe { set_u32(device, &addr, u32::from(was_muted)) };
            }
            any
        }
        SavedOutputState::Volume { device, volumes } => {
            let mut any = false;
            for (slot, element) in MUTE_ELEMENTS.iter().enumerate() {
                if let Some(volume) = volumes[slot] {
                    let addr = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, *element);
                    any |= unsafe { set_f32(device, &addr, volume) };
                }
            }
            any
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourcc_matches_coreaudio_constants() {
        assert_eq!(kAudioHardwarePropertyDefaultOutputDevice, 0x644F_7574); // 'dOut'
        assert_eq!(kAudioDevicePropertyMute, 0x6D75_7465); // 'mute'
        assert_eq!(kAudioDevicePropertyTransportType, 0x7472_616E); // 'tran'
    }

    #[test]
    fn default_devices_are_queryable_without_side_effects() {
        // 没有声卡的 CI 机器上可能拿不到；只要别崩。
        if let Some(id) = default_device(false) {
            let _ = device_name(id);
            let _ = device_muted(id, false);
        }
        for id in input_devices() {
            let _ = transport_type(id);
        }
    }
}
