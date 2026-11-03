/**
 * 快捷键定义与 PTT 物理组合键工具。
 *
 * PTT 设置保存 DOM `KeyboardEvent.code`，旧单键保持 `ShiftRight` 等原格式，
 * 组合键按固定顺序保存为 `ControlLeft+MetaLeft`、`ControlLeft+KeyK`。
 *
 * ⚠️ Rust 端 `client/src-tauri/src/keyboard/mod.rs` 的按键表无法直接引用 TS；
 * 新增或修改 PTT code 时必须同步 Rust 映射。
 */

import { t, type TranslationKey } from '@/i18n'
import { IS_MAC } from '@/lib/platform'

export interface SingleKeyDef {
  /** 存入设置、也等于 DOM KeyboardEvent.code */
  setting: string
  /** Windows 虚拟键码（供 webview 回退补发事件用） */
  vk: number
  /** 中文显示名 */
  label: string
}

// i18n-allow-start: Windows VK 源标签；展示层由 getSingleKeyDisplay 翻译覆盖
const ALL_SINGLE_KEYS: SingleKeyDef[] = [
  // 修饰键（左右分开）
  { setting: 'AltLeft', vk: 0xa4, label: '左 Alt' },
  { setting: 'AltRight', vk: 0xa5, label: '右 Alt' },
  { setting: 'ControlLeft', vk: 0xa2, label: '左 Ctrl' },
  { setting: 'ControlRight', vk: 0xa3, label: '右 Ctrl' },
  { setting: 'ShiftLeft', vk: 0xa0, label: '左 Shift' },
  { setting: 'ShiftRight', vk: 0xa1, label: '右 Shift' },
  // 常见低冲突键
  { setting: 'CapsLock', vk: 0x14, label: 'Caps Lock' },
  { setting: 'Space', vk: 0x20, label: '空格' },
  { setting: 'ContextMenu', vk: 0x5d, label: '菜单键' },
  { setting: 'Pause', vk: 0x13, label: 'Pause' },
  { setting: 'ScrollLock', vk: 0x91, label: 'ScrollLock' },
  { setting: 'Insert', vk: 0x2d, label: 'Insert' },
  // 鼠标侧键（原始 XBUTTON，由 Rust 低级鼠标钩子处理）
  { setting: 'XButton1', vk: 0x05, label: '鼠标侧键1（后退）' },
  { setting: 'XButton2', vk: 0x06, label: '鼠标侧键2（前进）' },
  // 鼠标中键（VK_MBUTTON，由 Rust 低级鼠标钩子处理）
  { setting: 'MButton', vk: 0x04, label: '鼠标中键' },
  // 浏览器后退/前进键（罗技等改键鼠标常把侧键映射成这个，由键盘钩子处理）
  { setting: 'BrowserBack', vk: 0xa6, label: '鼠标侧键（后退键）' },
  { setting: 'BrowserForward', vk: 0xa7, label: '鼠标侧键（前进键）' },
  // 功能键 F1–F24（VK 0x70–0x87 连续）。
  //
  // F13–F24 在 Windows 里是正式的虚拟键、键盘布局里也有真实 scan code，但没有任何
  // 量产键盘把它做成物理键 —— 所以它们几乎不可能和别的程序的快捷键撞，正好适合
  // 可编程键盘、自制 HID 语音设备这类「专用触发键」的场景。
  // Rust 侧的幻影过滤对这一段开了例外，见 keyboard/mod.rs 的 is_injection_exempt_vk。
  ...Array.from({ length: 24 }, (_, index) => ({
    setting: `F${index + 1}`,
    vk: 0x70 + index,
    label: `F${index + 1}`,
  })),
]

/**
 * Mac 键盘上不存在、或在 mac 上不能当热键的单键。
 *
 * - ContextMenu / Pause / ScrollLock / BrowserBack / BrowserForward：Mac 键盘没有
 *   （PC 键盘接到 Mac 上时 PrintScreen/ScrollLock/Pause 会被系统报成 F13–F15）。
 * - F21–F24：macOS 没有对应的虚拟键码。
 * - CapsLock：mac 上只报「切换」不报「松开」，中文用户还常用它切换输入法。
 */
const MAC_UNAVAILABLE_SINGLE_KEYS = new Set([
  'ContextMenu', 'Pause', 'ScrollLock', 'BrowserBack', 'BrowserForward', 'CapsLock',
  'F21', 'F22', 'F23', 'F24',
])

/**
 * 只在 mac 上可以单独当热键的键（Rust 侧见 keyboard/mod.rs 的 PLATFORM_EXTRA_SINGLE_KEYS）：
 * 单独的 ⌘（右 ⌘ 是 mac 免提的默认键；Windows 上单按 Win 会弹开始菜单，所以不允许）、Fn / 🌐。
 */
const MAC_EXTRA_SINGLE_KEYS: SingleKeyDef[] = [
  { setting: 'MetaLeft', vk: 0x5b, label: 'Left ⌘' },
  { setting: 'MetaRight', vk: 0x5c, label: 'Right ⌘' },
  { setting: 'Fn', vk: 0xff, label: 'Fn' },
]

export const SINGLE_KEYS: SingleKeyDef[] = IS_MAC
  ? [...ALL_SINGLE_KEYS.filter((key) => !MAC_UNAVAILABLE_SINGLE_KEYS.has(key.setting)), ...MAC_EXTRA_SINGLE_KEYS]
  : ALL_SINGLE_KEYS
// i18n-allow-end

/** setting → 虚拟键码（旧单键与免提回退使用） */
export const SETTING_TO_VK: Record<string, number> = Object.fromEntries(
  SINGLE_KEYS.map((key) => [key.setting, key.vk]),
)

const SINGLE_KEY_DISPLAY: Record<string, string> = Object.fromEntries(
  SINGLE_KEYS.map((key) => [key.setting, key.label]),
)

/** PTT 修饰键固定排序；左右位置会保留。 */
export const PTT_MODIFIER_CODES = [
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
] as const

const PTT_MODIFIER_SET = new Set<string>(PTT_MODIFIER_CODES)
const PTT_MOUSE_CODES = new Set(['XButton1', 'XButton2', 'MButton'])

/**
 * 不允许出现在「按住说话」里的按键。
 *
 * Shift 与 Windows 的辅助功能快捷方式直接冲突，而冲突的触发条件恰好就是 PTT 的
 * 使用方式：
 *   · 长按右 Shift 约 8 秒 → 筛选键。它一旦弹出，我们收不到那次「松开」，
 *     录音不会随手指抬起而结束（这是之前只给警告、用户仍然踩到的那个问题）。
 *   · 连按 Shift 五次 → 粘滞键。短句口述本来就是一串快速的按下松开。
 * PTT 必须被按住数秒、还经常被连续短按，两条正好全中。
 *
 * 所以 Shift 不做成"可以选但给个警告"——警告只能让用户在出问题之后回来读一遍，
 * 挡不住任何人。左右都禁：单键和组合成员都算，`Ctrl+右Shift` 一样会触发筛选键。
 *
 * **只约束 PTT。** 免提、预设切换那类"按一下"的快捷键（走 accelerator 那条校验）
 * 照旧可以用 Shift —— 它们不长按也不连按，两个触发条件都碰不到。
 */
const PTT_FORBIDDEN_CODES = new Set(['ShiftLeft', 'ShiftRight'])

/** 这个按键能不能用于「按住说话」。 */
export function isPTTForbiddenCode(code: string): boolean {
  return PTT_FORBIDDEN_CODES.has(code)
}

// i18n-allow-start: Windows VK 源标签；展示层由 getSingleKeyDisplay 翻译覆盖
const PTT_EXTRA_KEY_DEFS: SingleKeyDef[] = [
  { setting: 'MetaLeft', vk: 0x5b, label: '左 Win' },
  { setting: 'MetaRight', vk: 0x5c, label: '右 Win' },
  ...Array.from({ length: 26 }, (_, index) => ({
    setting: `Key${String.fromCharCode(65 + index)}`,
    vk: 0x41 + index,
    label: String.fromCharCode(65 + index),
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    setting: `Digit${index}`,
    vk: 0x30 + index,
    label: String(index),
  })),
  { setting: 'Escape', vk: 0x1b, label: 'Esc' },
  { setting: 'Tab', vk: 0x09, label: 'Tab' },
  { setting: 'Enter', vk: 0x0d, label: 'Enter' },
  { setting: 'Backspace', vk: 0x08, label: 'Backspace' },
  { setting: 'Delete', vk: 0x2e, label: 'Delete' },
  { setting: 'ArrowUp', vk: 0x26, label: '↑' },
  { setting: 'ArrowDown', vk: 0x28, label: '↓' },
  { setting: 'ArrowLeft', vk: 0x25, label: '←' },
  { setting: 'ArrowRight', vk: 0x27, label: '→' },
  { setting: 'Home', vk: 0x24, label: 'Home' },
  { setting: 'End', vk: 0x23, label: 'End' },
  { setting: 'PageUp', vk: 0x21, label: 'Page Up' },
  { setting: 'PageDown', vk: 0x22, label: 'Page Down' },
]
// i18n-allow-end

/** PTT 成员 code → Windows 虚拟键码。 */
export const PTT_CODE_TO_VK: Record<string, number> = {
  ...SETTING_TO_VK,
  ...Object.fromEntries(PTT_EXTRA_KEY_DEFS.map((key) => [key.setting, key.vk])),
}

const PTT_CODE_DISPLAY: Record<string, string> = {
  ...SINGLE_KEY_DISPLAY,
  ...Object.fromEntries(PTT_EXTRA_KEY_DEFS.map((key) => [key.setting, key.label])),
}

/** 是否为受支持的旧单键设置。 */
export function isSingleKeySetting(setting: string): boolean {
  return setting in SETTING_TO_VK
}

/** 若 DOM code 对应一个受支持的旧单键，返回其 setting（= code）。 */
export function resolveSingleKeyShortcut(code: string): string | undefined {
  return isSingleKeySetting(code) ? code : undefined
}

/** setting → DOM code（恒等，未知返回空串）。 */
export function settingToCode(setting: string): string {
  return isSingleKeySetting(setting) ? setting : ''
}

/**
 * 需要翻译的键名。
 *
 * 只列**含自然语言**的那些：`左 Alt` 在英文里是 `Left Alt`，`空格` 是 `Space`。
 * `F1`、`Tab`、`Esc`、`Caps Lock`、字母数字、方向键这些本来就是语言中立的，
 * 继续用上面表里的 `label`，不进 locale 文件 —— 翻译一份和原文一样的东西，
 * 只会多一处将来会不同步的地方。
 *
 * ⚠️ 这里刻意**不改** `SINGLE_KEYS` 的 `label` 字段：那张表还同时供 `vk` 映射用，
 * 动它的形状会牵连 webview 回退补发按键的逻辑。这里只加一层展示期的覆盖。
 */
const TRANSLATED_KEY_NAMES: Record<string, TranslationKey> = {
  AltLeft: 'keyName.AltLeft',
  AltRight: 'keyName.AltRight',
  ControlLeft: 'keyName.ControlLeft',
  ControlRight: 'keyName.ControlRight',
  ShiftLeft: 'keyName.ShiftLeft',
  ShiftRight: 'keyName.ShiftRight',
  MetaLeft: 'keyName.MetaLeft',
  MetaRight: 'keyName.MetaRight',
  Space: 'keyName.Space',
  ContextMenu: 'keyName.ContextMenu',
  XButton1: 'keyName.XButton1',
  XButton2: 'keyName.XButton2',
  MButton: 'keyName.MButton',
  BrowserBack: 'keyName.BrowserBack',
  BrowserForward: 'keyName.BrowserForward',
}

/** mac 上修饰键的显示名（⌥ Option、⌘ Command…），覆盖上面的 Windows 名称。 */
const MAC_TRANSLATED_KEY_NAMES: Record<string, TranslationKey> = {
  AltLeft: 'keyName.mac.AltLeft',
  AltRight: 'keyName.mac.AltRight',
  ControlLeft: 'keyName.mac.ControlLeft',
  ControlRight: 'keyName.mac.ControlRight',
  ShiftLeft: 'keyName.mac.ShiftLeft',
  ShiftRight: 'keyName.mac.ShiftRight',
  MetaLeft: 'keyName.mac.MetaLeft',
  MetaRight: 'keyName.mac.MetaRight',
  Fn: 'keyName.mac.Fn',
}

function translatedKeyName(code: string): TranslationKey | undefined {
  return (IS_MAC ? MAC_TRANSLATED_KEY_NAMES[code] : undefined) ?? TRANSLATED_KEY_NAMES[code]
}

/** 单键显示名（未知原样返回）。 */
export function getSingleKeyDisplay(value: string): string {
  const key = translatedKeyName(value)
  if (key) return t(key)
  return SINGLE_KEY_DISPLAY[value] || value
}

/** Tauri accelerator 的显示名，用于逐个渲染键帽（mac 用 ⌘⌥⌃⇧ 符号）。 */
export function displayAccelerator(accelerator: string): string[] {
  const displayNames: Record<string, string> = IS_MAC
    ? {
      CommandOrControl: '⌘',
      Command: '⌘',
      Cmd: '⌘',
      Super: '⌘',
      Meta: '⌘',
      Control: '⌃',
      Ctrl: '⌃',
      Alt: '⌥',
      Option: '⌥',
      Shift: '⇧',
      Space: 'Space',
      Return: '↩',
      // mac 按键位录制的主键名（见 macAcceleratorMainKey），显示成 mac 菜单里的写法
      Enter: '↩',
      Escape: '⎋',
      Tab: '⇥',
      Backspace: '⌫',
      Delete: '⌦',
      Up: '↑',
      Down: '↓',
      Left: '←',
      Right: '→',
      Comma: ',',
      Period: '.',
      Slash: '/',
      Semicolon: ';',
      Quote: "'",
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Backquote: '`',
      Minus: '-',
      Equal: '=',
    }
    : {
      CommandOrControl: 'Ctrl',
      Control: 'Ctrl',
      Ctrl: 'Ctrl',
      Alt: 'Alt',
      Shift: 'Shift',
      Space: 'Space',
      Return: 'Enter',
    }
  return accelerator.split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => displayNames[part] || part)
}

/** 单键或 accelerator 的统一显示标签。 */
export function displayShortcut(shortcut: string): string[] {
  return isSingleKeySetting(shortcut)
    ? [getSingleKeyDisplay(shortcut)]
    : displayAccelerator(shortcut)
}

/**
 * 按键事件 → Tauri accelerator。只有「修饰键 + 主键」才成型，单按修饰键返回 null。
 *
 * 免提与预设切换存的就是这种格式（见 defaults.ts 的 shortcutHandsFree）。
 */
export function eventToAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (IS_MAC) {
    // mac 上 ⌘ 与 ⌃ 是两个键：⌘ 存成 CommandOrControl（在 mac 上就是 ⌘），⌃ 单独存 Control
    if (event.metaKey) parts.push('CommandOrControl')
    if (event.ctrlKey) parts.push('Control')
  } else if (event.ctrlKey || event.metaKey) {
    parts.push('CommandOrControl')
  }
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const key = event.key
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null

  // mac：主键按键位取名（⌥ / ⇧ 会改掉 event.key，见 macAcceleratorMainKey）
  if (IS_MAC) {
    const mainKey = macAcceleratorMainKey(event.code)
    if (!mainKey) return null
    parts.push(mainKey)
    return parts.length >= 2 ? parts.join('+') : null
  }

  const keyMap: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
  }

  const mapped = keyMap[key] || (key.length === 1 ? key.toUpperCase() : key)
  parts.push(mapped)
  return parts.length >= 2 ? parts.join('+') : null
}

/**
 * 一次 keydown 该被录成什么：单键 DOM code、accelerator，或 null（还不成型）。
 *
 * **这个判断必须只有一份。** 向导里曾经自己写过一份「只认单键白名单」的版本，
 * 于是按 Ctrl+D 时 Ctrl 的 keydown 先到、`ControlLeft` 恰好在白名单里 ——
 * 免提键被静默存成「左 Ctrl」，D 根本没轮到，而用户看到的是"组合键不支持"。
 *
 * 判定顺序是**先组合、后单键**，不能反过来：`Space`、`Insert`、`F1`–`F24` 同时
 * 出现在单键白名单里，先判单键会把 `Ctrl+Space`、`Ctrl+F1` 也吃成单键。
 * 反过来是安全的 —— 纯修饰键（右 Alt）在 eventToAccelerator 里返回 null，
 * 自然落到单键分支。
 *
 * 调用方在 keydown 里持续更新候选、在 keyup 时提交最后那个候选，**null 表示
 * 「这次按键还没凑成东西」，要保留上一个候选**，不能覆盖成空 —— 否则先按 Ctrl+D
 * 再松手的过程中，任何一次不成型的中间事件都会把已经录到的组合键抹掉。
 *
 * comboOnly 用于「必须是组合键」的设置（预设切换）：单键一律不成型。
 */
export function keyEventToShortcutCandidate(
  event: KeyboardEvent,
  options: { comboOnly?: boolean } = {},
): string | null {
  const accelerator = eventToAccelerator(event)
  if (accelerator) return accelerator
  if (options.comboOnly) return null
  return resolveSingleKeyShortcut(event.code) ?? null
}

/** 拆分 PTT 设置；不在这里静默丢弃未知成员，交给校验器给出明确错误。 */
export function parsePTTShortcut(setting: string): string[] {
  if (!setting.trim()) return []
  return setting.split('+').map((part) => part.trim()).filter(Boolean)
}

/** 将 PTT 成员按 Ctrl、Win、Alt、Shift、普通键顺序规范化。 */
export function canonicalizePTTShortcut(settingOrCodes: string | Iterable<string>): string {
  const codes = typeof settingOrCodes === 'string'
    ? parsePTTShortcut(settingOrCodes)
    : Array.from(settingOrCodes)
  const uniqueCodes = [...new Set(codes)]
  const modifierOrder = new Map<string, number>(
    PTT_MODIFIER_CODES.map((code, index) => [code, index]),
  )
  return uniqueCodes.sort((left, right) => {
    const leftOrder = modifierOrder.get(left) ?? PTT_MODIFIER_CODES.length
    const rightOrder = modifierOrder.get(right) ?? PTT_MODIFIER_CODES.length
    return leftOrder - rightOrder || left.localeCompare(right)
  }).join('+')
}

/** PTT 设置的按键标签，用于逐个渲染键帽。 */
export function displayPTTShortcut(setting: string): string[] {
  return parsePTTShortcut(canonicalizePTTShortcut(setting)).map((code) => {
    const key = translatedKeyName(code)
    return key ? t(key) : PTT_CODE_DISPLAY[code] || code
  })
}

export function isPTTModifierCode(code: string): boolean {
  return PTT_MODIFIER_SET.has(code)
}

export function pttShortcutHasModifier(setting: string): boolean {
  return parsePTTShortcut(setting).some(isPTTModifierCode)
}

/**
 * 已保存的按住说话配置需要提醒用户的地方。
 *
 * 目前只有一种：老用户在 Shift 还能选的时候绑上了它。
 *
 * 为什么不在升级时自动改掉：那是在用户不知情的情况下换掉他的说话键，比留着更糟。
 * 也不在这里直接停掉它——那等于升级后按住说话突然没反应，而用户未必会想到来设置页。
 * 所以旧绑定继续生效，只是在设置里常驻一行提示让他换。新绑定由
 * getPTTShortcutValidationError 硬拦。
 */
export function getPTTShortcutWarning(setting: string): string | null {
  return parsePTTShortcut(canonicalizePTTShortcut(setting)).some(isPTTForbiddenCode)
    // mac 上只可能来自导入的 Windows 配置
    ? t(IS_MAC ? 'shortcut.warning.shiftNoLongerSupportedMac' : 'shortcut.warning.shiftNoLongerSupported')
    : null
}

function normalizedAcceleratorParts(accelerator: string): string[] {
  const aliases: Record<string, string> = {
    Ctrl: 'Control',
    CommandOrControl: 'Control',
    Super: 'Meta',
    Win: 'Meta',
    Windows: 'Meta',
    Return: 'Enter',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
  }
  return accelerator.split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => aliases[part] || part)
}

/**
 * 通用 accelerator 的 Windows 保留组合校验。
 *
 * PTT 使用物理 code，有自己的完整校验；免提与预设切换使用 Tauri accelerator，
 * 也必须在试注册前挡住系统安全界面、窗口切换等无法可靠覆盖的组合。
 */
export function getAcceleratorShortcutValidationError(accelerator: string): string | null {
  // mac：单键和鼠标键由我们自己的事件监听处理，不走系统快捷键注册，下面那些组合键规则管不到它们。
  // 以前漏了这一句，单独一个右 ⌥、F5、鼠标侧键也被报「需要带上 ⌘ 或 ⌃」。
  if (IS_MAC) return isSingleKeySetting(accelerator) ? null : getMacAcceleratorValidationError(accelerator)
  const parts = normalizedAcceleratorParts(accelerator)
  const has = (key: string) => parts.includes(key)
  const mainKeys = parts.filter((part) => !['Control', 'Meta', 'Alt', 'Shift'].includes(part))
  const mainKey = mainKeys[0]

  if (has('Control') && has('Alt') && mainKey === 'Delete') {
    return t('shortcut.error.reservedCtrlAltDel')
  }
  if (has('Meta') && mainKey) {
    return t('shortcut.error.reservedWindows')
  }
  if (has('Alt') && ['F4', 'Tab', 'Escape', 'Space'].includes(mainKey)) {
    return t('shortcut.error.reservedAlt')
  }
  if (has('Control') && mainKey === 'Escape') {
    return t('shortcut.error.reservedCtrlEsc')
  }
  return null
}

/**
 * macOS 的 accelerator 校验（免提组合、AI 开关、润色模式切换）。
 *
 * - 带 ⌘ 或 ⌃ 的组合注册成系统快捷键；修饰键只有 ⌥ / ⇧ 的组合（macOS 15 起系统快捷键不触发）
 *   由 Rust 的 event tap 接管（keyboard/macos.rs 的 TAP_COMBOS），两类都能用。
 * - ⌘Space（聚焦搜索）、⌃Space（切换输入法）、⌘Tab、⌘Q、⌘⇧3/4/5（截屏）被系统或所有程序占用。
 * - 一个修饰键 + 会打出字符或有编辑含义的键，是各程序自己的快捷键或用来输入特殊字符（⌥E、⌥2）。
 */
function getMacAcceleratorValidationError(accelerator: string): string | null {
  const aliases: Record<string, string> = {
    CommandOrControl: 'Meta',
    Command: 'Meta',
    Cmd: 'Meta',
    Super: 'Meta',
    Ctrl: 'Control',
    Option: 'Alt',
    Return: 'Enter',
  }
  const parts = accelerator.split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => aliases[part] || part)
  const has = (key: string) => parts.includes(key)
  const mainKey = parts.find((part) => !['Control', 'Meta', 'Alt', 'Shift'].includes(part))
  if ((has('Meta') || has('Control')) && mainKey === 'Space' && !has('Alt') && !has('Shift')) {
    return t('shortcut.error.reservedMac')
  }
  if (has('Meta') && (mainKey === 'Tab' || mainKey === 'Q')) {
    return t('shortcut.error.reservedMac')
  }
  if (has('Meta') && has('Shift') && ['3', '4', '5'].includes(mainKey ?? '')) {
    return t('shortcut.error.reservedMac')
  }
  // ⌥⌘Esc：强制退出
  if (has('Meta') && has('Alt') && mainKey === 'Escape') {
    return t('shortcut.error.reservedMac')
  }
  // 一个修饰键 + 字母 / 数字 / 符号 / 空格 / 方向键（⌘W 关窗口、⌘C 复制、⌃A 行首、⌥E 打重音符号、
  // ⇧Space 打空格……）是各个程序和系统自己的快捷键，或用来输入字符。注册成全局快捷键后，
  // 这些键在所有程序里都会失灵。
  const modifierCount = ['Meta', 'Control', 'Alt', 'Shift'].filter(has).length
  if (modifierCount === 1 && mainKey && isMacCharacterOrEditingKey(mainKey)) {
    return t('shortcut.error.macSingleModifierReserved')
  }
  return null
}

/** 和一个修饰键组合时都有系统或文字编辑含义的非字符键（accelerator 里的写法） */
const MAC_EDITING_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Return', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
])

/** 会打出字符的键里，accelerator 不用单个字符而用名字写的那些（mac 按键位录制，见 macAcceleratorMainKey） */
const MAC_NAMED_CHARACTER_KEYS = new Set([
  'Space', 'Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight',
  'Backslash', 'Backquote', 'Minus', 'Equal',
])

function isMacCharacterOrEditingKey(mainKey: string): boolean {
  return mainKey.length === 1
    || MAC_NAMED_CHARACTER_KEYS.has(mainKey)
    || MAC_EDITING_KEYS.has(mainKey)
    || /^Numpad/.test(mainKey)
}

/**
 * mac 录组合键时的主键：按物理键位（event.code）取名，不看 event.key。
 *
 * ⌥ 会改变 event.key（⌥⇧D 得到「Î」，⌥1 得到「¡」），⇧ 会把数字变成符号（⇧1 → 「!」），
 * 非美式键盘上字母的位置也不同；这些都会录成 Rust 端（global-hotkey）解析不了的组合。
 * 系统快捷键和 event tap 本来就按键位匹配，所以这里也按键位取名，写法用 global-hotkey 认得的。
 * 返回 null 表示这个键不能当组合键的主键。
 */
function macAcceleratorMainKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|20)$/.test(code)) return code
  if (/^Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal)$/.test(code)) return code
  const names: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }
  if (names[code]) return names[code]
  return MAC_NAMED_CHARACTER_KEYS.has(code) || [
    'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  ].includes(code)
    ? code
    : null
}

export interface PTTValidationOptions {
  /**
   * 是否放行「历史上曾经能选、现在已禁用」的按键（目前只有 Shift）。
   *
   * 读取**已保存的配置**时必须传 true。否则老用户的 Shift 绑定会被判成非法，
   * 而几个调用点碰到非法值的做法是回落到默认键 —— 用户一个设置都没改，
   * 说话键却自己变了，这比让他继续用 Shift 更糟。
   *
   * 校验**用户新输入**时保持 false（默认），这样 Shift 绑不上去。
   */
  allowLegacyReservedKeys?: boolean
}

/** 返回本地化的错误提示；null 表示可保存。 */
export function getPTTShortcutValidationError(
  setting: string,
  options: PTTValidationOptions = {},
): string | null {
  const rawCodes = setting.split('+').map((part) => part.trim())
  const codes = rawCodes.filter(Boolean)
  if (codes.length === 0) return t('shortcut.error.empty')
  if (rawCodes.length !== codes.length || new Set(codes).size !== codes.length) {
    return t('shortcut.error.invalidFormat')
  }

  const unsupported = codes.find((code) => !(code in PTT_CODE_TO_VK))
  if (unsupported) return t('shortcut.error.unsupportedKey', { key: unsupported })

  // 排在单键/组合的分支之前：Shift 无论单独用还是当组合成员都不行
  if (!options.allowLegacyReservedKeys && codes.some(isPTTForbiddenCode)) {
    return t(IS_MAC ? 'shortcut.error.shiftReservedMac' : 'shortcut.error.shiftReserved')
  }

  if (codes.length === 1) {
    const code = codes[0]
    // mac 上单独的 ⌘ 没有系统动作，可以当按住说话键（Windows 上单按 Win 会弹开始菜单）
    if (!IS_MAC && (code === 'MetaLeft' || code === 'MetaRight')) {
      return t('shortcut.error.metaAlone')
    }
    if (!isSingleKeySetting(code)) {
      return t(IS_MAC ? 'shortcut.error.plainKeyAloneMac' : 'shortcut.error.plainKeyAlone')
    }
    return null
  }

  if (codes.some((code) => PTT_MOUSE_CODES.has(code))) {
    return t('shortcut.error.mouseCombo')
  }

  const modifiers = codes.filter(isPTTModifierCode)
  const mainKeys = codes.filter((code) => !isPTTModifierCode(code))
  const modifierFamilies = modifiers.map((code) => code.replace(/(?:Left|Right)$/, ''))
  if (new Set(modifierFamilies).size !== modifierFamilies.length) {
    return t('shortcut.error.sameModifierFamily')
  }
  if (mainKeys.length > 1) return t('shortcut.error.tooManyMainKeys')
  if (mainKeys.length === 1 && modifiers.length === 0) {
    return t(IS_MAC ? 'shortcut.error.needModifierMac' : 'shortcut.error.needModifier')
  }
  if (mainKeys.length === 0 && modifiers.length < 2) {
    return t('shortcut.error.needTwoModifiers')
  }

  const hasFamily = (prefix: string) => modifiers.some((code) => code.startsWith(prefix))
  const mainKey = mainKeys[0]
  if (IS_MAC) {
    // 按住说话走 event tap，不受 Carbon 快捷键的 ⌥ 限制；只挡系统占用的组合
    if ((hasFamily('Meta') || hasFamily('Control')) && mainKey === 'Space') {
      return t('shortcut.error.reservedMac')
    }
    if (hasFamily('Meta') && (mainKey === 'Tab' || mainKey === 'KeyQ')) {
      return t('shortcut.error.reservedMac')
    }
    return null
  }
  if (hasFamily('Control') && hasFamily('Alt') && mainKey === 'Delete') {
    return t('shortcut.error.reservedCtrlAltDel')
  }
  // 带主键的 Win 组合由 Windows Shell 保留；Ctrl + Win 这类纯修饰键组合仍可用。
  if (hasFamily('Meta') && mainKey) {
    return t('shortcut.error.reservedWindows')
  }
  if (hasFamily('Alt') && ['F4', 'Tab', 'Escape', 'Space'].includes(mainKey)) {
    return t('shortcut.error.reservedAlt')
  }
  if (hasFamily('Control') && mainKey === 'Escape') {
    return t('shortcut.error.reservedCtrlEsc')
  }

  return null
}

export function isValidPTTShortcut(
  setting: string,
  options: PTTValidationOptions = {},
): boolean {
  return getPTTShortcutValidationError(setting, options) === null
}

function pttMainCodeToAccelerator(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const aliases: Record<string, string> = {
    Enter: 'Return',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }
  return aliases[code] || code
}

/**
 * 将可由 Tauri accelerator 表示的 PTT 组合转换为 accelerator。
 * 纯修饰组合以及同时包含 Ctrl 和 Win 的组合没有无损表示，返回 undefined。
 */
export function pttShortcutToAccelerator(setting: string): string | undefined {
  if (!isValidPTTShortcut(setting)) return undefined
  const codes = parsePTTShortcut(canonicalizePTTShortcut(setting))
  const mainKeys = codes.filter((code) => !isPTTModifierCode(code))
  if (mainKeys.length !== 1) return undefined

  const hasControl = codes.some((code) => code.startsWith('Control'))
  const hasMeta = codes.some((code) => code.startsWith('Meta'))
  if (hasControl && hasMeta) return undefined

  const parts: string[] = []
  // 现有免提录制将 Windows 的 Ctrl/Meta 都保存为 CommandOrControl。
  if (hasControl || hasMeta) parts.push('CommandOrControl')
  if (codes.some((code) => code.startsWith('Alt'))) parts.push('Alt')
  if (codes.some((code) => code.startsWith('Shift'))) parts.push('Shift')
  parts.push(pttMainCodeToAccelerator(mainKeys[0]))
  return parts.join('+')
}

function normalizeAccelerator(accelerator: string): string {
  const order: Record<string, number> = { CommandOrControl: 0, Alt: 1, Shift: 2 }
  const aliases: Record<string, string> = {
    Ctrl: 'CommandOrControl',
    Control: 'CommandOrControl',
    Command: 'CommandOrControl',
    Meta: 'CommandOrControl',
    Enter: 'Return',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  }
  return accelerator.split('+')
    .map((part) => aliases[part] || part)
    .sort((left, right) => (order[left] ?? 3) - (order[right] ?? 3) || left.localeCompare(right))
    .join('+')
}

/** 比较 PTT 物理组合与免提/预设 accelerator 是否会触发同一组合。 */
export function pttShortcutConflictsWithAccelerator(
  pttSetting: string,
  otherShortcut: string,
): boolean {
  if (!pttSetting || !otherShortcut) return false
  const pttCodes = parsePTTShortcut(canonicalizePTTShortcut(pttSetting))
  // 免提单键若同时是 PTT 组合成员，会被原生 hook 的“PTT 优先”规则完全遮蔽。
  if (isSingleKeySetting(otherShortcut) && pttCodes.includes(otherShortcut)) return true
  if (canonicalizePTTShortcut(pttSetting) === canonicalizePTTShortcut(otherShortcut)) return true
  const accelerator = pttShortcutToAccelerator(pttSetting)
  return accelerator !== undefined
    && normalizeAccelerator(accelerator) === normalizeAccelerator(otherShortcut)
}
