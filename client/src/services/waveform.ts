// Shared waveform drawing utility
// Uses time-domain data for even distribution across all bars
// Implements adaptive gain control (AGC) for consistent visual response

export interface WaveformOptions {
  bg?: string
  colorBase?: string
}

export interface WaveformBarState {
  prevHeights: number[]
  peakLevel: number
}

export interface WaveformBarOptions {
  barCount?: number
  minHeight?: number
  maxHeight?: number
  attack?: number
  decay?: number
  centerShape?: number
  gainTarget?: number
  softClip?: number
}

const DEFAULTS: Required<WaveformOptions> = {
  bg: 'transparent',
  colorBase: '34, 197, 94',
}

const BAR_DEFAULTS: Required<WaveformBarOptions> = {
  barCount: 24,
  minHeight: 2,
  maxHeight: 18,
  attack: 0.45,
  decay: 0.12,
  centerShape: 0.15,
  gainTarget: 0.7,
  softClip: 1.5,
}

// State for smooth transitions and AGC
let prevHeights: number[] = []
let peakLevel = 0.05  // Adaptive peak tracking (starts low for sensitivity)

/**
 * Reset waveform state (call when starting a new recording session)
 */
export function resetWaveform() {
  prevHeights = []
  peakLevel = 0.05
}

export function createWaveformBarState(): WaveformBarState {
  return {
    prevHeights: [],
    peakLevel: 0.05,
  }
}

export function resetWaveformBarState(
  state: WaveformBarState,
  barCount = BAR_DEFAULTS.barCount,
  minHeight = BAR_DEFAULTS.minHeight,
) {
  state.prevHeights = Array(barCount).fill(minHeight)
  state.peakLevel = 0.05
}

export function computeBarsFromPCM(
  pcm: Int16Array,
  state: WaveformBarState,
  opts?: WaveformBarOptions,
): number[] {
  const {
    barCount,
    minHeight,
    maxHeight,
    attack,
    decay,
    centerShape,
    gainTarget,
    softClip,
  } = { ...BAR_DEFAULTS, ...opts }

  if (state.prevHeights.length !== barCount) {
    state.prevHeights = Array(barCount).fill(minHeight)
  }
  if (pcm.length === 0) {
    return [...state.prevHeights]
  }

  let frameSum = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768
    frameSum += v * v
  }
  const frameRms = Math.sqrt(frameSum / pcm.length)

  if (frameRms > state.peakLevel) {
    state.peakLevel += (frameRms - state.peakLevel) * 0.3
  } else {
    state.peakLevel += (frameRms - state.peakLevel) * 0.005
  }
  state.peakLevel = Math.max(0.02, Math.min(0.5, state.peakLevel))

  const gain = gainTarget / state.peakLevel
  const samplesPerBar = Math.max(1, Math.floor(pcm.length / barCount))
  const center = (barCount - 1) / 2

  for (let i = 0; i < barCount; i++) {
    const start = i * samplesPerBar
    const end = i === barCount - 1 ? pcm.length : Math.min(pcm.length, start + samplesPerBar)

    let sum = 0
    const count = Math.max(1, end - start)
    for (let j = start; j < end; j++) {
      const v = pcm[j] / 32768
      sum += v * v
    }
    const rms = Math.sqrt(sum / count)

    const amplified = rms * gain
    const normalized = Math.tanh(amplified * softClip)

    const centerDist = Math.abs(i - center) / Math.max(1, center)
    const shape = Math.max(0.7, 1 - centerDist * centerShape)
    const target = Math.max(minHeight, normalized * maxHeight * shape)

    const prev = state.prevHeights[i]
    state.prevHeights[i] = target > prev
      ? prev + (target - prev) * attack
      : prev + (target - prev) * decay
  }

  return [...state.prevHeights]
}

/**
 * Draw centered vertical bars from time-domain audio data.
 * Uses AGC: quiet speech gets amplified, loud speech gets compressed.
 */
export function drawBars(
  ctx: CanvasRenderingContext2D,
  analyser: AnalyserNode,
  w: number,
  h: number,
  opts?: WaveformOptions,
) {
  const { bg, colorBase } = { ...DEFAULTS, ...opts }

  ctx.clearRect(0, 0, w, h)
  if (bg !== 'transparent') {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)
  }

  const bufLen = analyser.fftSize
  const timeData = new Uint8Array(bufLen)
  analyser.getByteTimeDomainData(timeData)

  const barCount = 24
  const barWidth = 3
  const gap = 2
  const totalWidth = barCount * (barWidth + gap) - gap
  const startX = (w - totalWidth) / 2
  const samplesPerBar = Math.floor(bufLen / barCount)

  if (prevHeights.length !== barCount) {
    prevHeights = Array(barCount).fill(2)
  }

  // Calculate overall RMS for this frame (for AGC)
  let frameSum = 0
  for (let i = 0; i < bufLen; i++) {
    const v = (timeData[i] - 128) / 128
    frameSum += v * v
  }
  const frameRms = Math.sqrt(frameSum / bufLen)

  // AGC: adapt peak level slowly
  // Rise fast when loud (track peaks), decay slowly (keep sensitivity)
  if (frameRms > peakLevel) {
    peakLevel += (frameRms - peakLevel) * 0.3  // fast rise
  } else {
    peakLevel += (frameRms - peakLevel) * 0.005 // very slow decay
  }
  // Clamp peak level to reasonable range
  peakLevel = Math.max(0.02, Math.min(0.5, peakLevel))

  // Gain: normalize against current peak level
  // This makes quiet speech visible and loud speech not clip
  const gain = 0.7 / peakLevel

  for (let i = 0; i < barCount; i++) {
    let sum = 0
    const offset = i * samplesPerBar
    for (let j = 0; j < samplesPerBar; j++) {
      const v = (timeData[offset + j] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / samplesPerBar)

    // Apply AGC gain, then soft-clip with tanh to prevent overflow
    const amplified = rms * gain
    const normalized = Math.tanh(amplified * 1.5) // soft clip: 0->0, big->~1

    const centerDist = Math.abs(i - barCount / 2) / (barCount / 2)
    const shape = 1 - centerDist * 0.15
    const targetH = Math.max(2, normalized * h * 0.85 * shape)

    // Smooth: fast attack, slow decay
    const prev = prevHeights[i]
    const barH = targetH > prev
      ? prev + (targetH - prev) * 0.45
      : prev + (targetH - prev) * 0.12
    prevHeights[i] = barH

    const x = startX + i * (barWidth + gap)
    const y = (h - barH) / 2

    ctx.fillStyle = `rgba(${colorBase}, ${0.4 + (barH / h) * 0.6})`
    ctx.beginPath()
    ctx.roundRect(x, y, barWidth, barH, 1.5)
    ctx.fill()
  }
}
