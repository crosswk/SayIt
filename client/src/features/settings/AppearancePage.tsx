// 外观设置页面 — 主题 + 悬浮窗样式 + 预览

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { themeList } from '@/themes'
import { switchTheme, getActiveThemeId } from '@/stores/theme'
import { getSetting, setSetting } from '@/services/store'
import { refreshRecorderSettings } from '@/services/recorder'
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

function OverlayPreview({ theme, showDuration, barCount }: { theme: OverlayWaveTheme; showDuration: boolean; barCount: number }) {
  const [bars, setBars] = useState<number[]>(Array.from({ length: barCount }, () => 3))

  useEffect(() => {
    setBars(Array.from({ length: barCount }, () => 3))
  }, [barCount])

  useEffect(() => {
    let running = true
    const animate = () => {
      if (!running) return
      setBars((prev) =>
        prev.map((v) => {
          const target = 3 + Math.random() * 15
          return v + (target - v) * 0.15
        }),
      )
      requestAnimationFrame(animate)
    }
    requestAnimationFrame(animate)
    return () => { running = false }
  }, [barCount])

  return (
    <div className="flex flex-col items-center gap-3">
      {/* 1:1 还原真实悬浮窗样式 */}
      <div className="flex items-center rounded-full border border-slate-600 bg-black px-4 py-2 shadow-[0_6px_16px_rgba(0,0,0,0.35)]">
        <div className="flex items-center gap-[2px]" style={{ height: '20px' }}>
          {bars.map((height, index) => {
            const h = Math.min(18, Math.max(3, height))
            const color = getBarColor(index, bars.length, theme)
            return (
              <div
                key={index}
                className="w-[2.5px] rounded-full"
                style={{
                  backgroundColor: color,
                  height: `${h}px`,
                  opacity: 0.7 + (h / 18) * 0.3,
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
  }, [])

  const handleThemeChange = async (themeId: string) => {
    await switchTheme(themeId)
    setActiveTheme(themeId)
  }

  const handleOverlayThemeChange = async (theme: OverlayWaveTheme) => {
    setOverlayWaveTheme(theme)
    await setSetting('overlayWaveTheme', theme)
    await refreshRecorderSettings()
  }

  const handleToggleDuration = async () => {
    const next = !overlayShowDuration
    setOverlayShowDuration(next)
    await setSetting('overlayShowDuration', next)
    await refreshRecorderSettings()
  }

  const handleOverlayWidthChange = async (preset: OverlayWidthPreset) => {
    setOverlayWidth(preset)
    await setSetting('overlayWidth', preset)
    await refreshRecorderSettings()
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

                <div className="mt-4 flex justify-center">
                  <OverlayPreview theme={overlayWaveTheme} showDuration={overlayShowDuration} barCount={OVERLAY_WIDTH_PRESETS[overlayWidth].barCount} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
