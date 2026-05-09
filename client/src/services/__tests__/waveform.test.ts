import { describe, it, expect } from 'vitest'
import { computeBarsFromPCM, createWaveformBarState, resetWaveformBarState } from '../waveform'

describe('computeBarsFromPCM', () => {
  it('空 PCM 返回上一帧的高度', () => {
    const state = createWaveformBarState()
    const bars = computeBarsFromPCM(new Int16Array(0), state)
    expect(bars).toHaveLength(24) // 默认 barCount
    expect(bars.every((h) => h === 2)).toBe(true) // 默认 minHeight
  })

  it('静音 PCM 返回最小高度附近的值', () => {
    const state = createWaveformBarState()
    const silent = new Int16Array(1600) // 100ms of silence
    const bars = computeBarsFromPCM(silent, state)
    expect(bars).toHaveLength(24)
    bars.forEach((h) => {
      expect(h).toBeGreaterThanOrEqual(1)
      expect(h).toBeLessThanOrEqual(5)
    })
  })

  it('有声音的 PCM 产生更高的 bar', () => {
    const state = createWaveformBarState()
    // 生成一个有声音的 PCM（正弦波）
    const samples = 1600
    const pcm = new Int16Array(samples)
    for (let i = 0; i < samples; i++) {
      pcm[i] = Math.round(Math.sin(i * 0.1) * 16000)
    }
    const bars = computeBarsFromPCM(pcm, state)
    expect(bars).toHaveLength(24)
    const maxBar = Math.max(...bars)
    expect(maxBar).toBeGreaterThan(5)
  })

  it('自定义 barCount 生效', () => {
    const state = createWaveformBarState()
    const pcm = new Int16Array(1600)
    const bars = computeBarsFromPCM(pcm, state, { barCount: 12 })
    expect(bars).toHaveLength(12)
  })

  it('resetWaveformBarState 重置状态', () => {
    const state = createWaveformBarState()
    // 先喂一些数据改变状态
    const pcm = new Int16Array(1600)
    for (let i = 0; i < 1600; i++) pcm[i] = Math.round(Math.sin(i * 0.1) * 16000)
    computeBarsFromPCM(pcm, state)
    expect(state.peakLevel).toBeGreaterThan(0.05)

    // 重置
    resetWaveformBarState(state)
    expect(state.peakLevel).toBe(0.05)
    expect(state.prevHeights).toHaveLength(24)
    expect(state.prevHeights.every((h) => h === 2)).toBe(true)
  })
})
