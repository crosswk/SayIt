import { describe, expect, it, vi } from 'vitest'

// 这个文件按 macOS 跑。IS_MAC 在模块加载时就决定了键表和校验口径，所以要在导入前替换掉。
vi.mock('@/lib/platform', () => ({ IS_MAC: true }))

import {
  displayAccelerator,
  getAcceleratorShortcutValidationError,
  getPTTShortcutValidationError,
  keyEventToShortcutCandidate,
} from '../shortcutKeys'

/** 只造出 keyEventToShortcutCandidate 会读的那几个字段 */
function keyEvent(init: { code: string, key: string, alt?: boolean, ctrl?: boolean, shift?: boolean, meta?: boolean }) {
  return {
    code: init.code,
    key: init.key,
    altKey: init.alt ?? false,
    ctrlKey: init.ctrl ?? false,
    shiftKey: init.shift ?? false,
    metaKey: init.meta ?? false,
  } as KeyboardEvent
}

describe('macOS 快捷键校验', () => {
  // 回归：单键也被套上了组合键的规则，设右 ⌥、F5、鼠标侧键时都报「需要带上 ⌘ 或 ⌃」
  it('单键和鼠标键不受组合键规则的限制', () => {
    for (const key of ['AltRight', 'AltLeft', 'MetaRight', 'ControlRight', 'ShiftRight', 'Fn', 'F5', 'Space', 'XButton1', 'MButton']) {
      expect(getAcceleratorShortcutValidationError(key), key).toBeNull()
    }
  })

  // 修饰键只有 ⌥ / ⇧ 的组合系统快捷键在 macOS 15 起不触发，现在由 Rust 的 event tap 接管，可以用了
  it('只带 ⌥、⇧ 或 ⌥⇧ 的组合键可以用，一个修饰键加会打字的键照样拦下', () => {
    for (const combo of ['Alt+Shift+K', 'Alt+Shift+1', 'Alt+F5', 'Shift+F5', 'Alt+Shift+Comma']) {
      expect(getAcceleratorShortcutValidationError(combo), combo).toBeNull()
    }
    for (const combo of ['Alt+K', 'Shift+K', 'Alt+2', 'Alt+Comma', 'Shift+Space', 'Alt+Space', 'Alt+Left', 'Alt+Numpad1']) {
      expect(getAcceleratorShortcutValidationError(combo), combo).not.toBeNull()
    }
  })

  // 用户实测时把免提设成了 ⌘W：注册成功了，但从此所有程序里的 ⌘W（关窗口）都被 SayIt 抢走
  it('一个修饰键 + 字母 / 数字 / 方向键被拦下，加第二个修饰键或换 F 键就放行', () => {
    for (const combo of ['CommandOrControl+W', 'CommandOrControl+C', 'CommandOrControl+1', 'CommandOrControl+,', 'CommandOrControl+Left', 'Control+A', 'Control+Right', 'CommandOrControl+Return']) {
      expect(getAcceleratorShortcutValidationError(combo), combo).not.toBeNull()
    }
    for (const combo of ['CommandOrControl+Shift+W', 'Control+Alt+W', 'Control+CommandOrControl+D', 'CommandOrControl+F5', 'Control+F9']) {
      expect(getAcceleratorShortcutValidationError(combo), combo).toBeNull()
    }
    expect(getAcceleratorShortcutValidationError('CommandOrControl+Alt+Escape')).not.toBeNull()
  })

  it('带 ⌘ 或 ⌃ 的组合键放行，系统占用的组合拦下', () => {
    expect(getAcceleratorShortcutValidationError('CommandOrControl+Shift+K')).toBeNull()
    expect(getAcceleratorShortcutValidationError('Control+Alt+K')).toBeNull()
    expect(getAcceleratorShortcutValidationError('CommandOrControl+Space')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Control+Space')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('CommandOrControl+Tab')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('CommandOrControl+Shift+4')).not.toBeNull()
  })

  it('录制：单按修饰键录成单键，⌘ 与 ⌃ 分开记', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'MetaRight', key: 'Meta', meta: true }))).toBe('MetaRight')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'AltRight', key: 'Alt', alt: true }))).toBe('AltRight')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'KeyK', key: 'k', meta: true }))).toBe('CommandOrControl+K')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'KeyK', key: 'k', ctrl: true }))).toBe('Control+K')
  })

  // ⌥ 和 ⇧ 会改掉 event.key：按字符录的话会存成 Rust 端解析不了的「Alt+Shift+Î」「Control+Shift+!」
  it('录制：组合键的主键按键位记，不受 ⌥ / ⇧ 打出的字符影响', () => {
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'KeyD', key: 'Î', alt: true, shift: true }))).toBe('Alt+Shift+D')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'Digit1', key: '!', ctrl: true, shift: true }))).toBe('Control+Shift+1')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'Comma', key: '¯', alt: true, shift: true }))).toBe('Alt+Shift+Comma')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'Enter', key: 'Enter', meta: true, shift: true }))).toBe('CommandOrControl+Shift+Enter')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'ArrowUp', key: 'ArrowUp', ctrl: true, alt: true }))).toBe('Control+Alt+Up')
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'F5', key: 'F5', shift: true }))).toBe('Shift+F5')
    // 主键当不了快捷键的（ISO 键盘 Z 左边那个键）：还没成型，保留上一个候选
    expect(keyEventToShortcutCandidate(keyEvent({ code: 'IntlBackslash', key: '§', alt: true, shift: true }), { comboOnly: true })).toBeNull()
  })

  it('组合键显示成 mac 菜单里的写法', () => {
    expect(displayAccelerator('Alt+Shift+Comma')).toEqual(['⌥', '⇧', ','])
    expect(displayAccelerator('CommandOrControl+Shift+Enter')).toEqual(['⌘', '⇧', '↩'])
    expect(displayAccelerator('Control+Alt+Up')).toEqual(['⌃', '⌥', '↑'])
  })

  it('按住说话：单独的 ⌘ 可以用（mac 上单按 ⌘ 没有系统动作）', () => {
    expect(getPTTShortcutValidationError('MetaRight')).toBeNull()
    expect(getPTTShortcutValidationError('AltRight')).toBeNull()
  })

  it('报错文案用 mac 的修饰键名，不提 Ctrl / Win / Alt', () => {
    const message = getPTTShortcutValidationError('KeyK') ?? ''
    expect(message).toContain('⌘')
    expect(message).not.toMatch(/Ctrl|Win|Alt/)
  })
})
