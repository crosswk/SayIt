/**
 * WebView 键盘回退 — 当 SayIt 自身窗口聚焦时，WH_KEYBOARD_LL 钩子不触发。
 *
 * 原因：WebView2 (Chromium) 在同进程内拦截键盘消息，导致 LL 钩子回调不被调用。
 * 解决：在前端 document 上监听 keydown/keyup，当 webview 聚焦时补发与 Rust 钩子
 * 相同的 Tauri 事件（ptt-down / ptt-up / ptt-lab-event）。
 *
 * 当外部窗口聚焦时，webview 不会收到键盘事件，所以不会重复触发。
 * 两个路径互斥：LL 钩子处理外部窗口，此模块处理 SayIt 自身窗口。
 */

import { emit } from '@tauri-apps/api/event'
import { getSetting } from './store'

// PTT setting 值直接对应 DOM KeyboardEvent.code
const SETTING_TO_CODE: Record<string, string> = {
  AltLeft: 'AltLeft',
  AltRight: 'AltRight',
  ControlLeft: 'ControlLeft',
  ControlRight: 'ControlRight',
  ShiftLeft: 'ShiftLeft',
  ShiftRight: 'ShiftRight',
  CapsLock: 'CapsLock',
  Space: 'Space',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4',
  F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8',
  F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
}

const SETTING_TO_VK: Record<string, number> = {
  AltLeft: 0xA4, AltRight: 0xA5,
  ControlLeft: 0xA2, ControlRight: 0xA3,
  ShiftLeft: 0xA0, ShiftRight: 0xA1,
  CapsLock: 0x14, Space: 0x20,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73,
  F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77,
  F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
}

// PTT Lab 固定使用右 Ctrl
const PTT_LAB_CODE = 'ControlRight'
const PTT_LAB_VK = 0xA3

let pttCode = ''
let pttSetting = ''
let pttKeyDown = false
let labKeyDown = false
let labEnabled = false
let started = false

function isModifierSetting(setting: string) {
  return ['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(setting)
}

function handleKeyDown(e: KeyboardEvent) {
  // PTT 主键
  if (pttCode && e.code === pttCode && !pttKeyDown) {
    pttKeyDown = true
    // 修饰键要阻止默认行为（如 Alt 弹出菜单）
    if (isModifierSetting(pttSetting)) {
      e.preventDefault()
    }
    console.log('[webview-kb] ptt-down (webview fallback)', { code: e.code, pttSetting })
    emit('ptt-down', {
      source: 'webview_fallback',
      reason: 'keydown',
      vk: SETTING_TO_VK[pttSetting] || 0,
      keycode: SETTING_TO_VK[pttSetting] || 0,
      pttSetting,
      timestamp: Date.now(),
      altKey: pttSetting === 'AltLeft' || pttSetting === 'AltRight',
      ctrlKey: pttSetting === 'ControlLeft' || pttSetting === 'ControlRight',
      shiftKey: pttSetting === 'ShiftLeft' || pttSetting === 'ShiftRight',
    })
    return
  }

  // PTT Lab 键（右 Ctrl）
  if (labEnabled && e.code === PTT_LAB_CODE && !labKeyDown) {
    // 如果 PTT 主键也是右 Ctrl，不重复处理 lab
    if (pttCode === PTT_LAB_CODE) return
    labKeyDown = true
    e.preventDefault()
    console.log('[webview-kb] ptt-lab-event down (webview fallback)')
    emit('ptt-lab-event', {
      phase: 'down',
      vk: PTT_LAB_VK,
      timestamp: Date.now(),
    })
  }
}

function handleKeyUp(e: KeyboardEvent) {
  // PTT 主键
  if (pttCode && e.code === pttCode && pttKeyDown) {
    pttKeyDown = false
    if (isModifierSetting(pttSetting)) {
      e.preventDefault()
    }
    console.log('[webview-kb] ptt-up (webview fallback)', { code: e.code, pttSetting })
    emit('ptt-up', {
      source: 'webview_fallback',
      reason: 'keyup',
      vk: SETTING_TO_VK[pttSetting] || 0,
      keycode: SETTING_TO_VK[pttSetting] || 0,
      pttSetting,
      timestamp: Date.now(),
      altKey: pttSetting === 'AltLeft' || pttSetting === 'AltRight',
      ctrlKey: pttSetting === 'ControlLeft' || pttSetting === 'ControlRight',
      shiftKey: pttSetting === 'ShiftLeft' || pttSetting === 'ShiftRight',
    })
    return
  }

  // PTT Lab 键
  if (labEnabled && e.code === PTT_LAB_CODE && labKeyDown) {
    if (pttCode === PTT_LAB_CODE) return
    labKeyDown = false
    e.preventDefault()
    console.log('[webview-kb] ptt-lab-event up (webview fallback)')
    emit('ptt-lab-event', {
      phase: 'up',
      vk: PTT_LAB_VK,
      timestamp: Date.now(),
    })
  }
}

/** 刷新 PTT 设置（设置页面改键后调用） */
export async function refreshPTTSetting() {
  try {
    const setting = await getSetting('shortcutPTT', 'AltRight')
    pttSetting = String(setting || 'AltRight')
  } catch (error) {
    pttSetting = 'AltLeft'
    console.warn('[webview-kb] failed to load PTT setting, using fallback:', error)
  }
  pttCode = SETTING_TO_CODE[pttSetting] || ''
  pttKeyDown = false
  console.log('[webview-kb] PTT setting refreshed:', pttSetting, '→ code:', pttCode)
}

/** PTT Lab 启用/禁用 */
export function setLabEnabled(enabled: boolean) {
  labEnabled = enabled
  if (!enabled) labKeyDown = false
}

/** 启动 webview 键盘回退监听 */
export async function startWebviewKeyboardFallback() {
  if (started) return
  started = true

  await refreshPTTSetting()

  document.addEventListener('keydown', handleKeyDown, { capture: true })
  document.addEventListener('keyup', handleKeyUp, { capture: true })
  console.log('[webview-kb] started, pttSetting:', pttSetting, 'code:', pttCode)
}

/** 停止监听 */
export function stopWebviewKeyboardFallback() {
  if (!started) return
  started = false
  pttKeyDown = false
  labKeyDown = false
  document.removeEventListener('keydown', handleKeyDown, { capture: true })
  document.removeEventListener('keyup', handleKeyUp, { capture: true })
  console.log('[webview-kb] stopped')
}
