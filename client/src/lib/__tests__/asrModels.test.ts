import { describe, it, expect } from 'vitest'
import { isQwenOmniProvider, resolveQwenOmniModel, resolveAsrDisplayModel } from '../asrModels'

describe('isQwenOmniProvider', () => {
  it('识别 Qwen Omni 系列', () => {
    expect(isQwenOmniProvider('qwen_omni_plus')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_35_plus')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_35_flash')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_flash')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_turbo')).toBe(true)
  })

  it('非 Omni 返回 false', () => {
    expect(isQwenOmniProvider('doubao_v2')).toBe(false)
    expect(isQwenOmniProvider('qwen')).toBe(false)
    expect(isQwenOmniProvider('')).toBe(false)
  })
})

describe('resolveQwenOmniModel', () => {
  it('返回正确的模型 ID', () => {
    expect(resolveQwenOmniModel('qwen_omni_35_plus')).toBe('qwen3.5-omni-plus-realtime')
    expect(resolveQwenOmniModel('qwen_omni_35_flash')).toBe('qwen3.5-omni-flash-realtime')
    expect(resolveQwenOmniModel('qwen_omni_flash')).toBe('qwen3-omni-flash-realtime')
    expect(resolveQwenOmniModel('qwen_omni_turbo')).toBe('qwen-omni-turbo-realtime')
  })

  it('非 Omni 返回 undefined', () => {
    expect(resolveQwenOmniModel('doubao_v2')).toBeUndefined()
    expect(resolveQwenOmniModel('qwen')).toBeUndefined()
  })
})

describe('resolveAsrDisplayModel', () => {
  it('映射已知供应商', () => {
    expect(resolveAsrDisplayModel('doubao_v2')).toBe('Doubao-Seed-ASR-2.0')
    expect(resolveAsrDisplayModel('qwen')).toBe('qwen3-asr-flash')
    expect(resolveAsrDisplayModel('qwen_omni_35_plus')).toBe('qwen3.5-omni-plus-realtime')
  })

  it('未知供应商返回原始 key', () => {
    expect(resolveAsrDisplayModel('custom_provider')).toBe('custom_provider')
  })

  it('空字符串返回 unknown', () => {
    expect(resolveAsrDisplayModel('')).toBe('unknown')
  })
})
