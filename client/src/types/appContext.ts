export interface TextContext {
  source: string
  textBefore: string
  selectedText: string
  textAfter: string
  selectionTruncated: boolean
}

/** 原生层读正文的诊断，只有原因码和计数（原因码见 context/mod.rs 的 TextContextDiag）。 */
export interface TextContextDiag {
  result: string
  depth?: number
  elapsedMs: number
}

export interface ActiveAppContext {
  reason?: string
  timestamp?: number
  hwnd?: string
  pid?: number
  tid?: number
  processName?: string
  exePath?: string
  /** macOS 的 Bundle ID（如 com.tencent.xinWeChat）；Windows 上没有 */
  bundleId?: string
  windowTitle?: string
  windowClass?: string
  focusHwnd?: string
  caretHwnd?: string
  hasCaret?: boolean
  focusClass?: string
  controlType?: string
  automationId?: string
  focusedName?: string
  automationProcessId?: number
  isValuePatternAvailable?: boolean
  isTextPatternAvailable?: boolean
  isTextPattern2Available?: boolean
  isTextEditPatternAvailable?: boolean
  isKeyboardFocusable?: boolean
  hasKeyboardFocus?: boolean
  isEnabled?: boolean
  isOffscreen?: boolean
  isReadOnly?: boolean
  isPassword?: boolean
  isCurrentAppProcess?: boolean
  /** Only populated for a recording when context-aware writing is explicitly enabled. */
  textContext?: TextContext
  /** 请求了正文时才有，读到或没读到都有。 */
  textContextDiag?: TextContextDiag
}
