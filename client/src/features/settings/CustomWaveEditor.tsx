// 波形主题「自定义」展开后的编辑区：一行，推荐色块 + 自选，单色 / 渐变切换放在行尾。
//
// 刻意只有一行（用户 2026-11-03 连着否了两版：画成小悬浮窗的推荐配色「更丑」，带标题、
// 起点/终点标签和色值输入框的「还是复杂」）。效果看下面原有的悬浮窗预览，这里不再画预览。

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import { Plus } from 'lucide-react'
import { Segmented } from '@/components/ui/segmented'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import {
  buildWavePalette,
  GRADIENT_WAVE_PRESETS,
  needsBrightening,
  SOLID_WAVE_PRESETS,
  visibleOnBlack,
  type CustomWaveColors,
  type CustomWaveMode,
} from '@/lib/overlayWaveColors'

/** 色块背景：用调色板采样拼 linear-gradient，和悬浮窗实际画出来的一致（深色已调亮）。 */
function swatchBackground(custom: CustomWaveColors): string {
  const stops = buildWavePalette(custom.mode === 'solid' ? 1 : 5, 'custom', custom)
  return stops.length === 1 ? stops[0] : `linear-gradient(to right, ${stops.join(', ')})`
}

/**
 * 悬停提示：用应用自己的 Tooltip，不用原生 title（WebView 画的是系统样式的小框，和界面不搭；用户 2026-11-03）。
 * 写出色值，和点开后取色面板里的色值框是同一种写法。
 */
function tipText(label: string, hex: string): string {
  return `${label} ${hex.toUpperCase()}`
}

// 选中只用一圈细环表示，环和色块之间留一道底色缝。1.5px 半透明前景色：
// 原来 2px 纯前景色的环用户嫌「又粗又黑」（2026-11-03），这个粗细在浅色、深色主题下都还认得出。
const SELECTED_RING = 'ring-[1.5px] ring-foreground/50 ring-offset-2 ring-offset-background'
const ringClass = (active: boolean) => cn(
  'outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  active ? SELECTED_RING : 'hover:ring-[1.5px] hover:ring-foreground/20 hover:ring-offset-2 hover:ring-offset-background',
)

const PANEL_GAP = 8
const VIEWPORT_MARGIN = 8

/**
 * 自己的取色弹窗：颜色区 + 色相条 + HEX 输入框。
 *
 * 为什么不用原生 <input type="color">：Windows 上 WebView2 弹的是 Chromium 自带取色框，默认只显示 RGB，
 * 切到 HEX 要点数字旁一个不起眼的箭头；mac 上又是一块单独漂着的系统颜色面板。用户 2026-11-03 指出
 * 悬停提示写着 HEX、点进去却只有 RGB，「完全没有办法发现」。两个平台现在是同一个面板。
 *
 * 面板挂在 body 上、fixed 定位：设置卡片有 overflow，放在卡片里会被裁掉。
 * 拖动时连续触发 onChange，写盘由上层合并节流。
 */
function ColorPopover({ color, label, onChange, className, style, children }: {
  color: string
  label: string
  onChange: (hex: string) => void
  className?: string
  style?: CSSProperties
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 默认放在触发点下方居中；下面放不下就翻到上方，左右贴着窗口边收住。
  const place = () => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return
    const tr = trigger.getBoundingClientRect()
    const pw = panel.offsetWidth
    const ph = panel.offsetHeight
    let top = tr.bottom + PANEL_GAP
    if (top + ph > window.innerHeight - VIEWPORT_MARGIN) top = Math.max(VIEWPORT_MARGIN, tr.top - ph - PANEL_GAP)
    const left = Math.min(Math.max(VIEWPORT_MARGIN, tr.left + tr.width / 2 - pw / 2), window.innerWidth - pw - VIEWPORT_MARGIN)
    setPos({ top, left })
  }

  useLayoutEffect(() => {
    if (open) place()
    else setPos(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    // 设置页在 main 里滚动，不是 window：用捕获阶段接住任何一层的滚动，跟着重新定位
    const onMove = () => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={className}
        style={style}
      >
        {children}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          className="sayit-colorful fixed z-[9999] w-56 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg"
          style={{ top: pos ? pos.top : -9999, left: pos ? pos.left : -9999 }}
        >
          <p className="mb-2.5 text-xs font-medium">{label}</p>
          <HexColorPicker color={color} onChange={(hex) => onChange(hex.toLowerCase())} />
          <div className="mt-3 flex items-center gap-2">
            <span aria-hidden className="h-7 w-7 shrink-0 rounded-md border border-border" style={{ background: color }} />
            <HexColorInput
              prefixed
              color={color}
              onChange={(hex) => onChange(hex.toLowerCase())}
              aria-label={`${label} HEX`}
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-input-border bg-input-bg px-2 font-mono text-xs uppercase text-foreground transition-colors focus:border-input-focus-border focus:outline-none"
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/** 推荐色块：一个按钮，点一下就用这组颜色。 */
function PresetSwatch({ name, active, wide, background, onPick }: {
  name: string
  active: boolean
  /** 渐变胶囊比单色圆点宽 */
  wide?: boolean
  background: string
  onPick: () => void
}) {
  return (
    <Tooltip content={name}>
      <button
        type="button"
        aria-label={name}
        aria-pressed={active}
        onClick={onPick}
        className={cn('h-5 rounded-full', wide ? 'w-10' : 'w-5', ringClass(active))}
        style={{ background }}
      />
    </Tooltip>
  )
}

/** 单色自选：一颗色块，点开取色弹窗。 */
function PickDot({ color, label, active, empty, onChange }: {
  color: string
  label: string
  active: boolean
  /** 还没自选过（当前值是推荐色）时画成虚线圈 + 加号，免得和推荐色块混在一起 */
  empty?: boolean
  onChange: (hex: string) => void
}) {
  return (
    <Tooltip content={empty ? label : tipText(label, color)}>
      <ColorPopover
        color={color}
        label={label}
        onChange={onChange}
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full', ringClass(active),
          'aria-expanded:ring-[1.5px] aria-expanded:ring-foreground/50 aria-expanded:ring-offset-2 aria-expanded:ring-offset-background',
          empty && 'border border-dashed border-muted-foreground/50 text-muted-foreground',
        )}
        style={empty ? undefined : { background: color }}
      >
        {empty && <Plus className="h-3 w-3" aria-hidden />}
      </ColorPopover>
    </Tooltip>
  )
}

/**
 * 自选渐变：两颗色点（左 = 起点，右 = 终点）用一根 2px 的渐变细线连起来。
 * 演变（用户 2026-11-03）：「圆点—横杠—圆点」嫌横杠多余 → 一整颗胶囊看不出起点终点 → 现在这样，
 * 细线就是这两色的渐变；6px 嫌粗，改 2px；外面原来有一圈选中框，点到框中间什么都不发生，用户以为不能改。
 * 所以：没有外框，整条分成左右两半，各是一个按钮，点到线上也能打开；鼠标在哪一半，那头的点就放大一点。
 * 选中（当前是自选）时，两颗点各带一圈和推荐色块同样的细环；正在改的那一头放大一点并带同样的细环。
 * 当前是推荐配色时也照常画出那两色，点一下就是从这个推荐色开始改。
 */
function GradientPick({ value, active, labels, onChange }: {
  value: CustomWaveColors
  active: boolean
  labels: { from: string; to: string }
  onChange: (next: CustomWaveColors) => void
}) {
  const half = (side: 'from' | 'to') => (
    <Tooltip className="h-full flex-1" content={tipText(labels[side], value[side])}>
      <ColorPopover
        color={value[side]}
        label={labels[side]}
        onChange={(hex) => onChange({ ...value, [side]: hex })}
        className={cn('group/stop flex h-full w-full items-center rounded-full outline-none', side === 'from' ? 'justify-start' : 'justify-end')}
      >
        <span
          aria-hidden
          className={cn(
            'h-4 w-4 rounded-full shadow-sm transition-transform duration-150 ease-out group-hover/stop:scale-[1.15]',
            active && SELECTED_RING,
            'group-focus-visible/stop:ring-2 group-focus-visible/stop:ring-ring group-focus-visible/stop:ring-offset-2 group-focus-visible/stop:ring-offset-background',
            'group-aria-expanded/stop:scale-[1.15] group-aria-expanded/stop:ring-[1.5px] group-aria-expanded/stop:ring-foreground/50 group-aria-expanded/stop:ring-offset-2 group-aria-expanded/stop:ring-offset-background',
          )}
          style={{ background: visibleOnBlack(value[side]) }}
        />
      </ColorPopover>
    </Tooltip>
  )
  return (
    <span className="relative inline-flex h-6 w-[4.5rem] shrink-0 items-center">
      {/* 2px：再粗就成了一根抢眼的色条（用户 2026-11-03 嫌 6px 太粗），细线只负责把两头连起来 */}
      <span aria-hidden className="pointer-events-none absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full" style={{ background: swatchBackground(value) }} />
      {half('from')}
      {half('to')}
    </span>
  )
}

export function CustomWaveEditor({ value, onChange, animate }: {
  value: CustomWaveColors
  onChange: (next: CustomWaveColors) => void
  animate: boolean
}) {
  const t = useT()
  const presetsId = useId()
  const gradient = value.mode === 'gradient'
  const brightened = needsBrightening(value.from) || (gradient && needsBrightening(value.to))

  const solidIsPreset = SOLID_WAVE_PRESETS.includes(value.from)
  const gradientIsPreset = GRADIENT_WAVE_PRESETS.some(([from, to]) => from === value.from && to === value.to)

  return (
    <div className="mt-3 space-y-2">
      {/* 色块从左边起排，和上面的主题卡对齐；单色 / 渐变是次要切换，缩成 xs 放在行尾（用户 2026-11-03：放在最前面偏大、位置别扭） */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span id={presetsId} className="sr-only">{t('appearance.wave.presets')}</span>
        <div role="group" aria-labelledby={presetsId} className="flex flex-wrap items-center gap-2.5">
          {gradient
            ? GRADIENT_WAVE_PRESETS.map(([from, to]) => {
              const preset: CustomWaveColors = { mode: 'gradient', from, to }
              return (
                <PresetSwatch
                  key={`${from}-${to}`}
                  name={`${from.toUpperCase()} → ${to.toUpperCase()}`}
                  active={from === value.from && to === value.to}
                  wide
                  background={swatchBackground(preset)}
                  onPick={() => onChange(preset)}
                />
              )
            })
            : SOLID_WAVE_PRESETS.map((from) => (
              <PresetSwatch
                key={from}
                name={from.toUpperCase()}
                active={from === value.from}
                background={swatchBackground({ ...value, mode: 'solid', from })}
                onPick={() => onChange({ ...value, from })}
              />
            ))}

          {/* 自选：和推荐色块之间一道细竖线隔开 */}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          {gradient ? (
            <GradientPick
              value={value}
              active={!gradientIsPreset}
              labels={{ from: t('appearance.wave.from'), to: t('appearance.wave.to') }}
              onChange={onChange}
            />
          ) : (
            <PickDot color={value.from} label={t('appearance.wave.color')} active={!solidIsPreset} empty={solidIsPreset} onChange={(from) => onChange({ ...value, from })} />
          )}
        </div>

        <Segmented<CustomWaveMode>
          label={t('appearance.wave.customStyle')}
          size="xs"
          value={value.mode}
          options={[
            { value: 'solid', label: t('appearance.wave.solid') },
            { value: 'gradient', label: t('appearance.wave.gradient') },
          ]}
          onChange={(mode) => onChange({ ...value, mode })}
          animated={animate}
          className="ml-auto shrink-0 gap-0.5"
        />
      </div>

      {/* 面板里是用户选的原色，这里把调亮后的实际颜色画出来，免得以为没生效 */}
      {brightened && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('appearance.wave.brightened')}</span>
          <span
            aria-hidden
            className={cn('inline-block h-3 rounded-full', gradient ? 'w-10' : 'w-3')}
            style={{ background: swatchBackground(value) }}
          />
        </p>
      )}
    </div>
  )
}
