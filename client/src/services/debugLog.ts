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

// 刻意**不**放行 'Paste decision'：它带十几个字段，而插字绝大多数是成功的，常态化
// 落盘只会把日志冲淡，真正要看的那几行反而更难找。插字排查需要的信息改为挂在
// 下面三条事件的 gate 字段上（成功 / 插了但失败 / 没敢插各一条），失败那条另外带
// 完整的四层判据取值。判据是"按需详细"：平时一行，出事那次才记全。
const RECORDER_KEY_EVENT = /(Recording started|Recording stopped|Entered processing|Final result received|External text insertion succeeded|External text insertion failed|Processing timed out|Showing fallback card)/i
const WEBSOCKET_KEY_EVENT = /(Connection closed|Connection timed out|Failed to send start|Failed to send stop|Connecting|Connected|Reconnected|Ready received|disconnect)/i
/**
 * 采集链路的关键节点。放行它们是为了能回答一个此前查不到的问题：
 * 「这次录音，麦克风到底有没有把数据交上来、交上来的是不是全 0」。
 *
 * 这条通道缺失过一次代价很大：用户报「休眠唤醒后一直提示未检测到声音、重启软件无效」，
 * 而 audio 的 info 事件全被这里过滤掉，日志里既看不到 track 的 muted/readyState，
 * 也看不到有没有收到过 PCM —— 只能靠读代码猜，猜不出坏在哪一层。
 * 量很小（每次录音 4~6 条），换来的是一份日志就能定性。
 */
const AUDIO_KEY_EVENT = /(Microphone capture started|AudioContext|First PCM frame received|First RMS received|ScriptProcessorNode fallback activated|Capture stop summary)/i
const INSERTION_EVENT = /(Paste decision|External text insertion|fallback|Target is SayIt|Target is not editable)/i

/**
 * AI 整理链路的固定事件名。**按事件名放行，不按英文文案正则**。
 *
 * 上面几条走正则是历史包袱：日志能不能落盘取决于有没有人改动英文文案，改一个词
 * 就静默失去一条诊断线索。这两条是"没有它就查不出为什么没整理"的关键事件，
 * 用不随文案变化的稳定名字，并且只放行这两个 —— 不放行整个 'ai' 来源，
 * 也不借用已有的 'backend'（借了以后就分不清是后端还是 AI 的事）。
 *
 * 量：正常跳过每次录音 1 条；真的调了自配 AI 是 2 条。
 */
export const AI_LOG_SOURCE = 'ai'
export const AI_EVENT_REQUEST = 'ai.request'
export const AI_EVENT_OUTCOME = 'ai.outcome'
/** 「随便问」的请求与结论（只有长度、模型、联网方式）。量：每次提问 2 条。 */
export const AI_EVENT_ASK_REQUEST = 'ai.ask.request'
export const AI_EVENT_ASK_OUTCOME = 'ai.ask.outcome'
const AI_KEY_EVENTS = new Set<string>([AI_EVENT_REQUEST, AI_EVENT_OUTCOME, AI_EVENT_ASK_REQUEST, AI_EVENT_ASK_OUTCOME])

let totalAudioBytes = 0

/**
 * 启动时自动改了用户配置（目前是把已下线的模型名换成新名字）。同 AI 那两条，按事件名放行。
 *
 * 不放行的话，这次改动在日志和调试页里都查不到：用户问「模型名怎么自己变了」时无从说起。
 * 量：只在真的改了东西的那次启动记一两条。
 */
export const SETTINGS_EVENT_MODEL_RENAMED = 'settings.retired_model_renamed'
const SETTINGS_KEY_EVENTS = new Set<string>([SETTINGS_EVENT_MODEL_RENAMED])

function shouldMirrorPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const value = payload as Record<string, unknown>

  if (value.kind === 'runtime') {
    const level = value.level
    const source = typeof value.source === 'string' ? value.source : ''
    const message = typeof value.message === 'string' ? value.message : ''

    if (level === 'error' || level === 'warn') return true
    if (level !== 'info') return false

    return source === 'recorder' && RECORDER_KEY_EVENT.test(message)
      || source === 'websocket' && WEBSOCKET_KEY_EVENT.test(message)
      || source === 'audio' && AUDIO_KEY_EVENT.test(message)
      || source === AI_LOG_SOURCE && AI_KEY_EVENTS.has(message)
      || source === 'settings' && SETTINGS_KEY_EVENTS.has(message)
      || source === 'backend'
      // update 全放行：整条更新链路是用户**看不见**的（后台检查、后台下载、退出时安装），
      // 出问题时日志是唯一线索。量也极小：启动一次 + 每 6 小时一次。
      // 少了这条，"没有新版本"和"更新服务压根没跑起来"在日志里长得一模一样。
      || source === 'update'
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
  // 必须和 shouldMirrorPayload 同步放行：两套判据分开写过一次，结果出现"内存里有、
  // 日志里没有"，而排查用的是日志。
  if (event.source === AI_LOG_SOURCE) return AI_KEY_EVENTS.has(event.message)
  if (event.source === 'settings') return SETTINGS_KEY_EVENTS.has(event.message)
  // 见 shouldMirrorPayload 里的同名分支：更新链路用户看不见，诊断只能靠日志
  if (event.source === 'update') return true
  if (event.source === 'websocket') {
    return WEBSOCKET_KEY_EVENT.test(event.message)
  }
  if (event.source === 'recorder') {
    return RECORDER_KEY_EVENT.test(event.message)
  }
  if (event.source === 'audio') {
    return AUDIO_KEY_EVENT.test(event.message)
  }
  return false
}

function shouldKeepMessage(type: string): boolean {
  return type === 'start' || type === 'stop' || type === 'ready' || type === 'final' || type === 'done' || type === 'error'
}

let sessions: DebugSession[] = []
let current: DebugSession | null = null
/** current.audioChunks 的总字节数，跟着 current 一起重置。 */
let currentAudioBytes = 0
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
  } else if (source === 'recorder' && INSERTION_EVENT.test(message)) {
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
  currentAudioBytes = 0

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
  // 计数而不是每帧把已存的块重新加一遍：录音期间这里每发一个音频包就调一次。
  const nextBytes = currentAudioBytes + buffer.byteLength
  if (nextBytes > MAX_AUDIO_BYTES_PER_SESSION) return
  const copy = buffer.slice(0)
  current.audioChunks.push(copy)
  currentAudioBytes = nextBytes
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

  // Editor text is ephemeral and must never enter runtime logs/debug exports. Keep only enough
  // metadata to verify whether capture worked on a user's machine.
  if (result.text_context && typeof result.text_context === 'object') {
    const context = result.text_context as Record<string, unknown>
    result.text_context = {
      source: String(context.source || ''),
      before_len: String(context.text_before || '').length,
      selected_len: String(context.selected_text || '').length,
      after_len: String(context.text_after || '').length,
    }
  }

  return result
}
