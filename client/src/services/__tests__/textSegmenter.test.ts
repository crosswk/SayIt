import { describe, it, expect } from 'vitest'
import { segmentAsrText } from '../textSegmenter'

describe('segmentAsrText', () => {
  it('短文本不分段', () => {
    expect(segmentAsrText('你好世界')).toBe('你好世界')
    expect(segmentAsrText('')).toBe('')
  })

  it('不足 40 字不分段', () => {
    const text = '这是一段不到四十个字的文本。'
    expect(segmentAsrText(text)).toBe(text)
  })

  it('在话题转换词处分段', () => {
    // 前段需要 ≥ 20 字才会在话题转换词处切分
    const text = '我今天做了很多事情，完成了项目的第一个版本，还做了很多测试工作。另外我还修复了几个重要的 bug，提交了代码。'
    const result = segmentAsrText(text)
    expect(result).toContain('\n\n')
    expect(result.split('\n\n')).toHaveLength(2)
  })

  it('超过 250 字在句末标点处强制切', () => {
    // 构造一段超过 250 字的无话题转换词文本
    const sentence = '这是一段很长的文本内容用来测试强制分段的逻辑'
    let text = ''
    while (text.length < 260) {
      text += sentence
    }
    text += '。后面还有一些内容。'
    const result = segmentAsrText(text)
    expect(result).toContain('\n\n')
  })

  it('null/undefined 安全处理', () => {
    expect(segmentAsrText(null as unknown as string)).toBeFalsy()
    expect(segmentAsrText(undefined as unknown as string)).toBeFalsy()
  })
})
