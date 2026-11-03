import { describe, expect, it } from 'vitest'
import { shouldShowNativeContextMenu } from '../macWebview'

/** 只造出 shouldShowNativeContextMenu 会用到的 closest()：命中给定选择器里任意一个就算 */
function fakeTarget(matches: string[]): EventTarget {
  return {
    closest(selector: string) {
      const parts = selector.split(',').map((part) => part.trim())
      return parts.some((part) => matches.includes(part)) ? {} : null
    },
  } as unknown as EventTarget
}

describe('macOS 右键菜单', () => {
  it('输入框、文本框和可编辑区域里保留系统右键菜单（剪切 / 拷贝 / 粘贴）', () => {
    expect(shouldShowNativeContextMenu(fakeTarget(['input']), '')).toBe(true)
    expect(shouldShowNativeContextMenu(fakeTarget(['textarea']), '')).toBe(true)
    expect(shouldShowNativeContextMenu(
      fakeTarget(['[contenteditable]:not([contenteditable="false"])']),
      '',
    )).toBe(true)
  })

  it('空白处、按钮和链接上不弹 WebKit 的「重新载入」「打开链接」', () => {
    expect(shouldShowNativeContextMenu(fakeTarget([]), '')).toBe(false)
    expect(shouldShowNativeContextMenu(null, '')).toBe(false)
  })

  it('选中了文字时照常弹出，方便拷贝、查询', () => {
    expect(shouldShowNativeContextMenu(fakeTarget([]), '识别结果')).toBe(true)
    // 只选中了空白不算
    expect(shouldShowNativeContextMenu(fakeTarget([]), '  \n')).toBe(false)
  })

  it('目标不是元素（比如文本节点、window）时按不可编辑处理', () => {
    expect(shouldShowNativeContextMenu({} as EventTarget, '')).toBe(false)
  })
})
