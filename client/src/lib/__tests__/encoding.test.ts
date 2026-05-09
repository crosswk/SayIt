import { describe, it, expect } from 'vitest'
import { uint8ArrayToBase64 } from '../encoding'

describe('uint8ArrayToBase64', () => {
  it('空数组返回空字符串', () => {
    expect(uint8ArrayToBase64(new Uint8Array(0))).toBe('')
  })

  it('小数据正确编码', () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
    expect(uint8ArrayToBase64(data)).toBe(btoa('Hello'))
  })

  it('大数据（超过 chunk 大小）正确编码', () => {
    // 创建 20KB 的数据，超过 8192 的 chunk 大小
    const size = 20000
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
      data[i] = i % 256
    }
    // 用原始方法验证结果一致
    let expected = ''
    for (let i = 0; i < data.length; i++) {
      expected += String.fromCharCode(data[i])
    }
    expected = btoa(expected)

    expect(uint8ArrayToBase64(data)).toBe(expected)
  })

  it('单字节数据', () => {
    const data = new Uint8Array([65]) // "A"
    expect(uint8ArrayToBase64(data)).toBe('QQ==')
  })
})
