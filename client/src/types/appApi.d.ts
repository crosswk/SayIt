import type { ActiveAppContext } from './appContext'
import type { UpdateStatus } from './update'

export type DiagnosticOccurrence =
  | 'just_now'
  | 'within_1h'
  | 'today'
  | 'yesterday'
  | 'older'
  | 'not_sure'

export interface DiagnosticsPreview {
  generatedAt: string
  retentionDays: number
  filesScanned: number
  totalRawEvents: number
  totalTimelineEntries: number
  issueWindowLabel: string
  rangeStart?: string
  rangeEnd?: string
  systemInfo: {
    platform: string
    appVersion: string
    webviewVersion: string
  }
  summary: {
    errors: number
    warnings: number
    modules: Array<{ module: string; count: number }>
    lastError?: {
      ts: string
      level: 'info' | 'warn' | 'error'
      module: string
      title: string
      detail?: string
      traceId?: string
    }
  }
  timeline: Array<{
    ts: string
    level: 'info' | 'warn' | 'error'
    module: string
    title: string
    detail?: string
    traceId?: string
  }>
}

export interface ClientRuntimeInfo {
  userId: string
  userName: string
  deviceId: string
  hostname: string
  clientVersion: string
  platform: string
  osVersion: string
  localIp: string
  systemLocale: string
  cpuCores: number
  memoryMb: number
}

export interface AppAPI {
  minimize: () => void
  maximize: () => void
  close: () => void
  showOverlay: () => void
  hideOverlay: () => void
  updateOverlay: (data: unknown) => void
  pasteText: (text: string, hwnd?: string, focusHwnd?: string) => Promise<{
    ok: boolean
    strategy?: 'renderer_dom' | 'value_pattern' | 'wm_paste' | 'send_unicode' | 'send_input'
    reason?: string
    detail?: string
    attempts?: Array<{
      strategy: 'renderer_dom' | 'value_pattern' | 'wm_paste' | 'send_unicode' | 'send_input'
      ok: boolean
      reason?: string
      detail?: string
    }>
  }>
  getActiveAppContext: () => Promise<ActiveAppContext | null>
  getClientRuntimeInfo: () => Promise<ClientRuntimeInfo>
  getProbeResult: () => Promise<{
    editable: boolean
    hwnd: string
    process: string
    detail: string
    pid?: number
    tid?: number
    focusHwnd?: string
    caret?: number
    control?: number
    verdict?: string
    probeId?: number
    startedAt?: number
    completedAt?: number
    isCurrentAppProcess?: boolean
    windowClass?: string
    focusClass?: string
    controlType?: string
    automationId?: string
    isValuePatternAvailable?: boolean
    isTextPatternAvailable?: boolean
    isTextPattern2Available?: boolean
    isTextEditPatternAvailable?: boolean
    isKeyboardFocusable?: boolean
    hasKeyboardFocus?: boolean
    isEnabled?: boolean
    isOffscreen?: boolean
    isReadOnly?: boolean
    contextMatched?: boolean
    contextMatchReason?: string
    contextProcessName?: string
    contextControlType?: string
    contextAutomationId?: string
  }>
  copyText: (text: string) => Promise<void>
  appendDebugLog: (payload: unknown) => void
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  historyList: (query?: {
    keyword?: string
    favoriteOnly?: boolean
    limit?: number
    offset?: number
  }) => Promise<unknown[]>
  historyCount: (query?: {
    keyword?: string
    favoriteOnly?: boolean
  }) => Promise<number>
  historyAdd: (record: unknown) => Promise<void>
  historyUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  historyDelete: (id: string) => Promise<void>
  historySetFavorite: (id: string, favorite: boolean) => Promise<void>
  saveTextExport: (payload: {
    defaultPath: string
    content: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<string | null>
  saveExportBundle: (payload: {
    defaultPath: string
    files: Array<{ name: string; content: string }>
  }) => Promise<string | null>
  notifyShortcutsChanged: () => void
  testShortcut: (accelerator: string) => Promise<{ valid: boolean }>
  getAutoLaunch: () => Promise<boolean>
  setAutoLaunch: (enable: boolean) => Promise<void>
  getUpdateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<UpdateStatus>
  installDownloadedUpdate: () => Promise<boolean>
  setPTTLabConfig: (data: unknown) => void
  collectSettings: () => Promise<Record<string, unknown>>
  getDiagnosticsPreview: (data: {
    settings: Record<string, unknown>
    issueOccurrence: DiagnosticOccurrence
  }) => Promise<DiagnosticsPreview>
  createDiagnosticsZip: (data: {
    description: string
    settings: Record<string, unknown>
    issueOccurrence: DiagnosticOccurrence
    images: Array<{ name: string; data: number[]; size: number; type: string }>
  }) => Promise<string>
  readDiagnosticsZip: (path: string) => Promise<number[] | null>
  readLogFile: (logType: 'frontend' | 'ptt') => Promise<string | null>
  saveAudioFile: (id: string, wavBase64: string) => Promise<string>
  readAudioFile: (filePath: string) => Promise<string | null>
  deleteAudioFile: (filePath: string) => Promise<boolean>
  onOverlayState: (cb: (data: unknown) => void) => void
  onActiveAppContext: (cb: (data: ActiveAppContext | null) => void) => () => void
  onPTTDown: (cb: (data?: unknown) => void) => void
  onPTTUp: (cb: (data?: unknown) => void) => void
  onPTTToggle: (cb: (data?: unknown) => void) => void
  onPTTTimeoutWarning: (cb: (data?: unknown) => void) => void
  onToggleHandsFree: (cb: (data?: unknown) => void) => void
  onPTTLabEvent: (cb: (data?: unknown) => void) => () => void
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void
}
