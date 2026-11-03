// 外观设置页面 — 主题 + 悬浮窗样式 + 预览

import { useEffect, useMemo, useRef, useState } from 'react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { ExternalLink, Info } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { themeList } from '@/themes'
import { switchTheme, getActiveThemeId } from '@/stores/theme'
import { getSetting, setSetting } from '@/services/store'
import { refreshOverlaySettings, setStreamingDisplayCache } from '@/services/recorder'
import { OVERLAY_WIDTH_PRESETS, type OverlayWidthPreset } from '@/services/recorder/types'
import {
  buildWavePalette,
  DEFAULT_CUSTOM_WAVE,
  getWaveTimerColor,
  normalizeCustomWave,
  normalizeWaveTheme,
  type CustomWaveColors,
  type OverlayWaveTheme,
} from '@/lib/overlayWaveColors'
import { CustomWaveEditor } from './CustomWaveEditor'
import { type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

const OVERLAY_OPTIONS: Array<{
  theme: Exclude<OverlayWaveTheme, 'custom'>
  labelKey: TranslationKey
  barColors: string[]
}> = [
    { theme: 'black-white', labelKey: 'appearance.wave.blackWhite', barColors: ['#e2e8f0', '#cbd5e1', '#94a3b8'] },
    { theme: 'black-blue', labelKey: 'appearance.wave.blackBlue', barColors: ['#22d3ee', '#3b82f6', '#6366f1'] },
    { theme: 'black-rainbow', labelKey: 'appearance.wave.blackRainbow', barColors: ['#4ade80', '#facc15', '#fb923c', '#f87171'] },
  ]

/** 自定义配色连续拖动取色器时，写盘与刷新悬浮窗设置合并到停手之后。 */
const CUSTOM_WAVE_SAVE_DELAY_MS = 250

// 由长到短排列：从「最完整」往「最克制」读，比反过来更符合挑尺寸的直觉。
const WIDTH_OPTIONS: Array<{ value: OverlayWidthPreset; labelKey: TranslationKey }> = [
  { value: 'long', labelKey: 'appearance.width.long' },
  { value: 'medium', labelKey: 'appearance.width.medium' },
  { value: 'short', labelKey: 'appearance.width.short' },
]

function OverlayPreview({ theme, customWave, showDuration, barCount, streaming }: {
  theme: OverlayWaveTheme
  customWave: CustomWaveColors
  showDuration: boolean
  barCount: number
  streaming: boolean
}) {
  const t = useT()
  const palette = useMemo(() => buildWavePalette(barCount, theme, customWave), [barCount, theme, customWave])
  const previewText = t('appearance.streamingPreviewText')
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
      if (i <= previewText.length) {
        setTyped(previewText.slice(0, i))
        i += 1
        timer = setTimeout(step, 130)
      } else {
        // 打完停顿一下再从头循环
        timer = setTimeout(() => { i = 0; step() }, 1600)
      }
    }
    step()
    return () => clearTimeout(timer)
  }, [streaming, previewText])

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
          <span className="mb-1 block text-[10px] font-medium tracking-[0.18em] text-slate-400">{t('appearance.streamingPreviewLabel')}</span>
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
            const color = palette[index]
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
            style={{ color: getWaveTimerColor(theme, customWave) }}
          >
            3.2s
          </span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">{t('appearance.overlayPreview')}</span>
    </div>
  )
}

export default function AppearancePage() {
  const t = useT()
  const [activeTheme, setActiveTheme] = useState(getActiveThemeId)
  const [overlayWaveTheme, setOverlayWaveTheme] = useState<OverlayWaveTheme>('black-rainbow')
  const [customWave, setCustomWave] = useState<CustomWaveColors>(DEFAULT_CUSTOM_WAVE)
  const customWaveSaveRef = useRef<{ timer: ReturnType<typeof setTimeout>; value: CustomWaveColors } | null>(null)
  const [overlayShowDuration, setOverlayShowDuration] = useState(true)
  const [overlayWidth, setOverlayWidth] = useState<OverlayWidthPreset>('medium')
  const [streamingDisplay, setStreamingDisplay] = useState(false)
  // 读到已保存值之前，控件先隐藏、且不带过渡：避免「默认值 → 已保存值」闪一下。
  // 注意过渡也必须一起关掉 —— visibility:hidden 只是看不见，CSS 过渡照样会跑；
  // 隐藏期间选中项仍是默认值，揭开的同一刻颜色会从旧值过渡到新值，看起来就是
  // 「默认项高亮淡出、已保存项淡入」（悬浮窗长度从「中」闪到「短」正是如此）。
  // 隐藏一律用内联 style，不用 Tailwind 的 invisible 类：类要靠扫描源码产出，
  // 一旦跑的是旧的 CSS 产物这层保护就整条失效（曾因此反复排查很久）。
  const [ready, setReady] = useState(false)
  // animate 与 ready 必须分开：
  // 按 CSS 过渡规范，浏览器看的是「变化之后」的样式里有没有 transition。若在揭开、
  // 赋值的同一帧把 transition 加上，浏览器就会认为「有过渡且颜色变了」，于是把
  // 「默认项高亮淡出、已保存项淡入」真的动画一遍 —— 那就是反复没修掉的那个「闪」。
  // 因此：揭开的那一帧仍然不带过渡，等再下一帧才允许过渡（此时颜色已无变化）。
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    // 先把所有值取回，再在同一个同步块里一次性落值 + 置 ready：React 会把这批更新
    // 合成一次渲染，因此不存在「已显示但值还没到」的中间态（那正是闪一下的成因）。
    //
    // 两个坑都在这里躲掉了：
    //  1. 每项自带 catch 兜底 —— Promise.all 是 fail-fast，只要有一项 reject 就会
    //     立刻往下走，那时其它项还没回来，ready 会在值到位前就被置上（并留下一个
    //     未处理的 rejection）。
    //  2. 不用 requestAnimationFrame —— 那会把 setReady 丢到与赋值不同的批次里，
    //     同样可能先提交出一帧「已显示但值是默认值」。
    let cancelled = false
    void (async () => {
      const [showDuration, streaming, waveTheme, waveCustom, width] = await Promise.all([
        getSetting('overlayShowDuration', true).catch(() => true),
        getSetting('streamingDisplayEnabled', false).catch(() => false),
        getSetting('overlayWaveTheme', 'black-rainbow').catch(() => 'black-rainbow'),
        getSetting<unknown>('overlayWaveCustom', DEFAULT_CUSTOM_WAVE).catch(() => DEFAULT_CUSTOM_WAVE),
        getSetting('overlayWidth', 'medium').catch(() => 'medium'),
      ])
      if (cancelled) return
      setOverlayShowDuration(Boolean(showDuration))
      setStreamingDisplay(Boolean(streaming))
      setOverlayWaveTheme(normalizeWaveTheme(waveTheme, 'black-rainbow'))
      setCustomWave(normalizeCustomWave(waveCustom))
      const w = width as OverlayWidthPreset
      if (w === 'short' || w === 'medium' || w === 'long') setOverlayWidth(w)
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setAnimate(true)
      }))
    })()
    return () => { cancelled = true }
  }, [])

  const handleThemeChange = async (themeId: string) => {
    await switchTheme(themeId)
    setActiveTheme(themeId)
  }

  const themeCards: Array<{ theme: OverlayWaveTheme; labelKey: TranslationKey; barColors: string[] }> = [
    ...OVERLAY_OPTIONS,
    // 自定义卡的色条直接取当前配色，改了颜色卡片上也跟着变
    { theme: 'custom', labelKey: 'appearance.wave.custom', barColors: buildWavePalette(4, 'custom', customWave) },
  ]

  const handleOverlayThemeChange = async (theme: OverlayWaveTheme) => {
    setOverlayWaveTheme(theme)
    await setSetting('overlayWaveTheme', theme)
    await refreshOverlaySettings()
  }

  const persistCustomWave = async (value: CustomWaveColors) => {
    await setSetting('overlayWaveCustom', value)
    await refreshOverlaySettings()
  }

  // 预览立刻跟手，写盘合并到停手之后：拖动取色器每秒会触发几十次 onChange，
  // 每次都写库 + 让录音器重读设置没有意义。
  const handleCustomWaveChange = (next: CustomWaveColors) => {
    setCustomWave(next)
    if (customWaveSaveRef.current) clearTimeout(customWaveSaveRef.current.timer)
    const timer = setTimeout(() => {
      customWaveSaveRef.current = null
      void persistCustomWave(next)
    }, CUSTOM_WAVE_SAVE_DELAY_MS)
    customWaveSaveRef.current = { timer, value: next }
  }

  // 停手不到 250ms 就切走页面时，把还没写盘的那次补上，否则最后一下改动会丢。
  useEffect(() => () => {
    const pending = customWaveSaveRef.current
    if (!pending) return
    clearTimeout(pending.timer)
    customWaveSaveRef.current = null
    void persistCustomWave(pending.value)
  }, [])

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
      <h1 className="mb-6 text-2xl font-bold">{t('appearance.title')}</h1>

      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">{t('appearance.appTheme')}</h2>
            {/* 按最小宽度自动分列：固定三列时，窗口拉到最窄（800）英文界面的「Light / Dark / Warm」会撑出卡片外 */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
              {themeList.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  aria-pressed={activeTheme === theme.id}
                  onClick={() => void handleThemeChange(theme.id)}
                  className={`flex items-center gap-3 rounded-lg border p-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${activeTheme === theme.id
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
            <h2 className="mb-4 text-lg font-semibold">{t('appearance.overlayStyle')}</h2>

            {/* 整块一起等值到位再显示。除了选择器，**悬浮窗预览**那颗胶囊的长度也跟着
                overlayWidth 变（它有可见边框），只盖住选择器的话，仍会看到预览从「中」
                的长度一下缩到「短」——那正是之前反复没修掉的那个「闪」。 */}
            <div className="space-y-4" style={ready ? undefined : { visibility: 'hidden' }}>
              <div>
                <p className="mb-2 text-sm text-muted-foreground">{t('appearance.waveTheme')}</p>
                {/* 四张卡：默认窗口宽度下排成一行；窗口拉窄到 lg 以下时两两一行，免得「黑底彩色」和色条挤在一起 */}
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" style={ready ? undefined : { visibility: 'hidden' }}>
                  {themeCards.map((option) => (
                    <button
                      key={option.theme}
                      type="button"
                      aria-pressed={overlayWaveTheme === option.theme}
                      onClick={() => void handleOverlayThemeChange(option.theme)}
                      className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${animate ? 'transition-colors' : ''} ${overlayWaveTheme === option.theme
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent'
                        }`}
                    >
                      {/* 选中只靠边框和底色表示；原来的圆点和边框是同一个意思说了两遍 */}
                      <span className={overlayWaveTheme === option.theme ? 'font-medium' : ''}>{t(option.labelKey)}</span>
                      <span className="flex shrink-0 gap-0.5">
                        {option.barColors.map((c, i) => (
                          <span key={i} className="h-3 w-1 rounded-sm" style={{ backgroundColor: c }} />
                        ))}
                      </span>
                    </button>
                  ))}
                </div>

                {overlayWaveTheme === 'custom' && (
                  <CustomWaveEditor value={customWave} onChange={handleCustomWaveChange} animate={animate} />
                )}

                {/* 只有一两个字的选项用分段按钮（和「识别语言」一致）；带图样的波形主题才用卡片 */}
                <div className="mt-4 flex items-center justify-between gap-4">
                  <p id="overlay-width-label" className="text-sm font-medium">{t('appearance.overlayWidth')}</p>
                  <Segmented
                    labelledBy="overlay-width-label"
                    value={overlayWidth}
                    options={WIDTH_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={(value) => void handleOverlayWidthChange(value)}
                    animated={animate}
                    className="shrink-0 justify-end"
                  />
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{t('appearance.showDuration')}</p>
                    <p className="text-xs text-muted-foreground">{t('appearance.showDurationDesc')}</p>
                  </div>
                  <Switch checked={overlayShowDuration} onChange={handleToggleDuration} noAnimation={!animate} hidden={!ready} />
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <div className="pr-3">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium">{t('appearance.streaming')}</p>
                      <Tooltip
                        variant="light"
                        content={`${t('appearance.streamingHelp')}
${t('appearance.streamingSetupNote')}`}
                      >
                        <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
                      </Tooltip>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('appearance.streamingDesc')}{t('appearance.streamingShortNote')}
                      <button
                        type="button"
                        onClick={() => void shellOpen('https://console.volcengine.com/speech/new/setting/activate?projectName=default')}
                        className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2 decoration-primary/50 transition-colors hover:decoration-primary"
                      >
                        {t('appearance.streamingActivate')}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </p>
                  </div>
                  <Switch checked={streamingDisplay} onChange={handleToggleStreamingDisplay} noAnimation={!animate} hidden={!ready} />
                </div>

                <div className="mt-4 flex justify-center">
                  <OverlayPreview theme={overlayWaveTheme} customWave={customWave} showDuration={overlayShowDuration} barCount={OVERLAY_WIDTH_PRESETS[overlayWidth].barCount} streaming={streamingDisplay} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
