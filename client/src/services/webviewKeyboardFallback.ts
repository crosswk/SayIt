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
import { IS_MAC } from '@/lib/platform'
import { getPTTPhysicalKeyStates } from './bridge'
import { getSetting } from './store'
import { getDefault } from './defaults'
import {
  canonicalizePTTShortcut,
  isPTTModifierCode,
  isValidPTTShortcut,
  parsePTTShortcut,
  PTT_CODE_TO_VK,
  SETTING_TO_VK,
  settingToCode,
} from '@/lib/shortcutKeys'

// PTT Lab 固定使用右 Ctrl
const PTT_LAB_CODE = 'ControlRight'
const PTT_LAB_VK = 0xa3

let pttCodes: string[] = []
let pttSetting = ''
let pttKeyDown = false
const pttPressed = new Set<string>()
const pttConsumedCodes = new Set<string>()
let pttStartCheckToken = 0
let pttStartCheckPending = false
let hfCode = ''
let hfSetting = ''
let hfKeyDown = false
let labKeyDown = false
let labEnabled = false
let started = false
// 设置页正在录制快捷键：此时按键要交给录制框去绑定，不能再当成“用户按了热键”。
// 不挂起的话，按到已绑定的键（如免提的右 Alt）会从这里 emit toggle-hands-free，
// 于是弹出悬浮窗开始录音——而不是把这个键录进设置里。
let captureActive = false

function isModifierSetting(setting: string) {
  return ['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(setting)
}

function pttModifierFlags() {
  return {
    altKey: pttCodes.some((code) => code.startsWith('Alt')),
    ctrlKey: pttCodes.some((code) => code.startsWith('Control')),
    shiftKey: pttCodes.some((code) => code.startsWith('Shift')),
    metaKey: pttCodes.some((code) => code.startsWith('Meta')),
  }
}

/**
 * 旧单键仍按原行为吞 down。普通组合仅在主键首次按下时全部修饰成员已经按住，
 * 才吞主键并记住配对 up；K→Ctrl 顺序仍可开始 PTT，但 K 的 down/up 都放行。
 */
function shouldConsumePTTDown(code: string, wasPressed: boolean) {
  if (pttCodes.length === 1) return true
  if (isPTTModifierCode(code)) return false
  if (wasPressed) return pttConsumedCodes.has(code)
  return pttCodes
    .filter(isPTTModifierCode)
    .every((modifier) => pttPressed.has(modifier))
}

function reconcileStalePTTModifiers(event: KeyboardEvent) {
  for (const code of [...pttPressed]) {
    if (code === event.code || !isPTTModifierCode(code)) continue
    const physicallyDown = code.startsWith('Control')
      ? event.ctrlKey
      : code.startsWith('Alt')
        ? event.altKey
        : code.startsWith('Shift')
          ? event.shiftKey
          : event.metaKey
    if (!physicallyDown) {
      pttPressed.delete(code)
      pttConsumedCodes.delete(code)
    }
  }
}

function invalidatePTTStartCheck() {
  pttStartCheckToken += 1
  pttStartCheckPending = false
}

/**
 * 当完整组合由修饰键最后按下时（K→Ctrl 或纯修饰组合），KeyboardEvent 无法证明
 * 之前成员仍真实按住，也无法区分左右同族修饰键；用 Rust/GetAsyncKeyState 做一次确认。
 */
async function confirmPhysicalPTTStart(triggerCode: string) {
  if (pttStartCheckPending) return
  pttStartCheckPending = true
  const token = ++pttStartCheckToken
  const codes = [...pttCodes]
  const setting = pttSetting

  try {
    const physicalStates = await getPTTPhysicalKeyStates(codes)
    if (token !== pttStartCheckToken) return

    codes.forEach((code, index) => {
      if (!physicalStates[index]) {
        pttPressed.delete(code)
        pttConsumedCodes.delete(code)
      }
    })

    const allStillDown = physicalStates.length === codes.length
      && physicalStates.every(Boolean)
      && codes.every((code) => pttPressed.has(code))
    if (!captureActive && !pttKeyDown && pttSetting === setting && allStillDown) {
      pttKeyDown = true
      emitPTT('down', triggerCode, 'physical_members_confirmed')
    }
  } catch (error) {
    console.warn('[webview-kb] failed to verify physical PTT state:', error)
  } finally {
    if (token === pttStartCheckToken) pttStartCheckPending = false
  }
}

function emitPTT(phase: 'down' | 'up', triggerCode: string, reason: string) {
  const vk = PTT_CODE_TO_VK[triggerCode] || 0
  console.log(`[webview-kb] ptt-${phase} (webview fallback)`, {
    code: triggerCode,
    pttSetting,
    reason,
  })
  void emit(`ptt-${phase}`, {
    source: 'webview_fallback',
    reason,
    vk,
    keycode: vk,
    pttSetting,
    timestamp: Date.now(),
    ...pttModifierFlags(),
  })
}

function releasePTT(reason: string, triggerCode = pttCodes[0] || '') {
  invalidatePTTStartCheck()
  if (pttKeyDown) {
    pttKeyDown = false
    emitPTT('up', triggerCode, reason)
  }
  pttPressed.clear()
  pttConsumedCodes.clear()
}

function handleKeyDown(event: KeyboardEvent) {
  if (captureActive) return

  if (pttCodes.includes(event.code)) {
    reconcileStalePTTModifiers(event)
    const wasPressed = pttPressed.has(event.code)
    const consumeDown = shouldConsumePTTDown(event.code, wasPressed)
    if (consumeDown) {
      if (pttCodes.length > 1) pttConsumedCodes.add(event.code)
      event.preventDefault()
    }
    pttPressed.add(event.code)
    if (!pttKeyDown && pttCodes.every((code) => pttPressed.has(code))) {
      if (pttCodes.length > 1 && isPTTModifierCode(event.code)) {
        void confirmPhysicalPTTStart(event.code)
      } else {
        invalidatePTTStartCheck()
        pttKeyDown = true
        emitPTT('down', event.code, 'all_members_down')
      }
    }
    return
  }

  // 免提键（HF）：首个 keydown 立即触发；后续 repeat down 不重复切换。
  if (hfCode && event.code === hfCode && !pttCodes.includes(hfCode)) {
    if (!hfKeyDown) {
      hfKeyDown = true
      console.log('[webview-kb] toggle-hands-free (webview fallback)', {
        code: event.code,
        hfSetting,
      })
      void emit('toggle-hands-free', {
        source: 'webview_fallback',
        vk: SETTING_TO_VK[hfSetting] || 0,
      })
    }
    if (isModifierSetting(hfSetting)) event.preventDefault()
    return
  }

  // PTT Lab 键（右 Ctrl）
  if (labEnabled && event.code === PTT_LAB_CODE && !labKeyDown) {
    // 如果右 Ctrl 是 PTT 的成员，不重复处理 lab。
    if (pttCodes.includes(PTT_LAB_CODE)) return
    labKeyDown = true
    event.preventDefault()
    console.log('[webview-kb] ptt-lab-event down (webview fallback)')
    void emit('ptt-lab-event', {
      phase: 'down',
      vk: PTT_LAB_VK,
      timestamp: Date.now(),
    })
  }
}

function handleKeyUp(event: KeyboardEvent) {
  if (captureActive) return

  if (pttCodes.includes(event.code)) {
    invalidatePTTStartCheck()
    if (pttCodes.length === 1 || pttConsumedCodes.delete(event.code)) {
      event.preventDefault()
    }
    const wasPressed = pttPressed.delete(event.code)
    if (wasPressed && pttKeyDown) {
      pttKeyDown = false
      emitPTT('up', event.code, 'member_up')
    }
    return
  }

  // 免提键：keyup 只重新布防，下一次物理按下才能再次切换。
  if (hfCode && event.code === hfCode && hfKeyDown && !pttCodes.includes(hfCode)) {
    hfKeyDown = false
    if (isModifierSetting(hfSetting)) event.preventDefault()
    return
  }

  // PTT Lab 键
  if (labEnabled && event.code === PTT_LAB_CODE && labKeyDown) {
    if (pttCodes.includes(PTT_LAB_CODE)) return
    labKeyDown = false
    event.preventDefault()
    console.log('[webview-kb] ptt-lab-event up (webview fallback)')
    void emit('ptt-lab-event', {
      phase: 'up',
      vk: PTT_LAB_VK,
      timestamp: Date.now(),
    })
  }
}

function handleWindowBlur() {
  // 焦点转移后，keyup 可能送到别的窗口；立即释放，避免前端 fallback 留下活动录音。
  releasePTT('window_blur')
  hfKeyDown = false
  labKeyDown = false
}

/** 刷新 PTT 设置（设置页面改键后调用） */
export async function refreshPTTSetting() {
  try {
    // 不传字面量兜底值：默认键只在 services/defaults.ts 里定义一处，getSetting 会去读它。
    const setting = await getSetting<string>('shortcutPTT')
    const loadedSetting = String(setting ?? '')
    if (!loadedSetting) {
      pttSetting = ''
      pttCodes = []
    } else {
      const canonical = canonicalizePTTShortcut(loadedSetting)
      // allowLegacyReservedKeys：老用户存的可能是 Shift。那类绑定不再允许新设，
      // 但已经存在的必须照原样监听 —— 判成非法就会走下面的回落，等于用户没改设置
      // 却换了说话键，而且会开始响应一个他没绑过的键。
      pttSetting = isValidPTTShortcut(canonical, { allowLegacyReservedKeys: true })
        ? canonical
        : getDefault<string>('shortcutPTT', '')
      pttCodes = parsePTTShortcut(pttSetting)
      if (pttSetting !== canonical) {
        console.warn('[webview-kb] invalid PTT setting, falling back to the default:', loadedSetting)
      }
    }
  } catch (error) {
    pttSetting = getDefault<string>('shortcutPTT', '')
    pttCodes = parsePTTShortcut(pttSetting)
    console.warn('[webview-kb] failed to load PTT setting, using fallback:', error)
  }
  releasePTT('setting_refreshed')

  try {
    const hfSettingVal = await getSetting('shortcutHandsFree', 'AltRight')
    hfSetting = String(hfSettingVal ?? 'AltRight')
  } catch {
    hfSetting = 'AltRight'
  }
  hfCode = settingToCode(hfSetting)
  hfKeyDown = false

  console.log('[webview-kb] PTT setting refreshed:', pttSetting, '→ codes:', pttCodes)
  console.log('[webview-kb] HF setting refreshed:', hfSetting, '→ code:', hfCode)
}

/**
 * 挂起/恢复本回退监听（设置页开始/结束录制快捷键时调用）。
 * 进出时都清掉“按住”状态：录制期间被忽略的 keyup 不会留下卡住的按下标记。
 */
export function setShortcutCaptureActive(active: boolean) {
  if (active) releasePTT('shortcut_capture')
  captureActive = active
  pttPressed.clear()
  hfKeyDown = false
  labKeyDown = false
}

/** PTT Lab 启用/禁用 */
export function setLabEnabled(enabled: boolean) {
  labEnabled = enabled
  if (!enabled) labKeyDown = false
}

/** 启动 webview 键盘回退监听 */
export async function startWebviewKeyboardFallback() {
  if (started) return
  // macOS 的 CGEventTap 在 SayIt 自己聚焦时也能收到按键（不像 WebView2 会吞掉低级钩子），
  // 再从 DOM 补发一遍就会重复触发 ptt-down / toggle-hands-free。
  if (IS_MAC) return
  started = true

  await refreshPTTSetting()

  document.addEventListener('keydown', handleKeyDown, { capture: true })
  document.addEventListener('keyup', handleKeyUp, { capture: true })
  window.addEventListener('blur', handleWindowBlur)
  console.log('[webview-kb] started, pttSetting:', pttSetting, 'codes:', pttCodes)
}

/** 停止监听 */
export function stopWebviewKeyboardFallback() {
  if (!started) return
  started = false
  releasePTT('fallback_stopped')
  hfKeyDown = false
  labKeyDown = false
  document.removeEventListener('keydown', handleKeyDown, { capture: true })
  document.removeEventListener('keyup', handleKeyUp, { capture: true })
  window.removeEventListener('blur', handleWindowBlur)
  console.log('[webview-kb] stopped')
}
