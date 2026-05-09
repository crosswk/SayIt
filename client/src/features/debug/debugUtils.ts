import { USER_PROMPT_PREFIX } from '@/services/store'
import { type DebugMessage, type DebugSession, type RuntimeEvent } from '@/services/debugLog'
import {
  type ASRPayload,
  type FinalPayload,
  type PTTHoldPair,
  type PTTEventKind,
  type PTTTimelineEvent,
  type ReadyPayload,
  type StartPayload,
  type LLMMessage,
} from './types'

const PTT_KINDS = new Set(['down', 'up', 'toggle', 'hands_free'])

export const USEFUL_LOG_TYPES = new Set(['start', 'ready', 'stop', 'asr', 'final', 'error', 'done'])

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return '0.0s'
  return `${sec.toFixed(1)}s`
}

export function formatMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  return `${Math.round(ms)}ms`
}

function normalizePTTKind(message: string): PTTEventKind | null {
  if (!message.startsWith('event:')) return null
  const raw = message.slice(6).trim()
  if (!PTT_KINDS.has(raw)) return null
  return raw as PTTEventKind
}

export function parsePTTEvent(event: RuntimeEvent): PTTTimelineEvent | null {
  if (event.source !== 'ptt') return null
  const kind = normalizePTTKind(String(event.message || ''))
  if (!kind) return null

  const detail = (event.detail && typeof event.detail === 'object')
    ? (event.detail as Record<string, unknown>)
    : {}
  const modifiersRaw = (detail.modifiers && typeof detail.modifiers === 'object')
    ? (detail.modifiers as Record<string, unknown>)
    : {}
  const ts = Number(detail.timestamp)

  return {
    time: Number.isFinite(ts) && ts > 0 ? ts : event.time,
    kind,
    source: String(detail.source || 'unknown'),
    reason: String(detail.reason || '-'),
    keycode: typeof detail.keycode === 'number' ? detail.keycode : undefined,
    pttSetting: detail.pttSetting ? String(detail.pttSetting) : undefined,
    recorderState: detail.recorderState ? String(detail.recorderState) : undefined,
    modifiers: {
      alt: typeof modifiersRaw.alt === 'boolean' ? modifiersRaw.alt : undefined,
      ctrl: typeof modifiersRaw.ctrl === 'boolean' ? modifiersRaw.ctrl : undefined,
      shift: typeof modifiersRaw.shift === 'boolean' ? modifiersRaw.shift : undefined,
    },
  }
}

export function buildPTTHoldPairs(eventsAsc: PTTTimelineEvent[]): PTTHoldPair[] {
  const pairs: PTTHoldPair[] = []
  let pendingDown: PTTTimelineEvent | null = null

  for (const event of eventsAsc) {
    if (event.kind === 'down') {
      if (pendingDown) {
        pairs.push({ down: pendingDown })
      }
      pendingDown = event
      continue
    }

    if (event.kind === 'up') {
      if (!pendingDown) continue
      const holdMs = Math.max(0, event.time - pendingDown.time)
      pairs.push({ down: pendingDown, up: event, holdMs })
      pendingDown = null
    }
  }

  if (pendingDown) {
    pairs.push({ down: pendingDown })
  }

  return pairs
}

export function getPTTBadgeTone(kind: PTTEventKind) {
  if (kind === 'down') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (kind === 'up') return 'border-sky-200 bg-sky-50 text-sky-700'
  if (kind === 'toggle') return 'border-violet-200 bg-violet-50 text-violet-700'
  return 'border-amber-200 bg-amber-50 text-amber-700'
}

export function getPTTLabel(kind: PTTEventKind) {
  if (kind === 'down') return 'DOWN'
  if (kind === 'up') return 'UP'
  if (kind === 'toggle') return 'TOGGLE'
  return 'HANDS-FREE'
}

function getFirstMessage<T>(session: DebugSession, type: string) {
  return session.messages.find((message) => message.type === type)?.data as T | undefined
}

export function getFinalPayload(session: DebugSession): FinalPayload | undefined {
  return getFirstMessage<FinalPayload>(session, 'final')
}

export function getASRPayload(session: DebugSession): ASRPayload | undefined {
  return getFirstMessage<ASRPayload>(session, 'asr')
}

export function getReadyPayload(session: DebugSession): ReadyPayload | undefined {
  return getFirstMessage<ReadyPayload>(session, 'ready')
}

export function getHoldDurationSec(session: DebugSession): number {
  const stopMessage = session.messages.find((message) => message.direction === 'sent' && message.type === 'stop')
  if (stopMessage) {
    return Math.max(0, (stopMessage.time - session.startTime) / 1000)
  }
  if (session.endTime) {
    return Math.max(0, (session.endTime - session.startTime) / 1000)
  }
  return 0
}

export function extractPrompts(session: DebugSession) {
  const final = getFinalPayload(session)
  const start = getFirstMessage<StartPayload>(session, 'start')

  const messages = Array.isArray(final?.llm_debug?.messages)
    ? (final.llm_debug.messages as LLMMessage[])
    : []

  const systemFromDebug = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content || '')
    .join('\n\n----------------\n\n')

  const userFromDebug = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content || '')
    .join('\n\n----------------\n\n')

  const fallbackSystem = session.systemPrompt || start?.system_prompt || ''
  const fallbackUser = final?.asr_text ? `${USER_PROMPT_PREFIX}${final.asr_text}` : ''

  return {
    systemPrompt: systemFromDebug || fallbackSystem,
    userPrompt: userFromDebug || fallbackUser,
    rawOutput: final?.llm_debug?.raw_output || '',
    provider: final?.llm_debug?.provider || '-',
  }
}

export function summarizeMessage(msg: DebugMessage) {
  const data = msg.data as Record<string, unknown>

  if (msg.type === 'asr') {
    const text = String(data?.text || '')
    const ms = Number(data?.asr_ms || 0)
    const sec = Number(data?.duration_sec || 0)
    return `ASR ${ms}ms / ${formatDuration(sec)} / ${text.slice(0, 80)}`
  }

  if (msg.type === 'final') {
    const llmText = String(data?.llm_text || data?.asr_text || '')
    const asrMs = Number(data?.asr_ms || 0)
    const llmMs = Number(data?.llm_ms || 0)
    return `FINAL ASR ${asrMs}ms / LLM ${llmMs}ms / ${llmText.slice(0, 80)}`
  }

  if (msg.type === 'ready') {
    return `连接就绪 id=${String(data?.connection_id || '-')}`
  }

  if (msg.type === 'start') {
    return '开始录音会话'
  }

  if (msg.type === 'stop') {
    return '停止录音并等待处理'
  }

  if (msg.type === 'error') {
    return `ERROR: ${String(data?.message || '未知错误')}`
  }

  return JSON.stringify(msg.data)
}

export function getSessionDurationBytes(session: DebugSession) {
  return session.audioChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
}

export function resolveSessionSampleRate(session: DebugSession): number {
  const configured = Math.max(8000, Number(session.sampleRate || 16000))

  const asr = getASRPayload(session)
  const final = getFinalPayload(session)
  const asrDurationSec = Number(asr?.duration_sec || final?.asr_debug?.duration_sec || final?.duration_sec || 0)

  if (!Number.isFinite(asrDurationSec) || asrDurationSec <= 0) {
    return configured
  }

  const totalSamples = Math.floor(getSessionDurationBytes(session) / 2)
  if (totalSamples <= 0) return configured

  const inferred = Math.round(totalSamples / asrDurationSec)
  if (!Number.isFinite(inferred) || inferred < 8000 || inferred > 96000) {
    return configured
  }

  const drift = Math.abs(inferred - configured) / configured
  return drift > 0.2 ? inferred : configured
}

export function joinPCMChunks(chunks: ArrayBuffer[]): Int16Array | null {
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const alignedBytes = totalBytes - (totalBytes % 2)
  if (alignedBytes <= 0) return null

  const pcmBytes = new Uint8Array(alignedBytes)
  let offset = 0

  for (const chunk of chunks) {
    if (offset >= alignedBytes) break
    const source = new Uint8Array(chunk)
    const remain = alignedBytes - offset
    const length = Math.min(source.byteLength, remain)
    pcmBytes.set(source.subarray(0, length), offset)
    offset += length
  }

  return new Int16Array(pcmBytes.buffer)
}
