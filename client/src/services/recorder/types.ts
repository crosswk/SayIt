export type RecorderState = 'idle' | 'recording' | 'processing'

export type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow'

export type OverlayWidthPreset = 'short' | 'medium' | 'long'

export interface OverlayWidthConfig {
  barCount: number
  windowWidth: number
}

export const OVERLAY_WIDTH_PRESETS: Record<OverlayWidthPreset, OverlayWidthConfig> = {
  short:  { barCount: 12, windowWidth: 200 },
  medium: { barCount: 18, windowWidth: 280 },
  long:   { barCount: 24, windowWidth: 360 },
}

export interface OverlayCommonPayload {
  theme: OverlayWaveTheme
  showDuration: boolean
  baseWidth?: number
  barCount?: number
}

export interface PTTEventPayload {
  source?: string
  keycode?: number
  rawcode?: number
  altKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  reason?: string
  pttSetting?: string
  timestamp?: number
}
