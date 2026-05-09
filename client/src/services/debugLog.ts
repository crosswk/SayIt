export interface DebugMessage {
  time: number
  direction: 'sent' | 'received'
  type: string
  data: unknown
}

export interface DebugSession {
  id: string
  startTime: number
  endTime?: number
  systemPrompt?: string
  sampleRate?: number
  messages: DebugMessage[]
  audioChunks: ArrayBuffer[]  // raw PCM Int16 buffers sent to backend
}

export interface RuntimeEvent {
  time: number
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
  detail?: unknown
}

const MAX_SESSIONS = 80
const MAX_RUNTIME_EVENTS = 120
const MAX_MESSAGES_PER_SESSION = 40
const DEFAULT_PCM_SAMPLE_RATE = 16000
const MAX_AUDIO_BYTES_PER_SESSION = 256 * 1024
const MAX_AUDIO_BYTES_TOTAL = 2 * 1024 * 1024
const ENABLE_INFO_CONSOLE = false

let totalAudioBytes = 0

function shouldMirrorPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const value = payload as Record<string, unknown>

  if (value.kind === 'runtime') {
    const level = value.level
    const source = typeof value.source === 'string' ? value.source : ''
    const message = typeof value.message === 'string' ? value.message : ''

    if (level === 'error' || level === 'warn') return true
    if (level !== 'info') return false

    return source === 'recorder' && /(开始录音|停止录音|进入 processing|收到 final|注入成功|注入失败|处理超时|展示兜底卡片)/.test(message)
      || source === 'websocket' && /(连接关闭|连接超时|发送 start 失败|发送 stop 失败)/.test(message)
      || source === 'backend'
  }

  if (value.kind === 'ws_message') {
    const type = typeof value.type === 'string' ? value.type : ''
    return type === 'stop' || type === 'final' || type === 'done' || type === 'error'
  }

  return value.kind === 'session_start' || value.kind === 'session_end'
}

function shouldKeepRuntimeEvent(event: RuntimeEvent): boolean {
  if (event.level === 'error' || event.level === 'warn') return true
  if (event.source === 'backend') return true
  if (event.source === 'websocket') {
    return /(连接关闭|连接超时|发送 start 失败|发送 stop 失败)/.test(event.message)
  }
  if (event.source === 'recorder') {
    return /(开始录音|停止录音|进入 processing|收到 final|外部文本注入成功|外部文本注入失败|处理超时|展示兜底卡片)/.test(event.message)
  }
  return false
}

function shouldKeepMessage(type: string): boolean {
  return type === 'start' || type === 'stop' || type === 'ready' || type === 'final' || type === 'done' || type === 'error'
}

let sessions: DebugSession[] = []
let current: DebugSession | null = null
let runtimeEvents: RuntimeEvent[] = []

import { appendDebugLog } from './bridge'

function mirrorToMainLog(payload: unknown) {
  if (!shouldMirrorPayload(payload)) return
  try {
    appendDebugLog(payload)
  } catch {
    // ignore logging errors
  }
}

function trimSessions() {
  if (sessions.length > MAX_SESSIONS) {
    const removed = sessions.slice(MAX_SESSIONS)
    totalAudioBytes -= removed.reduce((sum, session) => (
      sum + session.audioChunks.reduce((chunkSum, chunk) => chunkSum + chunk.byteLength, 0)
    ), 0)
    sessions = sessions.slice(0, MAX_SESSIONS)
  }
}

function pushRuntimeEvent(event: RuntimeEvent) {
  if (!shouldKeepRuntimeEvent(event)) return
  runtimeEvents.unshift(event)
  if (runtimeEvents.length > MAX_RUNTIME_EVENTS) {
    runtimeEvents = runtimeEvents.slice(0, MAX_RUNTIME_EVENTS)
  }
}

export function addRuntimeEvent(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  detail?: unknown,
) {
  const event: RuntimeEvent = {
    time: Date.now(),
    level,
    source,
    message,
    detail,
  }

  pushRuntimeEvent(event)

  const logPrefix = `[${source}] ${message}`
  if (level === 'error') {
    console.error(logPrefix, detail)
  } else if (level === 'warn') {
    console.warn(logPrefix, detail)
  } else if (ENABLE_INFO_CONSOLE) {
    console.log(logPrefix, detail)
  } else if (source === 'recorder' && /(粘贴决策|外部文本注入|兜底|命中|目标不可编辑)/.test(message)) {
    // Always log paste-related info events for debugging insertion failures
    console.log(logPrefix, detail)
  }
  mirrorToMainLog({
    kind: 'runtime',
    level,
    source,
    message,
    detail,
    time: event.time,
  })

  // Keep the full runtime trail inside the active session for post-mortem debugging.
  if (current) {
    current.messages.push({
      time: event.time,
      direction: 'received',
      type: level === 'error' ? 'error' : 'runtime',
      data: {
        source,
        message,
        detail,
      },
    })
    if (current.messages.length > MAX_MESSAGES_PER_SESSION) {
      current.messages = current.messages.slice(-MAX_MESSAGES_PER_SESSION)
    }
  }
}

export function startSession(opts?: { systemPrompt?: string }) {
  const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  current = {
    id: sessionId,
    startTime: Date.now(),
    systemPrompt: opts?.systemPrompt,
    sampleRate: DEFAULT_PCM_SAMPLE_RATE,
    messages: [],
    audioChunks: [],
  }

  sessions.unshift(current)
  trimSessions()
  mirrorToMainLog({
    kind: 'session_start',
    sessionId,
    hasSystemPrompt: Boolean(opts?.systemPrompt),
  })
}

export function endSession() {
  if (current) {
    const endedId = current.id
    const endTime = Date.now()
    current.endTime = Date.now()
    mirrorToMainLog({
      kind: 'session_end',
      sessionId: endedId,
      durationMs: endTime - current.startTime,
      messageCount: current.messages.length,
      audioChunks: current.audioChunks.length,
    })
    current = null
  }
}

export function hasActiveSession() {
  return !!current
}

export function addMsg(direction: 'sent' | 'received', type: string, data: unknown) {
  const time = Date.now()
  // 对 start 消息中的敏感字段脱敏后再记录
  const sanitizedData = (type === 'start' && data && typeof data === 'object')
    ? sanitizeStartMessage(data as Record<string, unknown>)
    : data
  if (current && shouldKeepMessage(type)) {
    current.messages.push({ time, direction, type, data: sanitizedData })
    if (current.messages.length > MAX_MESSAGES_PER_SESSION) {
      current.messages = current.messages.slice(-MAX_MESSAGES_PER_SESSION)
    }
  }
  mirrorToMainLog({
    kind: 'ws_message',
    direction,
    type,
    time,
    data: sanitizedData,
  })
}

export function addAudioChunk(buffer: ArrayBuffer) {
  if (!current) return
  if (totalAudioBytes >= MAX_AUDIO_BYTES_TOTAL) return
  const nextBytes = current.audioChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) + buffer.byteLength
  if (nextBytes > MAX_AUDIO_BYTES_PER_SESSION) return
  const copy = buffer.slice(0)
  current.audioChunks.push(copy)
  totalAudioBytes += copy.byteLength
}

export function getSessions(): DebugSession[] {
  return sessions
}

export function clearSessions() {
  sessions = []
  current = null
  totalAudioBytes = 0
}

export function getRuntimeEvents(): RuntimeEvent[] {
  return runtimeEvents
}

export function clearRuntimeEvents() {
  runtimeEvents = []
}

export function getSessionAudioBlob(session: DebugSession): Blob | null {
  if (session.audioChunks.length === 0) return null

  const totalLen = session.audioChunks.reduce((s, c) => s + c.byteLength, 0)
  if (totalLen === 0) return null

  const pcm = new Uint8Array(totalLen)
  let offset = 0
  for (const chunk of session.audioChunks) {
    pcm.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }

  const sessionRate = Number(session.sampleRate || DEFAULT_PCM_SAMPLE_RATE)
  const sampleRate = Number.isFinite(sessionRate) && sessionRate >= 8000
    ? Math.round(sessionRate)
    : DEFAULT_PCM_SAMPLE_RATE

  return createWavBlob(pcm, sampleRate, 16, 1)
}

function createWavBlob(pcmData: Uint8Array, sampleRate: number, bitsPerSample: number, channels: number): Blob {
  const dataLen = pcmData.byteLength
  const buffer = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buffer)

  writeStr(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(view, 8, 'WAVE')

  writeStr(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true)
  view.setUint16(32, channels * bitsPerSample / 8, true)
  view.setUint16(34, bitsPerSample, true)

  writeStr(view, 36, 'data')
  view.setUint32(40, dataLen, true)
  new Uint8Array(buffer, 44).set(pcmData)

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

/** 对 WebSocket start 消息中的敏感字段脱敏 */
function sanitizeStartMessage(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data }

  // system_prompt 截断到 50 字符
  if (typeof result.system_prompt === 'string' && result.system_prompt.length > 50) {
    result.system_prompt = result.system_prompt.slice(0, 50) + '...[truncated]'
  }

  // client_meta 中移除敏感字段
  if (result.client_meta && typeof result.client_meta === 'object') {
    const meta = { ...(result.client_meta as Record<string, unknown>) }
    delete meta.local_ip
    delete meta.user_name
    delete meta.hostname
    result.client_meta = meta
  }

  return result
}
