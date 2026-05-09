import { describe, it, expect } from 'vitest'
import { isSensitiveKey, maskValue, sanitizeObject } from '../sanitize'

describe('isSensitiveKey', () => {
  it('识别常见敏感 key', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('api_key')).toBe(true)
    expect(isSensitiveKey('cloudAsr.apiKey')).toBe(true)
    expect(isSensitiveKey('access_token')).toBe(true)
    expect(isSensitiveKey('accessToken')).toBe(true)
    expect(isSensitiveKey('password')).toBe(true)
    expect(isSensitiveKey('secret')).toBe(true)
    expect(isSensitiveKey('app_id')).toBe(true)
    expect(isSensitiveKey('appId')).toBe(true)
  })

  it('不误判普通 key', () => {
    expect(isSensitiveKey('theme')).toBe(false)
    expect(isSensitiveKey('language')).toBe(false)
    expect(isSensitiveKey('selectedMic')).toBe(false)
    expect(isSensitiveKey('activePresetId')).toBe(false)
    expect(isSensitiveKey('workMode')).toBe(false)
  })
})

describe('maskValue', () => {
  it('长字符串保留首尾', () => {
    expect(maskValue('sk-1234567890abcdef')).toBe('sk-***ef')
  })

  it('短字符串完全遮盖', () => {
    expect(maskValue('abc')).toBe('***')
    expect(maskValue('12345678')).toBe('***')
  })

  it('空值返回 ***', () => {
    expect(maskValue('')).toBe('***')
    expect(maskValue(null)).toBe('***')
    expect(maskValue(undefined)).toBe('***')
  })
})

describe('sanitizeObject', () => {
  it('脱敏嵌套对象中的敏感字段', () => {
    const input = {
      theme: 'dark',
      cloudAsr: {
        provider: 'doubao',
        apiKey: 'sk-1234567890abcdef',
        appId: 'app-9876543210',
      },
      cloudAi: {
        apiKey: 'key-abcdefghijklmn',
        model: 'deepseek-chat',
      },
    }
    const result = sanitizeObject(input)

    // 普通字段不变
    expect(result.theme).toBe('dark')
    expect(result.cloudAsr.provider).toBe('doubao')
    expect(result.cloudAi.model).toBe('deepseek-chat')

    // 敏感字段被脱敏
    expect(result.cloudAsr.apiKey).toBe('sk-***ef')
    expect(result.cloudAsr.appId).toBe('app***10')
    expect(result.cloudAi.apiKey).toBe('key***mn')
  })

  it('不修改原对象', () => {
    const input = { apiKey: 'sk-1234567890' }
    const result = sanitizeObject(input)
    expect(input.apiKey).toBe('sk-1234567890')
    expect(result.apiKey).toBe('sk-***90')
  })

  it('处理数组', () => {
    const input = [{ apiKey: 'sk-1234567890' }, { name: 'test' }]
    const result = sanitizeObject(input)
    expect(result[0].apiKey).toBe('sk-***90')
    expect(result[1].name).toBe('test')
  })

  it('处理 null/undefined', () => {
    expect(sanitizeObject(null)).toBeNull()
    expect(sanitizeObject(undefined)).toBeUndefined()
  })

  it('空字符串敏感字段不脱敏', () => {
    const input = { apiKey: '' }
    const result = sanitizeObject(input)
    expect(result.apiKey).toBe('')
  })
})
