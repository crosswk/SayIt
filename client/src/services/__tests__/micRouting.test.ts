import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('../store', () => ({ getSetting: vi.fn(async (_k: string, d: unknown) => d), setSetting: vi.fn(async () => { }) }))

import { endpointKey, isVirtualLabel, planMicDevice, type CaptureEndpoint } from '../micRouting'

/** 2026-11-07 本机现场：耳麦拔掉后系统默认变成 VB-Cable，还剩英特尔麦克风阵列。名字取自 sayit.log 与注册表。 */
const CABLE = 'CABLE Output (VB-Audio Virtual Cable)'
const INTEL = '麦克风阵列 (适用于数字麦克风的英特尔® 智音技术)'
const HEADSET = '耳机式麦克风 (Plantronics Blackwire 5220 Series)'

const ep = (name: string, extra: Partial<CaptureEndpoint> = {}): CaptureEndpoint => ({
  name, enumerator: extra.isVirtual ? 'ROOT' : 'USB', isVirtual: false, isDefault: false, isDefaultCommunications: false, ...extra,
})
const web = (deviceId: string, label: string) => ({ deviceId, groupId: `g-${deviceId}`, label })

const scene = {
  endpoints: [ep(CABLE, { isVirtual: true, isDefault: true }), ep(INTEL)],
  webDevices: [web('default', `默认值 - ${CABLE}`), web('cable', CABLE), web('intel', INTEL)],
}

describe('planMicDevice', () => {
  it('skips a virtual system default and opens the real microphone', () => {
    const plan = planMicDevice({ selectedMicId: '', lastGoodKey: '', ...scene })
    expect(plan).toMatchObject({ deviceId: 'intel', reason: 'virtual_avoided', avoidedName: CABLE, chosenName: INTEL })
  })

  it('never overrides an explicit choice, even of a virtual device', () => {
    const plan = planMicDevice({ selectedMicId: 'cable', lastGoodKey: '', ...scene })
    expect(plan).toMatchObject({ deviceId: 'cable', reason: 'explicit' })
  })

  it('leaves a real system default alone', () => {
    const plan = planMicDevice({
      selectedMicId: '', lastGoodKey: '',
      endpoints: [ep(CABLE, { isVirtual: true }), ep(INTEL, { isDefault: true })],
      webDevices: scene.webDevices,
    })
    expect(plan).toMatchObject({ deviceId: '', reason: 'default' })
  })

  it('prefers the microphone that last heard a voice, then the communications default', () => {
    const endpoints = [...scene.endpoints, ep(HEADSET, { isDefaultCommunications: true })]
    const webDevices = [...scene.webDevices, web('headset', `${HEADSET} (047f:c053)`)]
    expect(planMicDevice({ selectedMicId: '', lastGoodKey: endpointKey(INTEL), endpoints, webDevices }).deviceId).toBe('intel')
    expect(planMicDevice({ selectedMicId: '', lastGoodKey: '', endpoints, webDevices }).deviceId).toBe('headset')
  })

  it('falls back to following the default when nothing can be matched', () => {
    const unnamed = [web('a', ''), web('b', '')]
    expect(planMicDevice({ selectedMicId: '', lastGoodKey: '', endpoints: scene.endpoints, webDevices: unnamed }).reason).toBe('unmapped')
    const onlyVirtual = [web('cable', CABLE)]
    expect(planMicDevice({ selectedMicId: '', lastGoodKey: '', endpoints: scene.endpoints, webDevices: onlyVirtual }))
      .toMatchObject({ deviceId: '', reason: 'virtual_no_alternative' })
  })

  it('does not decide when two endpoints share a name but disagree', () => {
    expect(isVirtualLabel(INTEL, [ep(INTEL), ep(INTEL, { isVirtual: true })])).toBeNull()
    expect(isVirtualLabel(`${HEADSET} (047f:c053)`, [ep(HEADSET)])).toBe(false)
  })
})
