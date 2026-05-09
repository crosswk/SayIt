import * as bridge from '../bridge'
import { getSetting } from '../store'
import { clampSec } from '../timeModel'
import { OVERLAY_WIDTH_PRESETS, type OverlayCommonPayload, type OverlayWaveTheme, type OverlayWidthPreset } from './types'

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
      if (ctx.state === 'suspended') {
        void ctx.resume()
      }
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
    bridge.showOverlay()
    bridge.updateOverlay({
      state: 'waiting',
      elapsedSec: 0,
      ...this.getCommonPayload(),
    })
  }

  startListeningTicker() {
    this.stopListeningTicker()
    this.playReadySound()
    this.tickerId = setInterval(() => {
      bridge.updateOverlay({
        state: 'listening',
        elapsedSec: clampSec(this.getElapsedSec()),
        ...(this.activeWarning ? { warning: this.activeWarning } : {}),
        ...this.getCommonPayload(),
      })
    }, 33)
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
    bridge.updateOverlay({
      state: 'listening',
      bars,
      elapsedSec: clampSec(this.getElapsedSec()),
      ...(this.activeWarning ? { warning: this.activeWarning } : {}),
      ...this.getCommonPayload(),
    })
  }

  showThinking(elapsedSec: number) {
    bridge.updateOverlay({
      state: 'thinking',
      elapsedSec: clampSec(elapsedSec),
      ...this.getCommonPayload(),
    })
  }

  /** Show a warning toast on the overlay (e.g. "单次记录最长300s") — persists until recording ends */
  showTimeoutWarning() {
    this.activeWarning = '单次记录最长300s'
    bridge.updateOverlay({
      state: 'listening',
      warning: this.activeWarning,
      elapsedSec: clampSec(this.getElapsedSec()),
      ...this.getCommonPayload(),
    })
  }

  /** Show low volume warning on the overlay */
  showLowVolumeWarning() {
    // Don't override timeout warning
    if (this.activeWarning) return
    bridge.updateOverlay({
      state: 'listening',
      warning: '音量过低，请靠近麦克风',
      elapsedSec: clampSec(this.getElapsedSec()),
      ...this.getCommonPayload(),
    })
  }

  /** Clear transient warnings (low volume etc.) — does NOT clear timeout warning */
  clearWarning() {
    if (this.activeWarning) return
    bridge.updateOverlay({
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
    // Send fallback state to overlay — overlay should already be visible from thinking state.
    // Also send show-overlay as a safety net in case overlay was hidden.
    bridge.updateOverlay({
      state: 'fallback',
      fallbackText: text,
      fallbackReason: reason,
      ...this.getCommonPayload(),
    })
    bridge.showOverlay()
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => {
      console.log('[OverlayService] fallback auto-hide timer fired')
      bridge.hideOverlay()
      this.clearFallbackHideTimer()
    }, 15000)
  }

  clearFallbackHideTimer() {
    if (this.fallbackHideId) {
      clearTimeout(this.fallbackHideId)
      this.fallbackHideId = null
    }
  }

  hide() {
    bridge.hideOverlay()
  }

  /** 显示错误信息，几秒后自动隐藏 */
  showError(message: string) {
    bridge.updateOverlay({
      state: 'error',
      errorMessage: message,
      ...this.getCommonPayload(),
    })
    bridge.showOverlay()
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => {
      bridge.hideOverlay()
      this.clearFallbackHideTimer()
    }, 4000)
  }

  dispose() {
    this.stopListeningTicker()
    this.clearFallbackHideTimer()
    bridge.hideOverlay()
  }
}
