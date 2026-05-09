export type UpdateSource = 'startup' | 'manual'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'disabled'

export interface UpdateStatus {
  enabled: boolean
  phase: UpdatePhase
  currentVersion: string
  nextVersion?: string
  source?: UpdateSource
  progressPercent?: number
  bytesPerSecond?: number
  transferredBytes?: number
  totalBytes?: number
  checkedAt?: number
  message?: string
}
