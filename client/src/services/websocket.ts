// WebSocket service for communicating with SayIt backend

import {
  addMsg,
  addAudioChunk,
  startSession,
  endSession,
  addRuntimeEvent,
  hasActiveSession,
} from './debugLog'
import { getWSUrl } from './runtimeConfig'
import { withLegacyServerTextContext } from './contextAware'
import { extractServerAiEvidence } from './transcription/aiPolicy'
import { setConnectionStatus } from '../stores/connectionStatus'
import type { ActiveAppContext, TextContext } from '../types/appContext'
import type { ClientRuntimeInfo } from '../types/appApi'

export type WSState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ASRResult {
  text: string
  asrMs: number
  durationSec: number
}

export interface FinalResult {
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  asrEngine?: string
  asrModel?: string
  contextApplied?: boolean
  /**
   * 服务端 AI 的执行证据，从 llm_debug 里只摘 error 与 provider。
   * 有它才能把「服务端跑了但很快」和「服务端压根没跑」分开 —— llm_ms=0 分不出来。
   * 刻意不透传整个 llm_debug：服务器开了 debug_llm 时它带完整 prompt 与原始输出。
   */
  serverAi?: { error?: string; provider?: string }
}

export interface AudioStats {
  avgRms: number
  peakRms: number
  peakAmplitude: number
  silenceRatio: number
  totalFrames: number
}

export interface WSCallbacks {
  onStateChange?: (state: WSState) => void
  onReady?: (data: { connectionId: string; asr: boolean; llm: boolean }) => void
  onASR?: (result: ASRResult) => void
  onFinal?: (result: FinalResult) => void
  onDone?: () => void
  onError?: (msg: string) => void
}

let ws: WebSocket | null = null
let callbacks: WSCallbacks = {}
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let intentionalClose = false
/** 连接建立的时间戳，用于日志里计算连接存活时长 */
let connectStartMs = 0
let openedAtMs = 0

/** 抓取一小段调用栈（去掉本函数与 Error 头两行），用于日志里定位「谁触发了连接/关闭」。 */
function shortCallerStack(): string {
  const raw = new Error().stack || ''
  return raw
    .split('\n')
    .slice(2, 5)
    .map((l) => l.trim().replace(/^at\s+/, ''))
    .join(' <- ')
}

// --- 重连退避 ---
let reconnectAttempts = 0
const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30_000
// 服务端限流类关闭码（1013 服务器满、4029 该 IP 并发超限）：退避更久，避免重连风暴
const RECONNECT_LIMIT_MIN_MS = 15_000
const LIMIT_CLOSE_CODES = new Set([1013, 4029])

/** 计算下次重连延迟：指数退避 + ±20% 抖动；限流码时至少退避 RECONNECT_LIMIT_MIN_MS */
function computeReconnectDelayMs(closeCode?: number): number {
  const exp = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS)
  const base = closeCode !== undefined && LIMIT_CLOSE_CODES.has(closeCode)
    ? Math.max(exp, RECONNECT_LIMIT_MIN_MS)
    : exp
  const jitter = base * 0.2 * (Math.random() * 2 - 1)
  return Math.max(1000, Math.round(base + jitter))
}
let sessionStarted = false
let audioDropWarned = false
/** Advertised by new servers in the ready message. Missing means a rolling-upgrade legacy server. */
let serverSupportsTextContext = false
/** Whether the current request placed a compatibility capsule in system_prompt. */
let legacyTextContextForSession = false

// --- Heartbeat ---
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 10_000
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let pongTimer: ReturnType<typeof setTimeout> | null = null

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ cmd: 'ping' }))
      // Start pong timeout
      pongTimer = setTimeout(() => {
        addRuntimeEvent('warn', 'websocket', 'Heartbeat timed out: no pong for 10s; disconnecting')
        // Force close so onclose triggers reconnect
        try { ws?.close(4000, 'heartbeat timeout') } catch { /* ignore */ }
      }, HEARTBEAT_TIMEOUT_MS)
    } catch {
      // send failed, connection is likely dead
      try { ws?.close(4000, 'heartbeat send failed') } catch { /* ignore */ }
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
}

function handlePong() {
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
}

function updateGlobalState(state: WSState) {
  setConnectionStatus(state)
  callbacks.onStateChange?.(state)
}

// HMR cleanup: close WebSocket when module is hot-replaced
if ((import.meta as unknown as Record<string, unknown>).hot) {
  const hot = (import.meta as unknown as Record<string, unknown>).hot as { dispose: (cb: () => void) => void }
  hot.dispose(() => {
    console.log('[websocket] HMR dispose: closing WebSocket')
    intentionalClose = true
    stopHeartbeat()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    try { ws?.close() } catch { /* ignore */ }
    ws = null
    serverSupportsTextContext = false
    sessionStarted = false
    legacyTextContextForSession = false
  })
}

function endSessionIfNeeded() {
  if (sessionStarted || hasActiveSession()) {
    sessionStarted = false
    endSession()
  }
  audioDropWarned = false
  legacyTextContextForSession = false
}

export function connect(cbs: WSCallbacks): Promise<void> {
  callbacks = cbs

  if (ws?.readyState === WebSocket.OPEN) {
    // 已经连上，直接复用（connect 幂等）。这是每次开始录音的正常路径，不记日志避免刷屏；
    // 真正异常的连接场景由 开始连接/连接成功/主动关闭/关闭未就绪连接 等日志覆盖。
    return Promise.resolve()
  }

  if (ws) {
    // 上一条连接还在（可能仍在 CONNECTING，或刚 open 尚未标记就绪）。这里会主动关掉它再重连，
    // 这正是「连上几秒就被自己关掉、且没发 start」最可能的元凶——记录下来看看是谁触发的。
    const prevState = ws.readyState
    addRuntimeEvent('warn', 'websocket', 'connect() closed the previous unready connection before reconnecting', {
      prevReadyState: prevState, // 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
      caller: shortCallerStack(),
    })
    intentionalClose = true
    try {
      ws.close()
    } catch {
      // ignore
    }
    ws = null
  }

  // 新连接一发起（按热键开录、改了服务器地址），排着的自动重连就多余了；不清掉的话
  // 它到点还会再 connect() 一次，把这条还在握手的连接当成「未就绪」关掉重来。
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  return new Promise((resolve, reject) => {
    intentionalClose = false
    serverSupportsTextContext = false
    let opened = false
    updateGlobalState('connecting')
    const wsUrl = getWSUrl()
    connectStartMs = Date.now()
    addRuntimeEvent('info', 'websocket', 'Connecting', { url: wsUrl, caller: shortCallerStack() })

    const socket = new WebSocket(wsUrl)
    socket.binaryType = 'arraybuffer'
    ws = socket

    const timeout = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        try {
          socket.close()
        } catch {
          // ignore
        }
        updateGlobalState('error')
        addRuntimeEvent('error', 'websocket', 'Connection timed out (10s)', { url: wsUrl })
        reject(new Error('WebSocket connection timeout'))
      }
    }, 10000)

    socket.onopen = () => {
      clearTimeout(timeout)
      opened = true
      openedAtMs = Date.now()
      updateGlobalState('connected')
      const wasReconnect = reconnectAttempts > 0
      addRuntimeEvent('info', 'websocket', wasReconnect ? `Reconnected on attempt ${reconnectAttempts}` : 'Connected', {
        elapsedMs: connectStartMs ? openedAtMs - connectStartMs : undefined,
      })
      reconnectAttempts = 0
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      startHeartbeat()
      resolve()
    }

    socket.onmessage = (e) => {
      // 已被 cancel/disconnect 替换的旧 socket 即使队列里还有消息，也绝不能
      // 投递给新会话的 callbacks。
      if (ws !== socket) return
      if (typeof e.data !== 'string') return
      try {
        const msg = JSON.parse(e.data)
        addMsg('received', msg.type || 'unknown', msg)

        switch (msg.type) {
          case 'ready':
            serverSupportsTextContext = msg?.capabilities?.text_context === true
            addRuntimeEvent('info', 'websocket', 'Ready received', {
              connectionId: msg.connection_id,
              asr: msg.asr,
              llm: msg.llm,
              textContext: serverSupportsTextContext,
            })
            callbacks.onReady?.({
              connectionId: msg.connection_id,
              asr: msg.asr,
              llm: msg.llm,
            })
            break
          case 'pong':
            handlePong()
            break
          case 'asr':
            callbacks.onASR?.({
              text: msg.text,
              asrMs: msg.asr_ms,
              durationSec: Number(msg.duration_sec || 0),
            })
            break
          case 'final': {
            const durationFromAsrDebug = Number(msg?.asr_debug?.duration_sec || 0)
            const explicitContextApplied = typeof msg.context_applied === 'boolean'
              ? msg.context_applied
              : undefined
            const legacyContextApplied = explicitContextApplied === undefined
              && legacyTextContextForSession
              && Boolean(msg?.llm_debug?.provider)
            callbacks.onFinal?.({
              asrText: msg.asr_text,
              llmText: msg.llm_text,
              asrMs: msg.asr_ms,
              llmMs: msg.llm_ms,
              durationSec: Number(msg.duration_sec || durationFromAsrDebug || 0),
              asrEngine: msg.asr_engine || undefined,
              asrModel: msg.asr_model || undefined,
              contextApplied: explicitContextApplied ?? (legacyContextApplied ? true : undefined),
              // 只摘这两个结论性字段往下传，llm_debug 本体留在这里（开了 debug_llm 时
              // 它带完整 prompt 和原始输出，不能顺着结果对象扩散）。
              serverAi: extractServerAiEvidence(msg?.llm_debug),
            })
            break
          }
          case 'done':
            endSessionIfNeeded()
            callbacks.onDone?.()
            break
          case 'error':
            addRuntimeEvent('error', 'backend', String(msg.message || 'unknown backend error'), msg)
            endSessionIfNeeded()
            callbacks.onError?.(String(msg.message || 'unknown backend error'))
            break
        }
      } catch (err) {
        addRuntimeEvent('error', 'websocket', 'Message parsing failed', {
          error: String(err),
          raw: e.data,
        })
      }
    }

    socket.onerror = (ev) => {
      if (ws !== socket) return
      clearTimeout(timeout)
      updateGlobalState('error')
      addRuntimeEvent('error', 'websocket', 'Connection error', {
        event: String(ev.type || 'error'),
      })
    }

    socket.onclose = (ev) => {
      clearTimeout(timeout)
      // 没 open 就关了（拒连、ALB 502、被 disconnect()/新的 connect() 替换）必须 reject：
      // 上面这行已经清掉了 10 秒超时，不在这里结束，等它的 await 就永远挂着 ——
      // 按热键开录时表现为麦克风开着、悬浮窗停在等待、不报错。超时那条路已 reject 过，再调无副作用。
      if (!opened) reject(new Error(`WebSocket closed before open (code=${ev.code})`))
      if (ws !== socket) {
        addRuntimeEvent('info', 'websocket', 'Ignored close event from stale connection', { code: ev.code })
        return
      }
      stopHeartbeat()
      ws = null
      serverSupportsTextContext = false
      updateGlobalState('disconnected')

      const aliveMs = openedAtMs ? Date.now() - openedAtMs : undefined
      const sentStart = sessionStarted
      endSessionIfNeeded()

      if (!intentionalClose) {
        const delay = computeReconnectDelayMs(ev.code)
        addRuntimeEvent('warn', 'websocket', `Connection closed code=${ev.code} reason=${ev.reason || '-'}; reconnecting in ${Math.round(delay / 1000)}s`, {
          code: ev.code,
          attempt: reconnectAttempts + 1,
          aliveMs,
          sentStart,
        })
        reconnectAttempts++
        // 自动重连没有调用方等结果；失败已由超时/onclose 记过日志，这里吞掉，
        // 否则每次重连超时都多一条 Unhandled promise rejection。
        reconnectTimer = setTimeout(() => { connect(callbacks).catch(() => { }) }, delay)
      } else {
        // 主动关闭这一路以前是完全静默的（切换供应商/地址、connect() 替换旧连接、disconnect()）。
        // 现在也记一条，标明是客户端主动关的，便于区分「服务端踢」还是「客户端自己关」。
        addRuntimeEvent('warn', 'websocket', `Connection closed intentionally code=${ev.code} reason=${ev.reason || '-'}`, {
          code: ev.code,
          aliveMs,
          sentStart,
          caller: shortCallerStack(),
        })
      }
      openedAtMs = 0
    }
  })
}

export function disconnect() {
  addRuntimeEvent('info', 'websocket', 'disconnect() called', {
    hadSocket: !!ws,
    readyState: ws?.readyState,
    caller: shortCallerStack(),
  })
  intentionalClose = true
  reconnectAttempts = 0
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const socket = ws
  ws = null
  serverSupportsTextContext = false
  try {
    socket?.close()
  } catch {
    // ignore
  }
  updateGlobalState('disconnected')
  endSessionIfNeeded()
}

export function sendStart(opts?: {
  systemPrompt?: string
  disableAi?: boolean
  clientMeta?: ClientRuntimeInfo | null
  appContext?: ActiveAppContext | null
  textContext?: TextContext | null
  source?: string
  hotwords?: string[]
  language?: string
}): boolean {
  if (ws?.readyState !== WebSocket.OPEN) {
    addRuntimeEvent('error', 'websocket', 'Failed to send start: connection not ready')
    return false
  }

  const msg: Record<string, unknown> = { cmd: 'start', source: opts?.source || 'live' }
  legacyTextContextForSession = Boolean(opts?.textContext && !serverSupportsTextContext)
  const effectiveSystemPrompt = legacyTextContextForSession && opts?.systemPrompt && opts.textContext
    ? withLegacyServerTextContext(opts.systemPrompt, opts.textContext)
    : opts?.systemPrompt
  if (effectiveSystemPrompt) msg.system_prompt = effectiveSystemPrompt
  if (opts?.disableAi) msg.disable_ai = true
  if (opts?.clientMeta) {
    msg.client_meta = {
      user_id: opts.clientMeta.userId,
      device_id: opts.clientMeta.deviceId,
      hostname: opts.clientMeta.hostname,
      client_version: opts.clientMeta.clientVersion,
      platform: opts.clientMeta.platform,
      os_version: opts.clientMeta.osVersion,
      local_ip: opts.clientMeta.localIp,
      system_locale: opts.clientMeta.systemLocale,
      cpu_cores: opts.clientMeta.cpuCores,
      memory_mb: opts.clientMeta.memoryMb,
    }
  }
  if (opts?.appContext) {
    msg.app_context = {
      process_name: opts.appContext.processName,
      exe_path: opts.appContext.exePath,
      window_class: opts.appContext.windowClass,
      focus_class: opts.appContext.focusClass,
      control_type: opts.appContext.controlType,
    }
  }
  if (opts?.textContext) {
    msg.text_context = {
      source: opts.textContext.source,
      text_before: opts.textContext.textBefore,
      selected_text: opts.textContext.selectedText,
      text_after: opts.textContext.textAfter,
      selection_truncated: opts.textContext.selectionTruncated,
    }
  }
  if (opts?.hotwords && opts.hotwords.length > 0) {
    msg.hotwords = opts.hotwords
  }
  if (opts?.language) {
    msg.language = opts.language
  }

  try {
    startSession(opts)
    // Never persist editor text through the compatibility system prompt. The wire request uses the
    // effective prompt; diagnostics retain the original content-free prompt plus bounded lengths.
    addMsg('sent', 'start', legacyTextContextForSession
      ? { ...msg, system_prompt: opts?.systemPrompt }
      : msg)
    if (legacyTextContextForSession) {
      addRuntimeEvent('warn', 'websocket', 'Using legacy server text-context compatibility', {
        source: opts?.textContext?.source,
        beforeLen: opts?.textContext?.textBefore.length,
        selectedLen: opts?.textContext?.selectedText.length,
        afterLen: opts?.textContext?.textAfter.length,
      })
    }
    ws.send(JSON.stringify(msg))
    sessionStarted = true
    audioDropWarned = false
    return true
  } catch (err) {
    addRuntimeEvent('error', 'websocket', 'Failed to send start', { error: String(err) })
    endSessionIfNeeded()
    return false
  }
}

export function sendStop(opts?: {
  pttHoldMs?: number
  /** 松键时补上的「这次别做 AI」。服务端在收到 stop 之后才开始 ASR+AI，来得及。 */
  disableAi?: boolean
  audioStats?: AudioStats
}): boolean {
  if (!sessionStarted) {
    return false
  }

  if (ws?.readyState !== WebSocket.OPEN) {
    addRuntimeEvent('error', 'websocket', 'Failed to send stop: connection not ready')
    endSessionIfNeeded()
    return false
  }

  try {
    const payload: Record<string, unknown> = { cmd: 'stop' }
    if (typeof opts?.pttHoldMs === 'number' && Number.isFinite(opts.pttHoldMs)) {
      payload.usage_meta = { ptt_hold_ms: Math.max(0, Math.round(opts.pttHoldMs)) }
    }
    if (opts?.disableAi) payload.disable_ai = true
    if (opts?.audioStats) {
      payload.audio_stats = {
        avg_rms: opts.audioStats.avgRms,
        peak_rms: opts.audioStats.peakRms,
        peak_amplitude: opts.audioStats.peakAmplitude,
        silence_ratio: opts.audioStats.silenceRatio,
        total_frames: opts.audioStats.totalFrames,
      }
    }
    addMsg('sent', 'stop', payload)
    ws.send(JSON.stringify(payload))
    return true
  } catch (err) {
    addRuntimeEvent('error', 'websocket', 'Failed to send stop', { error: String(err) })
    endSessionIfNeeded()
    return false
  }
}

export function sendAudio(buffer: ArrayBuffer) {
  if (!sessionStarted) {
    return
  }

  if (ws?.readyState === WebSocket.OPEN) {
    audioDropWarned = false
    try {
      ws.send(buffer)
      addAudioChunk(buffer)
    } catch (err) {
      addRuntimeEvent('error', 'websocket', 'Failed to send audio', {
        error: String(err),
        bytes: buffer.byteLength,
      })
    }
    return
  }

  if (!audioDropWarned) {
    audioDropWarned = true
    addRuntimeEvent('warn', 'websocket', 'Audio discarded: connection is closed', { bytes: buffer.byteLength })
  }
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN
}
