/**
 * 单键热键定义 —— 单一数据源（Single Source of Truth）。
 *
 * 过去单键的映射散落在四处（Rust 钩子、webview 回退、设置 utils、向导 KEY_MAP），
 * 且已互相不一致，加一个键要改四处、极易漏。此文件统一 TS 侧的定义，其它模块一律引用这里。
 *
 * ⚠️ Rust 端 `client/src-tauri/src/keyboard/mod.rs` 的 `SINGLE_KEY_TABLE`
 *   （vk_codes_for_setting / is_single_key_setting）无法直接引用 TS，
 *   新增/修改单键时务必同步那张表。
 *
 * 约定：`setting` 的取值直接等于 DOM `KeyboardEvent.code`，因此
 *   setting ↔ code 是恒等映射，无需再单独维护一张 code 表。
 */

export interface SingleKeyDef {
  /** 存入设置、也等于 DOM KeyboardEvent.code */
  setting: string
  /** Windows 虚拟键码（供 webview 回退补发事件用） */
  vk: number
  /** 中文显示名 */
  label: string
}

export const SINGLE_KEYS: SingleKeyDef[] = [
  // 修饰键（左右分开）
  { setting: 'AltLeft', vk: 0xa4, label: '左 Alt' },
  { setting: 'AltRight', vk: 0xa5, label: '右 Alt' },
  { setting: 'ControlLeft', vk: 0xa2, label: '左 Ctrl' },
  { setting: 'ControlRight', vk: 0xa3, label: '右 Ctrl' },
  { setting: 'ShiftLeft', vk: 0xa0, label: '左 Shift' },
  { setting: 'ShiftRight', vk: 0xa1, label: '右 Shift' },
  // 鼠标侧键（XButton1=后退, XButton2=前进）
  { setting: 'MouseBack', vk: 0x05, label: '鼠标侧键(后退)' },
  { setting: 'MouseForward', vk: 0x06, label: '鼠标侧键(前进)' },
  // 常见低冲突键
  { setting: 'CapsLock', vk: 0x14, label: 'Caps Lock' },
  { setting: 'Space', vk: 0x20, label: '空格' },
  { setting: 'ContextMenu', vk: 0x5d, label: '菜单键' },
  { setting: 'Pause', vk: 0x13, label: 'Pause' },
  { setting: 'ScrollLock', vk: 0x91, label: 'ScrollLock' },
  { setting: 'Insert', vk: 0x2d, label: 'Insert' },
  // 功能键
  { setting: 'F1', vk: 0x70, label: 'F1' },
  { setting: 'F2', vk: 0x71, label: 'F2' },
  { setting: 'F3', vk: 0x72, label: 'F3' },
  { setting: 'F4', vk: 0x73, label: 'F4' },
  { setting: 'F5', vk: 0x74, label: 'F5' },
  { setting: 'F6', vk: 0x75, label: 'F6' },
  { setting: 'F7', vk: 0x76, label: 'F7' },
  { setting: 'F8', vk: 0x77, label: 'F8' },
  { setting: 'F9', vk: 0x78, label: 'F9' },
  { setting: 'F10', vk: 0x79, label: 'F10' },
  { setting: 'F11', vk: 0x7a, label: 'F11' },
  { setting: 'F12', vk: 0x7b, label: 'F12' },
]

/** setting → 虚拟键码 */
export const SETTING_TO_VK: Record<string, number> = Object.fromEntries(
  SINGLE_KEYS.map((k) => [k.setting, k.vk]),
)

const SINGLE_KEY_DISPLAY: Record<string, string> = Object.fromEntries(
  SINGLE_KEYS.map((k) => [k.setting, k.label]),
)

/** 是否为受支持的单键设置 */
export function isSingleKeySetting(setting: string): boolean {
  return setting in SETTING_TO_VK
}

/** 若 DOM code 对应一个受支持的单键，返回其 setting（= code），否则 undefined */
export function resolveSingleKeyShortcut(code: string): string | undefined {
  return isSingleKeySetting(code) ? code : undefined
}

/** setting → DOM code（恒等，未知返回空串） */
export function settingToCode(setting: string): string {
  return isSingleKeySetting(setting) ? setting : ''
}

/** 单键显示名（未知原样返回） */
export function getSingleKeyDisplay(value: string): string {
  return SINGLE_KEY_DISPLAY[value] || value
}
