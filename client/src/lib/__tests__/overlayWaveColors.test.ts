import { describe, expect, it } from 'vitest'
import {
  buildWavePalette,
  DEFAULT_CUSTOM_WAVE,
  getWaveThinkingColor,
  getWaveTimerColor,
  needsBrightening,
  normalizeCustomWave,
  normalizeWaveTheme,
  parseHexColor,
  visibleOnBlack,
  type CustomWaveColors,
} from '../overlayWaveColors'

/** sRGB hex → OKLab 明度。测试里独立实现一遍，不复用被测模块的换算。 */
function oklabL(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const r = lin(((n >> 16) & 255) / 255)
  const g = lin(((n >> 8) & 255) / 255)
  const b = lin((n & 255) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
}

const HEX = /^#[0-9a-f]{6}$/

describe('parseHexColor', () => {
  it('规整成小写 6 位，接受简写和省略 #', () => {
    expect(parseHexColor('#A78BFA')).toBe('#a78bfa')
    expect(parseHexColor('a78bfa')).toBe('#a78bfa')
    expect(parseHexColor('#fa0')).toBe('#ffaa00')
    expect(parseHexColor('  #123456 ')).toBe('#123456')
  })

  it('不合法的输入返回 null，不替用户猜', () => {
    for (const bad of ['', '#12', '#12345', '#1234567', 'red', '#gggggg', null, 42, {}]) {
      expect(parseHexColor(bad)).toBeNull()
    }
  })
})

describe('normalizeCustomWave / normalizeWaveTheme', () => {
  it('坏字段逐个回落默认值，好字段保留', () => {
    expect(normalizeCustomWave({ mode: 'solid', from: '#FF0000', to: 'nope' })).toEqual({
      mode: 'solid',
      from: '#ff0000',
      to: DEFAULT_CUSTOM_WAVE.to,
    })
    expect(normalizeCustomWave('garbage')).toEqual(DEFAULT_CUSTOM_WAVE)
    expect(normalizeCustomWave(null)).toEqual(DEFAULT_CUSTOM_WAVE)
  })

  it('认识 custom，未知主题回落调用方给的默认', () => {
    expect(normalizeWaveTheme('custom', 'black-blue')).toBe('custom')
    expect(normalizeWaveTheme('black-rainbow', 'black-blue')).toBe('black-rainbow')
    expect(normalizeWaveTheme('neon', 'black-blue')).toBe('black-blue')
  })
})

describe('黑底可见性', () => {
  it('太暗的颜色被提到亮度下限，色相大致保留', () => {
    for (const dark of ['#000000', '#000080', '#1e1b4b', '#3b0764', '#14532d']) {
      expect(needsBrightening(dark)).toBe(true)
      const fixed = visibleOnBlack(dark)
      expect(fixed).toMatch(HEX)
      expect(oklabL(fixed)).toBeGreaterThanOrEqual(0.615)
    }
    // 深蓝调亮后仍然是蓝色系：蓝通道最大
    const navy = visibleOnBlack('#000080')
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(navy.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })

  it('够亮的颜色原样返回，不被悄悄改掉', () => {
    for (const bright of ['#f472b6', '#a78bfa', '#fbbf24', '#ffffff', '#22d3ee']) {
      expect(needsBrightening(bright)).toBe(false)
      expect(visibleOnBlack(bright)).toBe(bright)
    }
  })
})

describe('buildWavePalette', () => {
  /**
   * 内置三套的配色从 Overlay.tsx 和 AppearancePage.tsx 各一份收进了这里，
   * 钉住输出，确保收口没有改变任何现有用户看到的颜色。
   */
  it('内置主题与收口前逐根一致', () => {
    const legacy = (index: number, total: number, theme: string) => {
      const t = index / Math.max(1, total - 1)
      if (theme === 'black-white') return '#f1f5f9'
      if (theme === 'black-rainbow') {
        return `hsl(${140 - Math.round(t * 110)} 95% ${64 - Math.round(Math.abs(t - 0.5) * 12)}%)`
      }
      return `hsl(${190 + Math.round(t * 30)} 90% ${62 - Math.round(Math.abs(t - 0.5) * 14)}%)`
    }
    for (const theme of ['black-white', 'black-blue', 'black-rainbow'] as const) {
      for (const total of [1, 12, 18, 24]) {
        const expected = Array.from({ length: total }, (_, i) => legacy(i, total, theme))
        expect(buildWavePalette(total, theme, DEFAULT_CUSTOM_WAVE)).toEqual(expected)
      }
    }
    expect(getWaveTimerColor('black-blue', DEFAULT_CUSTOM_WAVE)).toBe('#bae6fd')
    expect(getWaveThinkingColor('black-rainbow', DEFAULT_CUSTOM_WAVE)).toBe('#facc15')
  })

  it('单色：每根条同一个颜色', () => {
    const solid: CustomWaveColors = { mode: 'solid', from: '#f472b6', to: '#000000' }
    const palette = buildWavePalette(12, 'custom', solid)
    expect(new Set(palette)).toEqual(new Set(['#f472b6']))
  })

  it('渐变：两端就是用户选的颜色，中间每根都在黑底上可见', () => {
    const grad: CustomWaveColors = { mode: 'gradient', from: '#22d3ee', to: '#f472b6' }
    const palette = buildWavePalette(24, 'custom', grad)
    expect(palette).toHaveLength(24)
    expect(palette[0]).toBe('#22d3ee')
    expect(palette[23]).toBe('#f472b6')
    for (const c of palette) {
      expect(c).toMatch(HEX)
      expect(oklabL(c)).toBeGreaterThanOrEqual(0.615)
    }
    expect(new Set(palette).size).toBeGreaterThan(10)
  })

  it('渐变的一端是灰色时，色相借另一端，中段不会突然跳成别的颜色', () => {
    const grad: CustomWaveColors = { mode: 'gradient', from: '#ffffff', to: '#60a5fa' }
    const palette = buildWavePalette(9, 'custom', grad)
    for (const c of palette.slice(1)) {
      const [r, , b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
      expect(b).toBeGreaterThanOrEqual(r)
    }
  })

  it('计时与识别中颜色从自定义主色派生，且是合法色值', () => {
    const grad: CustomWaveColors = { mode: 'gradient', from: '#000080', to: '#3b0764' }
    const timer = getWaveTimerColor('custom', grad)
    const thinking = getWaveThinkingColor('custom', grad)
    expect(timer).toMatch(HEX)
    expect(thinking).toMatch(HEX)
    expect(oklabL(timer)).toBeGreaterThan(0.85)
    expect(oklabL(thinking)).toBeGreaterThanOrEqual(0.715)
  })
})
