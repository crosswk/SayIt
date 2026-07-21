import * as bridge from '../bridge'
import { getSetting } from '../store'
import { clampSec } from '../timeModel'
import {
  OVERLAY_WIDTH_PRESETS,
  type OverlayCommonPayload,
  type OverlayWaveTheme,
  type OverlayWidthPreset,
} from './types'

function normalizeTheme(value: unknown): OverlayWaveTheme {
  if (value === 'black-white' || value === 'black-blue' || value === 'black-rainbow') {
    return value
  }
  return 'black-blue'
}

function normalizeWidthPreset(value: unknown): OverlayWidthPreset {
  if (value === 'short' || value === 'medium' || value === 'long') return value
  return 'long'
}

export class OverlayService {
  private theme: OverlayWaveTheme = 'black-rainbow'
  private showDuration = true
  private readySoundEnabled = true
  private widthPreset: OverlayWidthPreset = 'medium'
  private lastFrameAt = 0
  private tickerId: ReturnType<typeof setInterval> | null = null
  private fallbackHideId: ReturnType<typeof setTimeout> | null = null
  /** Persistent warning text — included in every overlay update until cleared */
  private activeWarning = ''
  /** 流式实时识别文本 — 录音期间随中间结果更新，会被并入每次 listening 更新一起下发 */
  private streamingText = ''
  /** 本次录音是否开启流式实时显示：为真则从录音一开始就显示气泡（占位），中途不再缩放窗口 */
  private streamingActive = false

  constructor(private readonly getElapsedSec: () => number) {}

  async refreshSettings() {
    this.theme = normalizeTheme(await getSetting('overlayWaveTheme', 'black-rainbow'))
    this.showDuration = Boolean(await getSetting('overlayShowDuration', true))
    this.readySoundEnabled = Boolean(await getSetting('readySoundEnabled', true))
    this.widthPreset = normalizeWidthPreset(await getSetting('overlayWidth', 'medium'))
  }

  private readySoundCtx: AudioContext | null = null

  private playReadySound() {
    if (!this.readySoundEnabled) return
    try {
      if (!this.readySoundCtx || this.readySoundCtx.state === 'closed') {
        this.readySoundCtx = new AudioContext()
      }
      const ctx = this.readySoundCtx
      // AudioContext 新建或长时间无操作后常处于 suspended 状态（浏览器自动播放/省电策略）。
      // resume() 是异步的，若不等它完成就 start()，振荡器可能被静默丢弃或延迟——
      // 这正是「第一次按免提键听不到提示音，过一会又听不到」的根因。
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => this.emitReadyTone(ctx)).catch(() => { /* ignore */ })
      } else {
        this.emitReadyTone(ctx)
      }
    } catch { /* ignore */ }
  }

  private emitReadyTone(ctx: AudioContext) {
    try {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 880
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.2, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.15)
    } catch { /* ignore */ }
  }

  getCommonPayload(): OverlayCommonPayload {
    const cfg = OVERLAY_WIDTH_PRESETS[this.widthPreset]
    return {
      theme: this.theme,
      showDuration: this.showDuration,
      baseWidth: cfg.windowWidth,
      barCount: cfg.barCount,
    }
  }

  getBarCount(): number {
    return OVERLAY_WIDTH_PRESETS[this.widthPreset].barCount
  }

  showWaiting() {
    this.clearFallbackHideTimer()
    void bridge.presentOverlay({
      state: 'waiting',
      elapsedSec: 0,
      ...this.getCommonPayload(),
    })
  }

  startListeningTicker() {
    this.stopListeningTicker()
    this.playReadySound()
    this.tickerId = setInterval(() => {
      void bridge.updateOverlay({
        state: 'listening',
        elapsedSec: clampSec(this.getElapsedSec()),
        ...(this.activeWarning ? { warning: this.activeWarning } : {}),
        ...(this.streamingActive ? { streaming: true } : {}),
        ...(this.streamingText ? { streamingText: this.streamingText } : {}),
        ...this.getCommonPayload(),
      })
    }, 33)
  }

  /** 设置本次录音是否开启流式实时显示（录音开始时调用）。开启后气泡从一开始就显示占位。 */
  setStreamingActive(on: boolean) {
    this.streamingActive = on
  }

  /** 更新流式实时识别文本。下一次 listening 心跳（33ms）会把它带给悬浮窗一起渲染。
   *  传空字符串可清除气泡。 */
  setStreamingText(text: string) {
    this.streamingText = text || ''
  }

  /** 清除流式实时文本与激活标志（录音停止 / 重置时调用）。 */
  resetStreamingText() {
    this.streamingText = ''
    this.streamingActive = false
  }

  stopListeningTicker() {
    if (this.tickerId) {
      clearInterval(this.tickerId)
      this.tickerId = null
    }
  }

  pushListeningBars(bars?: number[], force = false) {
    const now = Date.now()
    if (!force && now - this.lastFrameAt < 33) return
    this.lastFrameAt = now
    void bridge.updateOverlay({
      state: 'listening',
      bars,
      elapsedSec: clampSec(this.getElapsedSec()),
      ...(this.activeWarning ? { warning: this.activeWarning } : {}),
      ...(this.streamingActive ? { streaming: true } : {}),
      ...(this.streamingText ? { streamingText: this.streamingText } : {}),
      ...this.getCommonPayload(),
    })
  }

  showThinking(elapsedSec: number) {
    void bridge.updateOverlay({
      state: 'thinking',
      elapsedSec: clampSec(elapsedSec),
      ...this.getCommonPayload(),
    })
  }

  /** Show a warning toast on the overlay (e.g. "单次记录最长300s") — persists until recording ends */
  showTimeoutWarning() {
    this.activeWarning = '单次记录最长300s'
    void bridge.updateOverlay({
      state: 'listening',
      warning: this.activeWarning,
      elapsedSec: clampSec(this.getElapsedSec()),
      ...this.getCommonPayload(),
    })
  }

  /** Show low volume warning on the overlay */
  showLowVolumeWarning() {
    if (this.activeWarning) return
    void bridge.updateOverlay({
      state: 'listening',
      warning: '请靠近麦克风',
      elapsedSec: clampSec(this.getElapsedSec()),
      ...this.getCommonPayload(),
    })
  }

  /** Clear transient warnings (low volume etc.) — does NOT clear timeout warning */
  clearWarning() {
    if (this.activeWarning) return
    void bridge.updateOverlay({
      state: 'listening',
      warning: '',
      elapsedSec: clampSec(this.getElapsedSec()),
      ...this.getCommonPayload(),
    })
  }

  /** Reset all warnings including persistent ones (called on recording stop/reset) */
  resetWarnings() {
    this.activeWarning = ''
  }

  showFallback(text: string, reason: string) {
    console.log('[OverlayService] showFallback called, text:', text.slice(0, 30), 'reason:', reason)
    void bridge.presentOverlay({
      state: 'fallback',
      fallbackText: text,
      fallbackReason: reason,
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => {
      console.log('[OverlayService] fallback auto-hide timer fired')
      void bridge.hideOverlay()
      this.clearFallbackHideTimer()
    }, 10000)
  }

  clearFallbackHideTimer() {
    if (this.fallbackHideId) {
      clearTimeout(this.fallbackHideId)
      this.fallbackHideId = null
    }
  }

  hide() {
    void bridge.hideOverlay()
  }

  /** 快捷键切换润色模式后，用悬浮窗短暂提示当前模式名，约 1.6s 后自动隐藏。 */
  showPresetSwitched(name: string) {
    void bridge.presentOverlay({
      state: 'toast',
      toastText: `已切换到「${name}」`,
      toastTone: 'info',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => {
      void bridge.hideOverlay()
      this.clearFallbackHideTimer()
    }, 1600)
  }

  /** 识别结果为空（未检测到有效声音）时的提示。停留约 2.5s 再自动隐藏，
   *  避免悬浮窗一闪而逝，让用户明白“这次没听到有效声音”而不是一头雾水。 */
  showNoSpeech() {
    void bridge.presentOverlay({
      state: 'toast',
      toastText: '未检测到有效声音',
      toastTone: 'warn',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => {
      void bridge.hideOverlay()
      this.clearFallbackHideTimer()
    }, 1500)
  }

  /** 显示错误信息，几秒后自动隐藏 */
  showError(message: string) {
    void bridge.presentOverlay({
      state: 'error',
      errorMessage: message,
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => {
      void bridge.hideOverlay()
      this.clearFallbackHideTimer()
    }, 4000)
  }

  dispose() {
    this.stopListeningTicker()
    this.clearFallbackHideTimer()
    this.resetStreamingText()
    void bridge.hideOverlay()
  }
}
