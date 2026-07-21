import * as bridge from '../services/bridge'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { addRuntimeEvent } from '../services/debugLog'

type OverlayState = 'waiting' | 'listening' | 'thinking' | 'fallback' | 'error' | 'toast'
type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow'

interface OverlayPayload {
  state?: OverlayState
  bars?: number[]
  elapsedSec?: number
  theme?: OverlayWaveTheme
  showDuration?: boolean
  barCount?: number
  fallbackText?: string
  fallbackReason?: string
  errorMessage?: string
  warning?: string
  toastText?: string
  /** toast 的语气：info=中性（如切换预设），warn=琥珀色+图标（如未检测到声音） */
  toastTone?: 'info' | 'warn'
  streaming?: boolean
  streamingText?: string
  _overlayShowId?: number
  _overlayGeneration?: number
  _overlayProbe?: boolean
}

const DEFAULT_BAR_COUNT = 24
const IDLE_BARS = Array(DEFAULT_BAR_COUNT).fill(3)

function normalizeTheme(theme: unknown): OverlayWaveTheme {
  if (theme === 'black-white' || theme === 'black-blue' || theme === 'black-rainbow') {
    return theme
  }
  return 'black-blue'
}

function getListeningBarColor(index: number, total: number, theme: OverlayWaveTheme): string {
  const safeTotal = Math.max(1, total - 1)
  const t = index / safeTotal

  if (theme === 'black-white') {
    return '#f1f5f9'
  }

  if (theme === 'black-rainbow') {
    const hue = 140 - Math.round(t * 110)
    const lightness = 64 - Math.round(Math.abs(t - 0.5) * 12)
    return `hsl(${hue} 95% ${lightness}%)`
  }

  const hue = 190 + Math.round(t * 30)
  const lightness = 62 - Math.round(Math.abs(t - 0.5) * 14)
  return `hsl(${hue} 90% ${lightness}%)`
}

function getTimerColor(theme: OverlayWaveTheme): string {
  if (theme === 'black-white') return '#e5e7eb'
  if (theme === 'black-rainbow') return '#fef08a'
  return '#bae6fd'
}

function getThinkingColor(theme: OverlayWaveTheme): string {
  if (theme === 'black-white') return '#e2e8f0'
  if (theme === 'black-rainbow') return '#facc15'
  return '#38bdf8'
}

export default function Overlay() {
  const [state, setState] = useState<OverlayState>('waiting')
  const [bars, setBars] = useState<number[]>(IDLE_BARS)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [theme, setTheme] = useState<OverlayWaveTheme>('black-blue')
  const [showDuration, setShowDuration] = useState(true)
  const [barCount, setBarCount] = useState(DEFAULT_BAR_COUNT)
  const [fallbackText, setFallbackText] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [toastText, setToastText] = useState('')
  const [toastTone, setToastTone] = useState<'info' | 'warn'>('info')
  const [streamingText, setStreamingText] = useState('')
  const [streamingOn, setStreamingOn] = useState(false)
  const [copied, setCopied] = useState(false)
  const [thinkingDuration, setThinkingDuration] = useState(0)
  const [warning, setWarning] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elapsedSecRef = useRef(0)

  // 根据录音时长计算预估处理时间（秒）
  const calculateThinkingDuration = (recordingSec: number): number => {
    if (recordingSec <= 5) return 2
    if (recordingSec <= 15) return 3
    if (recordingSec <= 30) return 4
    if (recordingSec <= 60) return 5
    if (recordingSec <= 120) return 7
    if (recordingSec <= 180) return 9
    if (recordingSec <= 240) return 11
    return 13 // 240秒以上（4-5分钟）
  }

  useEffect(() => {
    let disposed = false
    let removeOverlayListener: (() => void) | null = null

    const handleOverlayState = (data: unknown) => {
      const payload = data as OverlayPayload
      const nextElapsedSec = typeof payload.elapsedSec === 'number'
        ? payload.elapsedSec
        : elapsedSecRef.current

      if (payload.state) {
        setState(payload.state)
        if (payload.state !== 'listening') {
          setBars((prev) => Array(prev.length).fill(3))
          // 离开录音状态即清空实时文字气泡
          setStreamingText('')
          setStreamingOn(false)
        }
        setCopied(false)
        if (payload.state !== 'fallback' && hideTimerRef.current) {
          clearTimeout(hideTimerRef.current)
          hideTimerRef.current = null
        }
        if (payload.state === 'thinking') {
          setThinkingDuration(calculateThinkingDuration(nextElapsedSec))
        }
      }

      if (Array.isArray(payload.bars) && payload.bars.length > 0) setBars(payload.bars)
      if (typeof payload.elapsedSec === 'number') {
        elapsedSecRef.current = payload.elapsedSec
        setElapsedSec(payload.elapsedSec)
      }
      if (typeof payload.showDuration === 'boolean') setShowDuration(payload.showDuration)
      if (payload.theme) setTheme(normalizeTheme(payload.theme))
      if (typeof payload.barCount === 'number' && payload.barCount > 0) setBarCount(payload.barCount)
      if (typeof payload.fallbackText === 'string') setFallbackText(payload.fallbackText)
      if (typeof payload.errorMessage === 'string') setErrorMessage(payload.errorMessage)
      if (typeof payload.toastText === 'string') setToastText(payload.toastText)
      if (payload.toastTone === 'info' || payload.toastTone === 'warn') setToastTone(payload.toastTone)
      if (typeof payload.warning === 'string') setWarning(payload.warning)
      if (typeof payload.streamingText === 'string') setStreamingText(payload.streamingText)
      if (typeof payload.streaming === 'boolean') setStreamingOn(payload.streaming)
      if (payload.state === 'waiting') {
        setElapsedSec(0)
        setWarning('')
        setStreamingText('')
        setStreamingOn(false)
        setBars((prev) => Array(prev.length).fill(3))
      }

      if (!payload._overlayProbe) return
      const showId = payload._overlayShowId
      const generation = payload._overlayGeneration
      if (typeof showId !== 'number' || typeof generation !== 'number') return

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (disposed) return
          const root = rootRef.current
          const content = root?.querySelector<HTMLElement>('[data-overlay-content]') ?? null
          const rootRect = root?.getBoundingClientRect()
          const contentRect = content?.getBoundingClientRect()
          const style = content ? window.getComputedStyle(content) : null
          const healthy = Boolean(
            rootRect && contentRect
            && rootRect.width > 0 && rootRect.height > 0
            && contentRect.width > 0 && contentRect.height > 0
            && style?.display !== 'none'
            && style?.visibility !== 'hidden'
            && Number(style?.opacity ?? '1') > 0
          )
          void bridge.overlayRenderAck({
            showId,
            generation,
            healthy,
            overlayState: payload.state ?? 'unknown',
            documentVisibility: document.visibilityState,
            rootWidth: rootRect?.width ?? 0,
            rootHeight: rootRect?.height ?? 0,
            contentWidth: contentRect?.width ?? 0,
            contentHeight: contentRect?.height ?? 0,
            display: style?.display ?? 'missing',
            visibility: style?.visibility ?? 'missing',
            opacity: style?.opacity ?? 'missing',
          }).catch(() => {})
        })
      })
    }

    void bridge.listen<unknown>('overlay-state', (event) => handleOverlayState(event.payload))
      .then((unlisten) => {
        if (disposed) {
          unlisten()
          return
        }
        removeOverlayListener = unlisten
        void bridge.overlayReady().catch(() => {})
      })

    return () => {
      disposed = true
      removeOverlayListener?.()
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [])

  const showStreamingBubble = state === 'listening' && (streamingOn || streamingText.trim().length > 0)
  const hasStreamingText = streamingText.trim().length > 0

  const timerText = useMemo(() => `${Math.floor(elapsedSec)}s`, [elapsedSec])
  const timerColor = getTimerColor(theme)
  const thinkingColor = getThinkingColor(theme)

  const handleCopyFallback = async () => {
    if (!fallbackText) return

    try {
      await bridge.copyText(fallbackText)
      setCopied(true)
      addRuntimeEvent('info', 'overlay', '兜底卡片复制成功', { textLen: fallbackText.length })

      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
      hideTimerRef.current = setTimeout(() => {
        bridge.hideOverlay()
        hideTimerRef.current = null
      }, 500)
    } catch (error) {
      addRuntimeEvent('error', 'overlay', '兜底卡片复制失败', { error: String(error) })
    }
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none flex h-full items-end justify-center pb-4"
    >
      {state === 'fallback' ? (
        <div
          data-overlay-content
          className="pointer-events-auto flex w-full max-w-[520px] flex-col rounded-xl border px-4 py-4"
          style={{
            background: 'var(--overlay-bg)',
            color: 'var(--overlay-text)',
            borderColor: 'var(--overlay-border)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <span className="block text-xs font-medium tracking-[0.16em]" style={{ color: 'var(--overlay-text-muted)' }}>识别文本</span>
              <span className="block text-xs" style={{ color: 'var(--overlay-text-dim)' }}>
                当前目标不支持直接写入，文本已经复制到剪贴板。
              </span>
            </div>
            <button
              type="button"
              onClick={handleCopyFallback}
              title={copied ? '已复制' : '复制文本'}
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                copied
                  ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-white/10 bg-white/10 text-white/90 hover:bg-white/20'
              }`}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <div className="mt-4 flex-1 overflow-hidden rounded-lg px-3 py-3" style={{ background: 'var(--overlay-surface)' }}>
            <p className="max-h-[108px] overflow-auto pr-1 text-sm leading-6 select-text">
              {fallbackText || '（无文本）'}
            </p>
          </div>
        </div>
      ) : (
        <div data-overlay-content className="flex flex-col items-center gap-2">
          {showStreamingBubble && (
            <div
              className="pointer-events-none relative flex max-w-[440px] flex-col rounded-2xl border px-4 py-2.5"
              style={{
                background: 'var(--overlay-bg)',
                color: 'var(--overlay-text)',
                borderColor: 'var(--overlay-border)',
              }}
            >
              <span
                className="mb-1 text-[10px] font-medium tracking-[0.18em]"
                style={{ color: 'var(--overlay-text-muted)' }}
              >
                实时识别
              </span>
              {/* 内容驱动尺寸：小默认，随文字增行慢慢变大，超过 3 行才滚动，只显示最新内容 */}
              <div
                className="flex max-h-[72px] flex-col justify-end overflow-hidden text-left text-sm leading-6"
                style={{ color: hasStreamingText ? 'var(--overlay-text)' : 'var(--overlay-text-dim)' }}
              >
                <div>
                  {hasStreamingText ? streamingText : '正在聆听…'}
                  {hasStreamingText && (
                    <span
                      className="ml-0.5 inline-block h-[1.05em] w-[2px] rounded-full align-middle"
                      style={{
                        backgroundColor: 'var(--overlay-text)',
                        animation: 'caret-blink 1.1s ease-in-out infinite',
                      }}
                    />
                  )}
                </div>
              </div>
              {/* 底部朝下尖角：提示文字来自下方的录音胶囊 */}
              <span
                className="absolute left-1/2 h-0 w-0 -translate-x-1/2"
                style={{
                  bottom: '-7px',
                  borderLeft: '7px solid transparent',
                  borderRight: '7px solid transparent',
                  borderTop: '7px solid var(--overlay-bg)',
                }}
              />
            </div>
          )}
        <div
          className="flex items-center rounded-full border px-4 py-2"
          style={{
            background: 'var(--overlay-bg)',
            color: 'var(--overlay-text)',
            borderColor: 'var(--overlay-border)',
          }}
        >
          {state === 'waiting' && (
            <div className="flex items-center gap-[3px]" style={{ height: '20px' }}>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-[3px] w-[3px] rounded-full"
                  style={{
                    backgroundColor: 'var(--overlay-text-dim)',
                    animation: `dot-pulse 1s ease-in-out ${i * 0.15}s infinite`,
                  }}
                />
              ))}
            </div>
          )}

          {state === 'listening' && (
            <>
              <div className="flex items-center gap-[2px]" style={{ height: '20px' }}>
                {bars.map((height, index) => {
                  const color = getListeningBarColor(index, bars.length, theme)
                  return (
                    <div
                      key={index}
                      className="w-[2.5px] rounded-full"
                      style={{
                        backgroundColor: color,
                        boxShadow: 'none',
                        height: `${Math.min(18, Math.max(3, height))}px`,
                        opacity: 0.7 + (Math.min(18, height) / 18) * 0.3,
                        transition: 'height 50ms ease-out, opacity 50ms ease-out',
                      }}
                    />
                  )
                })}
              </div>
              {showDuration && (
                <span
                  className="ml-1.5 min-w-[24px] text-right font-mono tabular-nums text-xs"
                  style={{ color: timerColor }}
                >
                  {timerText}
                </span>
              )}
              {warning && (
                <span className="ml-2 whitespace-nowrap text-xs text-amber-400 animate-pulse">
                  {warning}
                </span>
              )}
            </>
          )}

          {state === 'thinking' && (
            <div className="flex items-center gap-2">
              <div className="relative h-1 w-12 overflow-hidden rounded-full bg-white/10">
                <div
                  className="absolute left-0 top-0 h-full rounded-full"
                  style={{
                    backgroundColor: thinkingColor,
                    width: '100%',
                    transformOrigin: 'left',
                    animation: `progress-fill ${thinkingDuration}s cubic-bezier(0.4, 0, 0.2, 1) forwards`,
                  }}
                />
              </div>
              <span className="text-xs whitespace-nowrap" style={{ color: thinkingColor }}>处理中</span>
            </div>
          )}

          {state === 'error' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-400">{errorMessage || '出错了'}</span>
            </div>
          )}

          {state === 'toast' && (
            <div className="flex items-center gap-2">
              {toastTone === 'warn' ? (
                <span className="whitespace-nowrap text-xs text-amber-400">{toastText}</span>
              ) : (
                <span className="whitespace-nowrap text-xs" style={{ color: 'var(--overlay-text)' }}>
                  {toastText}
                </span>
              )}
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  )
}
