// 外观设置页面 — 主题 + 悬浮窗样式 + 预览

import { useEffect, useRef, useState } from 'react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { ExternalLink, Info } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { themeList } from '@/themes'
import { switchTheme, getActiveThemeId } from '@/stores/theme'
import { getSetting, setSetting } from '@/services/store'
import { refreshOverlaySettings, setStreamingDisplayCache } from '@/services/recorder'
import { OVERLAY_WIDTH_PRESETS, type OverlayWidthPreset } from '@/services/recorder/types'
import { type OverlayWaveTheme } from './utils'

const OVERLAY_OPTIONS: Array<{
  theme: OverlayWaveTheme
  label: string
  barColors: string[]
}> = [
  { theme: 'black-white', label: '黑底白色', barColors: ['#e2e8f0', '#cbd5e1', '#94a3b8'] },
  { theme: 'black-blue', label: '黑底蓝色', barColors: ['#22d3ee', '#3b82f6', '#6366f1'] },
  { theme: 'black-rainbow', label: '黑底彩色', barColors: ['#4ade80', '#facc15', '#fb923c', '#f87171'] },
]

const WIDTH_OPTIONS: Array<{ value: OverlayWidthPreset; label: string }> = [
  { value: 'short', label: '短' },
  { value: 'medium', label: '中' },
  { value: 'long', label: '长' },
]

function getBarColor(index: number, total: number, theme: OverlayWaveTheme): string {
  const t = index / Math.max(1, total - 1)
  if (theme === 'black-white') return '#f1f5f9'
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



const STREAMING_PREVIEW_TEXT = '今天下午三点和团队开个会，把新版本的方案先过一遍'

function OverlayPreview({ theme, showDuration, barCount, streaming }: { theme: OverlayWaveTheme; showDuration: boolean; barCount: number; streaming: boolean }) {
  const barRefs = useRef<Array<HTMLDivElement | null>>([])
  const [typed, setTyped] = useState('')

  // 流式预览：循环把示例文字一个字一个字打出来，模拟"边说边出字"的动态效果
  useEffect(() => {
    if (!streaming) {
      setTyped('')
      return
    }
    let i = 0
    let timer: ReturnType<typeof setTimeout>
    const step = () => {
      if (i <= STREAMING_PREVIEW_TEXT.length) {
        setTyped(STREAMING_PREVIEW_TEXT.slice(0, i))
        i += 1
        timer = setTimeout(step, 130)
      } else {
        // 打完停顿一下再从头循环
        timer = setTimeout(() => { i = 0; step() }, 1600)
      }
    }
    step()
    return () => clearTimeout(timer)
  }, [streaming])

  useEffect(() => {
    const heights = new Array(barCount).fill(3)
    let running = true
    let rafId = 0
    let lastFrame = 0
    const FRAME_INTERVAL = 1000 / 30 // 30fps 足够流畅，且不占满主线程

    const animate = (now: number) => {
      if (!running) return
      if (now - lastFrame >= FRAME_INTERVAL) {
        lastFrame = now
        for (let i = 0; i < heights.length; i++) {
          const target = 3 + Math.random() * 15
          heights[i] = heights[i] + (target - heights[i]) * 0.15
          const el = barRefs.current[i]
          if (el) {
            const h = Math.min(18, Math.max(3, heights[i]))
            el.style.height = `${h}px`
            el.style.opacity = String(0.7 + (h / 18) * 0.3)
          }
        }
      }
      rafId = requestAnimationFrame(animate)
    }
    rafId = requestAnimationFrame(animate)
    return () => {
      running = false
      cancelAnimationFrame(rafId)
    }
  }, [barCount])

  return (
    <div className="flex flex-col items-center gap-3">
      {/* 流式实时字幕气泡（开启时显示，带打字动画） */}
      {streaming && (
        <div className="relative w-[260px] rounded-2xl border border-slate-600 bg-black px-3.5 py-2.5 shadow-[0_6px_16px_rgba(0,0,0,0.35)]">
          <span className="mb-1 block text-[10px] font-medium tracking-[0.18em] text-slate-400">实时识别</span>
          {/* 内容驱动、底部对齐，和真实悬浮窗一致 */}
          <div className="flex max-h-[40px] flex-col justify-end overflow-hidden text-left text-[13px] leading-5 text-slate-100">
            <div>
              {typed}
              <span
                className="ml-0.5 inline-block h-[1.05em] w-[2px] rounded-full align-middle"
                style={{ backgroundColor: '#f1f5f9', animation: 'caret-blink 1.1s ease-in-out infinite' }}
              />
            </div>
          </div>
          {/* 朝下尖角，指向下方录音胶囊 */}
          <span
            className="absolute left-1/2 -translate-x-1/2"
            style={{ bottom: '-7px', width: 0, height: 0, borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderTop: '7px solid #000' }}
          />
        </div>
      )}
      {/* 1:1 还原真实悬浮窗样式 */}
      <div className="flex items-center rounded-full border border-slate-600 bg-black px-4 py-2 shadow-[0_6px_16px_rgba(0,0,0,0.35)]">
        <div className="flex items-center gap-[2px]" style={{ height: '20px' }}>
          {Array.from({ length: barCount }, (_, index) => {
            const color = getBarColor(index, barCount, theme)
            return (
              <div
                key={index}
                ref={(el) => { barRefs.current[index] = el }}
                className="w-[2.5px] rounded-full"
                style={{
                  backgroundColor: color,
                  height: '3px',
                  opacity: 0.7,
                  transition: 'height 50ms ease-out, opacity 50ms ease-out',
                }}
              />
            )
          })}
        </div>
        {showDuration && (
          <span
            className="ml-1.5 min-w-[24px] text-right font-mono tabular-nums text-xs"
            style={{ color: getTimerColor(theme) }}
          >
            3.2s
          </span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">悬浮窗预览</span>
    </div>
  )
}

export default function AppearancePage() {
  const [activeTheme, setActiveTheme] = useState(getActiveThemeId)
  const [overlayWaveTheme, setOverlayWaveTheme] = useState<OverlayWaveTheme>('black-rainbow')
  const [overlayShowDuration, setOverlayShowDuration] = useState(true)
  const [overlayWidth, setOverlayWidth] = useState<OverlayWidthPreset>('medium')
  const [streamingDisplay, setStreamingDisplay] = useState(false)

  useEffect(() => {
    getSetting('overlayWaveTheme', 'black-rainbow').then((value) => {
      const v = value as OverlayWaveTheme
      if (v === 'black-white' || v === 'black-blue' || v === 'black-rainbow') setOverlayWaveTheme(v)
    })
    getSetting('overlayShowDuration', true).then((value) => setOverlayShowDuration(Boolean(value)))
    getSetting('overlayWidth', 'medium').then((value) => {
      const v = value as OverlayWidthPreset
      if (v === 'short' || v === 'medium' || v === 'long') setOverlayWidth(v)
    })
    getSetting('streamingDisplayEnabled', false).then((value) => setStreamingDisplay(Boolean(value)))
  }, [])

  const handleThemeChange = async (themeId: string) => {
    await switchTheme(themeId)
    setActiveTheme(themeId)
  }

  const handleOverlayThemeChange = async (theme: OverlayWaveTheme) => {
    setOverlayWaveTheme(theme)
    await setSetting('overlayWaveTheme', theme)
    await refreshOverlaySettings()
  }

  const handleToggleDuration = async () => {
    const next = !overlayShowDuration
    setOverlayShowDuration(next)
    await setSetting('overlayShowDuration', next)
    await refreshOverlaySettings()
  }

  const handleOverlayWidthChange = async (preset: OverlayWidthPreset) => {
    setOverlayWidth(preset)
    await setSetting('overlayWidth', preset)
    await refreshOverlaySettings()
  }

  const handleToggleStreamingDisplay = () => {
    const next = !streamingDisplay
    setStreamingDisplay(next)
    setStreamingDisplayCache(next) // 立即同步录音器缓存，无需重启即可生效
    void setSetting('streamingDisplayEnabled', next)
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">外观</h1>

      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">应用主题</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {themeList.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => void handleThemeChange(theme.id)}
                  className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                    activeTheme === theme.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-accent'
                  }`}
                >
                  <div className="flex gap-1">
                    {Object.values(theme.previewColors).map((color, i) => (
                      <span
                        key={i}
                        className="h-5 w-5 rounded-full border border-border/50"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                  <span className="text-sm font-medium">{theme.name}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">悬浮窗样式</h2>

            <div className="space-y-4">
              <div>
                <p className="mb-2 text-sm text-muted-foreground">波形主题</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {OVERLAY_OPTIONS.map((option) => (
                    <button
                      key={option.theme}
                      type="button"
                      onClick={() => void handleOverlayThemeChange(option.theme)}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors ${
                        overlayWaveTheme === option.theme
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-accent'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${overlayWaveTheme === option.theme ? 'border-primary' : 'border-muted-foreground/40'}`}>
                          {overlayWaveTheme === option.theme && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        <span>{option.label}</span>
                      </span>
                      <span className="flex gap-0.5">
                        {option.barColors.map((c, i) => (
                          <span key={i} className="h-3 w-1 rounded-sm" style={{ backgroundColor: c }} />
                        ))}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-4">
                  <p className="mb-2 text-sm text-muted-foreground">悬浮窗长度</p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {WIDTH_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => void handleOverlayWidthChange(option.value)}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                          overlayWidth === option.value
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:bg-accent'
                        }`}
                      >
                        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${overlayWidth === option.value ? 'border-primary' : 'border-muted-foreground/40'}`}>
                          {overlayWidth === option.value && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        <span>{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">显示按住时长</p>
                    <p className="text-xs text-muted-foreground">关闭后仅显示波形</p>
                  </div>
                  <Switch checked={overlayShowDuration} onChange={handleToggleDuration} />
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <div className="pr-3">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium">流式实时字幕</p>
                      <Tooltip
                        variant="light"
                        content={'开启后走「双向流式」实时通路：边说边出字、更快，但整体准确率略低、热词效果明显减弱。\n关闭则用更准的通路（准确率更高、热词更准），只是没有边说边出字的效果。\n如果你很看重专有名词 / 热词的识别准确率，建议关闭。'}
                      >
                        <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
                      </Tooltip>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      说话时在悬浮窗上实时显示识别文字
                      <span className="text-muted-foreground/70">
                        （支持豆包、千问实时 ASR；豆包需开通「流式语音识别 2.0」
                      </span>
                      <button
                        type="button"
                        onClick={() => void shellOpen('https://console.volcengine.com/speech/new/setting/activate?projectName=default')}
                        className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2 decoration-primary/50 transition-colors hover:decoration-primary"
                      >
                        前往开通
                        <ExternalLink className="h-3 w-3" />
                      </button>
                      <span className="text-muted-foreground/70">，千问需填业务空间 ID）</span>
                    </p>
                  </div>
                  <Switch checked={streamingDisplay} onChange={handleToggleStreamingDisplay} />
                </div>

                <div className="mt-4 flex justify-center">
                  <OverlayPreview theme={overlayWaveTheme} showDuration={overlayShowDuration} barCount={OVERLAY_WIDTH_PRESETS[overlayWidth].barCount} streaming={streamingDisplay} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
