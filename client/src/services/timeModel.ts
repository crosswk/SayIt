export interface DurationModelInput {
  holdSec: number
  audioSec?: number
  asrSec?: number
}

function safeSec(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(0, value)
}

export function clampSec(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value)
}

export function elapsedSecFromPerf(startPerf: number, nowPerf = performance.now()): number {
  if (!Number.isFinite(startPerf) || startPerf <= 0) return 0
  return clampSec((nowPerf - startPerf) / 1000)
}

export function normalizeDurations(input: DurationModelInput): DurationModelInput {
  return {
    holdSec: clampSec(input.holdSec),
    audioSec: safeSec(input.audioSec),
    asrSec: safeSec(input.asrSec),
  }
}

export function pickVoiceDurationSec(input: DurationModelInput): number {
  const normalized = normalizeDurations(input)
  // Prefer wall time (holdSec) — matches what the user saw on the overlay.
  // Fall back to audioSec/asrSec only if holdSec is missing.
  if (normalized.holdSec > 0) return normalized.holdSec
  return normalized.asrSec ?? normalized.audioSec ?? 0
}
