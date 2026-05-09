import { describe, it, expect } from 'vitest'
import { applyReplacements, type TextReplacementRule } from '../textReplacement'

function rule(from: string, to: string, enabled = true): TextReplacementRule {
  return { id: '1', from, to, enabled }
}

describe('applyReplacements', () => {
  it('替换匹配的文本', () => {
    const rules = [rule('你好', 'Hello')]
    expect(applyReplacements('你好世界', rules)).toBe('Hello世界')
  })

  it('替换多次出现', () => {
    const rules = [rule('啊', '')]
    expect(applyReplacements('啊这个啊那个啊', rules)).toBe('这个那个')
  })

  it('禁用的规则不生效', () => {
    const rules = [rule('你好', 'Hello', false)]
    expect(applyReplacements('你好世界', rules)).toBe('你好世界')
  })

  it('空 from 不替换', () => {
    const rules = [rule('', 'Hello')]
    expect(applyReplacements('你好世界', rules)).toBe('你好世界')
  })

  it('多条规则按顺序执行', () => {
    const rules = [
      rule('A', 'B'),
      rule('B', 'C'),
    ]
    // A → B → C（链式替换）
    expect(applyReplacements('A', rules)).toBe('C')
  })

  it('空规则列表返回原文', () => {
    expect(applyReplacements('你好', [])).toBe('你好')
  })

  it('空文本返回空', () => {
    expect(applyReplacements('', [rule('a', 'b')])).toBe('')
  })
})
