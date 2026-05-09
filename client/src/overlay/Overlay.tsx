import * as bridge from '../services/bridge'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { addRuntimeEvent } from '../services/debugLog'

type OverlayState = 'waiting' | 'listening' | 'thinking' | 'fallback' | 'error'
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
  const [copied, setCopied] = useState(false)
  const [thinkingDuration, setThinkingDuration] = useState(0)
  const [warning, setWarning] = useState('')
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
    bridge.onOverlayState((data: unknown) => {
      const payload = data as OverlayPayload
      const nextElapsedSec = typeof payload.elapsedSec === 'number'
        ? payload.elapsedSec
        : elapsedSecRef.current

      if (payload.state) {
        setState(payload.state)
        if (payload.state !== 'listening') {
          setBars((prev) => Array(prev.length).fill(3))
        }
        setCopied(false)
        if (payload.state !== 'fallback' && hideTimerRef.current) {
          clearTimeout(hideTimerRef.current)
          hideTimerRef.current = null
        }
        // 进入 thinking 状态时计算预估时长
        if (payload.state === 'thinking') {
          const duration = calculateThinkingDuration(nextElapsedSec)
          setThinkingDuration(duration)
        }
      }

      if (Array.isArray(payload.bars) && payload.bars.length > 0) {
        setBars(payload.bars)
      }
      if (typeof payload.elapsedSec === 'number') {
        elapsedSecRef.current = payload.elapsedSec
        setElapsedSec(payload.elapsedSec)
      }
      if (typeof payload.showDuration === 'boolean') {
        setShowDuration(payload.showDuration)
      }
      if (payload.theme) {
        setTheme(normalizeTheme(payload.theme))
      }
      if (typeof payload.barCount === 'number' && payload.barCount > 0) {
        setBarCount(payload.barCount)
      }
      if (typeof payload.fallbackText === 'string') {
        setFallbackText(payload.fallbackText)
      }
      if (typeof payload.errorMessage === 'string') {
        setErrorMessage(payload.errorMessage)
      }
      if (typeof payload.warning === 'string') {
        setWarning(payload.warning)
      }
      if (payload.state === 'waiting') {
        setElapsedSec(0)
        setWarning('')
        setBars((prev) => Array(prev.length).fill(3))
      }
    })

    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [])

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
      }, 1400)
    } catch (error) {
      addRuntimeEvent('error', 'overlay', '兜底卡片复制失败', { error: String(error) })
    }
  }

  return (
    <div className="pointer-events-none flex h-full items-end justify-center pb-4">
      {state === 'fallback' ? (
        <div
          className="pointer-events-auto flex w-full max-w-[520px] flex-col rounded-xl border px-4 py-4 shadow-[0_8px_20px_rgba(0,0,0,0.25)]"
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
        <div
          className="flex items-center rounded-full border px-4 py-2 shadow-[0_6px_16px_rgba(0,0,0,0.35)]"
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
                <span className="ml-2 text-xs text-amber-400 animate-pulse">
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
        </div>
      )}
    </div>
  )
}
