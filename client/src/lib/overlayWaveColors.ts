/**
 * 悬浮窗波形配色：内置三套 + 用户自定义（单色 / 两色渐变）。
 *
 * 悬浮窗（overlay/Overlay.tsx）和设置页预览（AppearancePage）都从这里取色。以前两边
 * 各抄了一份一模一样的配色函数，改一边忘另一边，预览就和真实悬浮窗对不上。
 *
 * 自定义颜色有两条约束，都是因为胶囊底色固定是黑的：
 * 1. **亮度有下限**（OKLab L ≥ MIN_VISIBLE_L）。用户挑了深蓝/纯黑的话波形在黑底上
 *    完全看不见，像悬浮窗坏了。宁可替他调亮，预览里直接画调亮后的效果，所见即所得。
 * 2. **渐变在 OKLCH 里插值**。sRGB / HSL 里插两种互补色，中段会发灰发脏；OKLCH 沿色相走，
 *    明度感知均匀，两色渐变能得到接近内置彩虹那种干净的过渡。
 */

export type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow' | 'custom'

export type CustomWaveMode = 'solid' | 'gradient'

export interface CustomWaveColors {
  mode: CustomWaveMode
  /** 单色模式的颜色 / 渐变起点（波形最左边），#rrggbb */
  from: string
  /** 渐变终点（波形最右边），#rrggbb。单色模式下保留不用，切回渐变时还在 */
  to: string
}

export const DEFAULT_CUSTOM_WAVE: CustomWaveColors = {
  mode: 'gradient',
  from: '#a78bfa',
  to: '#f472b6',
}

/** 推荐配色。单色给一排色块，渐变给成对的起止色，点一下就能用。 */
export const SOLID_WAVE_PRESETS: readonly string[] = [
  '#f472b6', '#a78bfa', '#60a5fa', '#2dd4bf', '#34d399', '#a3e635', '#fbbf24', '#f87171',
]

export const GRADIENT_WAVE_PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['#a78bfa', '#f472b6'],
  ['#60a5fa', '#c084fc'],
  ['#22d3ee', '#a3e635'],
  ['#2dd4bf', '#818cf8'],
  ['#fbbf24', '#f472b6'],
  ['#fb923c', '#f43f5e'],
]

/**
 * 黑底上可辨认的最低 OKLab 明度。0.62 对应相对亮度约 0.24（中性灰），与纯黑的对比度约 5.7:1。
 * 内置三套的条都比这亮得多，下限只拦真正会"消失"的深色，不会把用户挑的中等亮度色改掉。
 */
export const MIN_VISIBLE_L = 0.62

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** 把用户输入的色值规整成小写 #rrggbb；不是合法色值返回 null。接受 3 位简写和省略 #。 */
export function parseHexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const m = HEX_RE.exec(input.trim())
  if (!m) return null
  let hex = m[1].toLowerCase()
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  return `#${hex}`
}

export function normalizeWaveTheme(value: unknown, fallback: OverlayWaveTheme): OverlayWaveTheme {
  if (value === 'black-white' || value === 'black-blue' || value === 'black-rainbow' || value === 'custom') {
    return value
  }
  return fallback
}

/** 设置/备份/payload 里读回来的值都不可信，逐字段校验，坏的字段回落默认值。 */
export function normalizeCustomWave(value: unknown): CustomWaveColors {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  return {
    mode: raw.mode === 'solid' || raw.mode === 'gradient' ? raw.mode : DEFAULT_CUSTOM_WAVE.mode,
    from: parseHexColor(raw.from) ?? DEFAULT_CUSTOM_WAVE.from,
    to: parseHexColor(raw.to) ?? DEFAULT_CUSTOM_WAVE.to,
  }
}

export function sameCustomWave(a: CustomWaveColors, b: CustomWaveColors): boolean {
  return a.mode === b.mode && a.from === b.from && a.to === b.to
}

// ── OKLab / OKLCH（Björn Ottosson 的公式） ──────────────────────────────

interface Lch { l: number; c: number; h: number }

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function hexToLch(hex: string): Lch {
  const n = parseInt(hex.slice(1), 16)
  const r = srgbToLinear(((n >> 16) & 255) / 255)
  const g = srgbToLinear(((n >> 8) & 255) / 255)
  const b = srgbToLinear((n & 255) / 255)
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}

/** OKLCH → 线性前的 sRGB 三通道（可能越界，越界说明这个颜色在 sRGB 里画不出来）。 */
function lchToRgb({ l, c, h }: Lch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const A = c * Math.cos(rad)
  const B = c * Math.sin(rad)
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B
  const s_ = l - 0.0894841775 * A - 1.2914855480 * B
  const L3 = l_ * l_ * l_
  const M3 = m_ * m_ * m_
  const S3 = s_ * s_ * s_
  return [
    linearToSrgb(4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3),
    linearToSrgb(-1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3),
    linearToSrgb(-0.0041960863 * L3 - 0.7034186147 * M3 + 1.7076147010 * S3),
  ]
}

function inGamut(rgb: [number, number, number]): boolean {
  return rgb.every((v) => v >= -0.0005 && v <= 1.0005)
}

/**
 * 转回 hex。明度调高之后原来的彩度常常超出 sRGB（例如亮度拉高的纯蓝），
 * 直接截断通道会偏色，所以保持明度和色相、二分收缩彩度直到落进色域。
 */
function lchToHex(lch: Lch): string {
  let rgb = lchToRgb(lch)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = lch.c
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(lchToRgb({ ...lch, c: mid }))) lo = mid
      else hi = mid
    }
    rgb = lchToRgb({ ...lch, c: lo })
  }
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`
}

function withVisibleLightness(lch: Lch): Lch {
  return lch.l >= MIN_VISIBLE_L ? lch : { ...lch, l: MIN_VISIBLE_L }
}

/** 这个颜色放到黑底胶囊上会不会被调亮（设置页据此提示用户）。 */
export function needsBrightening(hex: string): boolean {
  const parsed = parseHexColor(hex)
  return parsed ? hexToLch(parsed).l < MIN_VISIBLE_L : false
}

/** 黑底上实际会画出来的颜色：够亮的原样返回，太暗的提到亮度下限。 */
export function visibleOnBlack(hex: string): string {
  const parsed = parseHexColor(hex) ?? DEFAULT_CUSTOM_WAVE.from
  if (!needsBrightening(parsed)) return parsed
  return lchToHex(withVisibleLightness(hexToLch(parsed)))
}

/** 接近灰色的颜色色相没有意义（atan2 的结果是噪声），插值时借另一端的色相，避免中段乱跳。 */
const ACHROMATIC_C = 0.02

function mixLch(a: Lch, b: Lch, t: number): Lch {
  let ha = a.h
  let hb = b.h
  if (a.c < ACHROMATIC_C) ha = hb
  if (b.c < ACHROMATIC_C) hb = ha
  // 走较短的那段色环：紫→粉应该经过品红，不该绕一大圈穿过绿色
  let dh = hb - ha
  if (dh > 180) dh -= 360
  if (dh < -180) dh += 360
  const h = ha + dh * t
  return {
    l: a.l + (b.l - a.l) * t,
    c: a.c + (b.c - a.c) * t,
    h: h < 0 ? h + 360 : h % 360,
  }
}

/** 自定义配色在位置 t（0=最左，1=最右）的颜色，已保证黑底可见。 */
function customColorAt(custom: CustomWaveColors, t: number): string {
  const from = hexToLch(parseHexColor(custom.from) ?? DEFAULT_CUSTOM_WAVE.from)
  if (custom.mode === 'solid') return lchToHex(withVisibleLightness(from))
  const to = hexToLch(parseHexColor(custom.to) ?? DEFAULT_CUSTOM_WAVE.to)
  return lchToHex(withVisibleLightness(mixLch(from, to, t)))
}

// ── 对外的取色函数 ────────────────────────────────────────────────

/**
 * 整条波形的颜色，按条从左到右。
 *
 * 一次算完整组而不是每根条单独算：悬浮窗录音时 30 帧/秒重渲染，每帧二十几根条，
 * 自定义色要走 OKLCH 换算和色域收缩；调用方配合 useMemo 只在配色或条数变化时重算。
 */
export function buildWavePalette(total: number, theme: OverlayWaveTheme, custom: CustomWaveColors): string[] {
  const count = Math.max(0, Math.floor(total))
  const denom = Math.max(1, count - 1)
  return Array.from({ length: count }, (_, index) => {
    const t = index / denom
    if (theme === 'black-white') return '#f1f5f9'
    if (theme === 'black-rainbow') {
      const hue = 140 - Math.round(t * 110)
      const lightness = 64 - Math.round(Math.abs(t - 0.5) * 12)
      return `hsl(${hue} 95% ${lightness}%)`
    }
    if (theme === 'custom') return customColorAt(custom, t)
    const hue = 190 + Math.round(t * 30)
    const lightness = 62 - Math.round(Math.abs(t - 0.5) * 14)
    return `hsl(${hue} 90% ${lightness}%)`
  })
}

/**
 * 计时数字的颜色。自定义配色不让用户单独挑：从主色派生一个更浅、更淡的版本，
 * 和内置主题的做法一致（蓝色主题的计时是浅天蓝 #bae6fd），选项少一点也不容易配丑。
 */
export function getWaveTimerColor(theme: OverlayWaveTheme, custom: CustomWaveColors): string {
  if (theme === 'black-white') return '#e5e7eb'
  if (theme === 'black-rainbow') return '#fef08a'
  if (theme === 'custom') {
    const base = hexToLch(customColorAt(custom, 0.5))
    return lchToHex({ l: Math.max(base.l, 0.9), c: base.c * 0.45, h: base.h })
  }
  return '#bae6fd'
}

/** 「识别中」动画的颜色：取主色中段，明度略高于波形，保证在黑底上醒目。 */
export function getWaveThinkingColor(theme: OverlayWaveTheme, custom: CustomWaveColors): string {
  if (theme === 'black-white') return '#e2e8f0'
  if (theme === 'black-rainbow') return '#facc15'
  if (theme === 'custom') {
    const base = hexToLch(customColorAt(custom, 0.5))
    return lchToHex({ ...base, l: Math.max(base.l, 0.72) })
  }
  return '#38bdf8'
}
