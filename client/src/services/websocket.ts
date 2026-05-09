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
import { setConnectionStatus } from '../stores/connectionStatus'
import type { ActiveAppContext } from '../types/appContext'
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
let sessionStarted = false
let audioDropWarned = false

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
        addRuntimeEvent('warn', 'websocket', '心跳超时：10s 未收到 pong，主动断开')
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
    sessionStarted = false
  })
}

function endSessionIfNeeded() {
  if (sessionStarted || hasActiveSession()) {
    sessionStarted = false
    endSession()
  }
  audioDropWarned = false
}

export function connect(cbs: WSCallbacks): Promise<void> {
  callbacks = cbs

  if (ws?.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }

  if (ws) {
    intentionalClose = true
    try {
      ws.close()
    } catch {
      // ignore
    }
    ws = null
  }

  return new Promise((resolve, reject) => {
    intentionalClose = false
    updateGlobalState('connecting')
    const wsUrl = getWSUrl()

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
        addRuntimeEvent('error', 'websocket', '连接超时（10s）', { url: wsUrl })
        reject(new Error('WebSocket connection timeout'))
      }
    }, 10000)

    socket.onopen = () => {
      clearTimeout(timeout)
      updateGlobalState('connected')
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      startHeartbeat()
      resolve()
    }

    socket.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      try {
        const msg = JSON.parse(e.data)
        addMsg('received', msg.type || 'unknown', msg)

        switch (msg.type) {
          case 'ready':
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
            callbacks.onFinal?.({
              asrText: msg.asr_text,
              llmText: msg.llm_text,
              asrMs: msg.asr_ms,
              llmMs: msg.llm_ms,
              durationSec: Number(msg.duration_sec || durationFromAsrDebug || 0),
              asrEngine: msg.asr_engine || undefined,
              asrModel: msg.asr_model || undefined,
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
        addRuntimeEvent('error', 'websocket', '消息解析失败', {
          error: String(err),
          raw: e.data,
        })
      }
    }

    socket.onerror = (ev) => {
      clearTimeout(timeout)
      updateGlobalState('error')
      addRuntimeEvent('error', 'websocket', '连接发生错误', {
        event: String(ev.type || 'error'),
      })
    }

    socket.onclose = (ev) => {
      clearTimeout(timeout)
      stopHeartbeat()
      ws = null
      updateGlobalState('disconnected')

      if (!intentionalClose) {
        addRuntimeEvent('warn', 'websocket', `连接关闭 code=${ev.code} reason=${ev.reason || '-'}`)
      }

      endSessionIfNeeded()

      if (!intentionalClose) {
        reconnectTimer = setTimeout(() => connect(callbacks), 3000)
      }
    }
  })
}

export function disconnect() {
  intentionalClose = true
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  try {
    ws?.close()
  } catch {
    // ignore
  }
  ws = null
  endSessionIfNeeded()
}

export function sendStart(opts?: {
  systemPrompt?: string
  disableAi?: boolean
  clientMeta?: ClientRuntimeInfo | null
  appContext?: ActiveAppContext | null
  source?: string
  hotwords?: string[]
  language?: string
}): boolean {
  if (ws?.readyState !== WebSocket.OPEN) {
    addRuntimeEvent('error', 'websocket', '发送 start 失败：连接未就绪')
    return false
  }

  const msg: Record<string, unknown> = { cmd: 'start', source: opts?.source || 'live' }
  if (opts?.systemPrompt) msg.system_prompt = opts.systemPrompt
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
  if (opts?.hotwords && opts.hotwords.length > 0) {
    msg.hotwords = opts.hotwords
  }
  if (opts?.language) {
    msg.language = opts.language
  }

  try {
    startSession(opts)
    addMsg('sent', 'start', msg)
    ws.send(JSON.stringify(msg))
    sessionStarted = true
    audioDropWarned = false
    return true
  } catch (err) {
    addRuntimeEvent('error', 'websocket', '发送 start 失败', { error: String(err) })
    endSessionIfNeeded()
    return false
  }
}

export function sendStop(opts?: { pttHoldMs?: number; audioStats?: AudioStats }): boolean {
  if (!sessionStarted) {
    return false
  }

  if (ws?.readyState !== WebSocket.OPEN) {
    addRuntimeEvent('error', 'websocket', '发送 stop 失败：连接未就绪')
    endSessionIfNeeded()
    return false
  }

  try {
    const payload: Record<string, unknown> = { cmd: 'stop' }
    if (typeof opts?.pttHoldMs === 'number' && Number.isFinite(opts.pttHoldMs)) {
      payload.usage_meta = { ptt_hold_ms: Math.max(0, Math.round(opts.pttHoldMs)) }
    }
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
    addRuntimeEvent('error', 'websocket', '发送 stop 失败', { error: String(err) })
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
      addRuntimeEvent('error', 'websocket', '发送音频失败', {
        error: String(err),
        bytes: buffer.byteLength,
      })
    }
    return
  }

  if (!audioDropWarned) {
    audioDropWarned = true
    addRuntimeEvent('warn', 'websocket', '音频已丢弃：连接断开', { bytes: buffer.byteLength })
  }
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN
}
