// 「跟随系统默认」时该打开哪个麦克风。
//
// 起因（2026-11-07 本机日志）：耳麦拔掉后 Windows 把默认录音设备换成了
// `CABLE Output (VB-Audio Virtual Cable)`，SayIt 照着跟过去，录到的全是 0，
// 只弹了一句「未检测到声音」。用户没改过任何设置，从他的角度就是"它自己选到了虚拟声卡"。
//
// 规则：
//  - 用户在下拉里**明确选了**某个设备 → 原样使用，哪怕它是虚拟设备（有人就是要从
//    虚拟声卡录：Voicemeeter、NVIDIA Broadcast 之类的处理链）。
//  - 跟随系统默认、而系统默认是**虚拟设备** → 改用一个真实麦克风：
//    上次真正录到过人声的那个 → 系统「默认通信设备」（如果是真实的）→ 第一个真实麦克风。
//  - 找不到任何真实麦克风、或者对不上号 → 维持原样跟随系统默认，不猜。
//
// 「是不是虚拟设备」由原生层判断，**不按名字**，所以不需要为每个虚拟声卡产品维护名单：
// Windows 看设备挂在哪条总线上（audio_mute.rs 的 is_virtual_enumerator），
// macOS 看 CoreAudio 报的连接类型（is_virtual_transport，BlackHole 之类报 `virt`）。

import { invoke } from '@tauri-apps/api/core'
import { isPseudoInputDevice, realInputEndpoints, stripUsbIds, type MicEndpoint } from './audio'
import { getSetting, setSetting } from './store'

/** 原生层 list_capture_endpoints 的一项。 */
export interface CaptureEndpoint {
  name: string
  enumerator: string
  isVirtual: boolean
  isDefault: boolean
  isDefaultCommunications: boolean
}

export type MicPlanReason =
  /** 用户明确选了设备 */
  | 'explicit'
  /** 跟随系统默认，且默认是真实设备（或无从判断） */
  | 'default'
  /** 系统默认是虚拟设备，已改用真实麦克风 */
  | 'virtual_avoided'
  /** 系统默认是虚拟设备，但没有可用的真实麦克风 */
  | 'virtual_no_alternative'
  /** 系统默认是虚拟设备，但网页侧的设备名是空的，对不上号（录音开流后会再判一次） */
  | 'unmapped'

export interface MicPlan {
  /** 交给 getUserMedia 的 deviceId；空串 = 跟随系统默认 */
  deviceId: string
  reason: MicPlanReason
  /** 被跳过的虚拟设备名（reason = virtual_avoided / virtual_no_alternative / unmapped 时有值） */
  avoidedName: string
  /** 实际改用的麦克风名（reason = virtual_avoided 时有值） */
  chosenName: string
}

/** 记住「上次真正录到人声的真实麦克风」。存的是规范化后的名字，不是 deviceId：
 *  Chromium 的 deviceId 按 origin 加盐，清 WebView 缓存就全变号，名字更稳。 */
const LAST_GOOD_MIC_KEY = 'micLastGoodDevice'

/**
 * 把网页侧的 label 与原生侧的端点友好名对到一起的键。
 * Chromium 会给 USB 设备名后面加 `(047f:c053)`，Windows 的友好名里没有，所以先剥掉。
 */
export function endpointKey(label: string): string {
  return stripUsbIds(label).replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

/** 某个网页侧设备名对应的原生端点是不是虚拟设备。对不上或同名里有真有假 → null（不下结论）。 */
export function isVirtualLabel(label: string, endpoints: CaptureEndpoint[]): boolean | null {
  const key = endpointKey(label)
  if (!key) return null
  const hits = endpoints.filter((endpoint) => endpointKey(endpoint.name) === key)
  if (hits.length === 0) return null
  if (hits.every((endpoint) => endpoint.isVirtual)) return true
  if (hits.every((endpoint) => !endpoint.isVirtual)) return false
  return null
}

function asEndpointList(raw: unknown): CaptureEndpoint[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is CaptureEndpoint => (
    !!item && typeof item === 'object'
    && typeof (item as CaptureEndpoint).name === 'string'
    && typeof (item as CaptureEndpoint).isVirtual === 'boolean'
  ))
}

/** 纯函数：给定两侧的设备清单，决定打开哪个。 */
export function planMicDevice(input: {
  selectedMicId: string
  webDevices: MicEndpoint[]
  endpoints: CaptureEndpoint[]
  lastGoodKey: string
}): MicPlan {
  const selected = input.selectedMicId.trim()
  if (selected && !isPseudoInputDevice(selected)) {
    return { deviceId: selected, reason: 'explicit', avoidedName: '', chosenName: '' }
  }

  const followDefault: MicPlan = { deviceId: '', reason: 'default', avoidedName: '', chosenName: '' }
  const defaultEndpoint = input.endpoints.find((endpoint) => endpoint.isDefault)
  if (!defaultEndpoint || !defaultEndpoint.isVirtual) return followDefault

  const avoidedName = defaultEndpoint.name
  const named = realInputEndpoints(input.webDevices)
  if (named.length === 0) {
    return { deviceId: '', reason: 'unmapped', avoidedName, chosenName: '' }
  }

  const candidates = named.filter((device) => isVirtualLabel(device.label, input.endpoints) === false)
  if (candidates.length === 0) {
    return { deviceId: '', reason: 'virtual_no_alternative', avoidedName, chosenName: '' }
  }

  const commsKeys = new Set(
    input.endpoints
      .filter((endpoint) => endpoint.isDefaultCommunications && !endpoint.isVirtual)
      .map((endpoint) => endpointKey(endpoint.name)),
  )
  const lastGood = input.lastGoodKey.trim()
  const chosen = (lastGood && candidates.find((device) => endpointKey(device.label) === lastGood))
    || candidates.find((device) => commsKeys.has(endpointKey(device.label)))
    || candidates[0]

  return {
    deviceId: chosen.deviceId,
    reason: 'virtual_avoided',
    avoidedName,
    chosenName: stripUsbIds(chosen.label),
  }
}

export async function listCaptureEndpoints(): Promise<CaptureEndpoint[]> {
  try {
    return asEndpointList(await invoke('list_capture_endpoints'))
  } catch {
    return []
  }
}

async function snapshotWebInputs(): Promise<MicEndpoint[]> {
  try {
    const list = await navigator.mediaDevices.enumerateDevices()
    return list
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({
        deviceId: String(device.deviceId || ''),
        groupId: String(device.groupId || ''),
        label: String(device.label || ''),
      }))
  } catch {
    return []
  }
}

/**
 * 录音启动前调用。系统默认是真实设备时只多一次原生调用（几毫秒），不枚举网页设备。
 * 任何一步失败都退回「跟随系统默认」，不让这一层挡住录音。
 */
export async function resolveMicPlan(
  selectedMicId: string,
  options: { endpoints?: CaptureEndpoint[]; webDevices?: MicEndpoint[] } = {},
): Promise<{ plan: MicPlan; endpoints: CaptureEndpoint[] }> {
  // 明确选了设备时也要端点清单：录音没声音时要靠它判断「是不是选了个虚拟声卡」。
  const endpoints = options.endpoints ?? await listCaptureEndpoints()
  if (selectedMicId.trim() && !isPseudoInputDevice(selectedMicId)) {
    return { plan: planMicDevice({ selectedMicId, webDevices: [], endpoints, lastGoodKey: '' }), endpoints }
  }
  if (!endpoints.some((endpoint) => endpoint.isDefault && endpoint.isVirtual)) {
    return { plan: planMicDevice({ selectedMicId: '', webDevices: [], endpoints, lastGoodKey: '' }), endpoints }
  }
  const [webDevices, lastGoodKey] = await Promise.all([
    options.webDevices ? Promise.resolve(options.webDevices) : snapshotWebInputs(),
    getSetting<string>(LAST_GOOD_MIC_KEY, '').catch(() => ''),
  ])
  return {
    plan: planMicDevice({ selectedMicId: '', webDevices, endpoints, lastGoodKey: String(lastGoodKey || '') }),
    endpoints,
  }
}

let lastGoodCache: string | null = null

/** 一次录音里确认听到了人声、且用的是真实麦克风时调用。名字没变就不写库。 */
export async function rememberWorkingMic(label: string): Promise<void> {
  const key = endpointKey(label)
  if (!key) return
  if (lastGoodCache === null) {
    lastGoodCache = String(await getSetting<string>(LAST_GOOD_MIC_KEY, '').catch(() => '') || '')
  }
  if (lastGoodCache === key) return
  lastGoodCache = key
  await setSetting(LAST_GOOD_MIC_KEY, key).catch(() => { })
}
