// 转写 Provider 抽象层类型定义
// 所有工作模式（服务器 / 云 API / 本地）共享此接口

import type { ActiveAppContext, TextContext } from '../../types/appContext'
import type { ClientRuntimeInfo } from '../../types/appApi'
import type { AiConfigSnapshot, AiPolicy } from './aiPolicy'
import type { ClientAiConfig } from './selectionAi'

export type WorkMode = 'server' | 'cloud_api' | 'local'

export type ProviderState = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * 一次录音进行中连接掉线的哨兵错误。
 *
 * 走 onError 的统一失败通道（这样音频存档/历史/提示都复用同一条路），但录音器要能把它
 * 单独归类成 connection_lost —— 这段语音是**从未送达**服务端，跟「服务端处理失败」
 * 不是一回事，用户看到的解释也不该相同。
 */
export const MID_SESSION_DISCONNECT_ERROR
  = 'sayit_error:server_unreachable:websocket disconnected mid-session'

export type AiExecutionSource = 'server' | 'custom' | 'none'
export type AiExecutionStatus = 'applied' | 'skipped' | 'unavailable' | 'failed'

export interface ASRResult {
  text: string
  asrMs: number
  durationSec: number
  /** 空 ASR 会先于 final 触发专用收尾，执行元数据必须随它一起落库。 */
  aiSource?: AiExecutionSource
  aiStatus?: AiExecutionStatus
}

export interface FinalResult {
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  asrEngine?: string
  asrModel?: string
  /** True only when the AI actually received and processed this run's editor context. */
  contextApplied?: boolean
  /** Explicit execution metadata; text equality cannot prove whether AI ran. */
  aiSource?: AiExecutionSource
  aiStatus?: AiExecutionStatus
  aiProvider?: string
  aiModel?: string
  /**
   * 跳过 / 失败的稳定原因码（AiReason）。
   *
   * 声明在这里是因为它**运行时已经**通过 `...polish` 流到录音器了（spread 不触发
   * TS 的多余属性检查，不声明只会让它成为一个看不见的隐式字段）。
   * 第 1a 批只保证日志有它，写进历史记录是第 2 批的事。
   */
  aiReason?: string
  /**
   * 服务端 AI 的执行证据，从 llm_debug 里**只取结论性字段**。
   *
   * 不透传整个 llm_debug：它在服务器开了 debug_llm 时会带完整 prompt 与原始输出，
   * 顺着结果对象传播出去早晚会被某处日志整条打出来。
   * 有它才能把「服务端跑了但很快」和「服务端压根没跑」分开 —— 光看 llm_ms=0 分不出来。
   */
  serverAi?: { error?: string; provider?: string }
}

export interface TranscriptionCallbacks {
  onStateChange?: (state: ProviderState) => void
  onReady?: (info: { connectionId?: string; asr: boolean; llm: boolean }) => void
  /** 流式识别过程中的中间结果（实时上屏用），text 为到目前为止的累计文本 */
  onPartialASR?: (text: string) => void
  onASR?: (result: ASRResult) => void
  onFinal?: (result: FinalResult) => void
  onDone?: () => void
  onError?: (msg: string) => void
}

export interface StartOptions {
  /** 当前录音代次；取消或开始下一次后，旧代次的异步结果必须全部丢弃。 */
  runId: number
  /** 本次处理的日志关联标识。历史重跑必须新建，不能复用被重跑那条记录的旧标识。 */
  operationId?: string
  /**
   * 本次冻结的 AI 相关配置。冻结的理由是事后解释：用户录完之后改了设置，
   * 这条记录的原因也不能跟着变。
   */
  aiConfig?: AiConfigSnapshot
  /** Frozen selection-edit credentials for this run only. Never serialize to logs or history. */
  selectionAiConfig?: ClientAiConfig | null
  systemPrompt?: string
  disableAi?: boolean
  /** 录音未达到该时长时只做识别，不调用 AI。0 / undefined = 不设门槛。 */
  aiMinDurationSec?: number
  clientMeta?: ClientRuntimeInfo | null
  appContext?: ActiveAppContext | null
  /** Bounded editor text captured at recording start. Never persisted in history/logs. */
  textContext?: TextContext | null
  source?: 'live' | 'history_reprocess'
  hotwords?: string[]
  language?: string
  /** 是否开启流式实时显示：识别过程中把中间结果实时推给悬浮窗 */
  streamingDisplay?: boolean
  /**
   * 本机 AI 调用的超时。缺省用 clientAiPolish 的 8 秒 —— 那是给润色定的，润色超时就插原文，
   * 用户损失不大。语音翻译超时就等于整次白说，所以它给得更长。
   */
  aiTimeoutMs?: number
}

export interface StopOptions {
  pttHoldMs?: number
  /**
   * 松键时才知道的「这次别做 AI 整理」。录音时长要等录完才知道，而服务器模式的 AI
   * 在服务端紧跟 ASR 执行，start 时来不及决定。
   *
   * 这是 policy 压成的布尔，只给线上协议用。**压完的值不要再回头当跳过原因**
   * ——自配 AI 路线也会发 true（服务端不做、客户端做），把它解释成"整次跳过"是错的。
   */
  disableAi?: boolean
  /**
   * 本次的完整策略（含路由与原因）。松键时由录音器用实际 PCM 时长算出，
   * 随 stop 一起交给 Provider，保证「线上那个布尔」和「日志里记的原因」出自同一次判断。
   */
  aiPolicy?: AiPolicy
  audioStats?: {
    avgRms: number
    peakRms: number
    peakAmplitude: number
    silenceRatio: number
    totalFrames: number
  }
}

/**
 * 转写 Provider 接口。
 * RecorderOrchestrator 通过此接口与具体的转写实现交互，
 * 不再直接依赖 WebSocket 或任何特定的后端协议。
 */
export interface TranscriptionProvider {
  readonly mode: WorkMode

  /** 建立连接 / 初始化 */
  connect(callbacks: TranscriptionCallbacks): Promise<void>

  /** 开始一次转写会话 */
  start(opts: StartOptions): boolean

  /** 立即取消当前会话；允许底层任务自然结束，但之后不得再上抛任何结果。 */
  cancel(): void

  /** 发送音频数据（流式，PCM Int16 ArrayBuffer） */
  sendAudio(buffer: ArrayBuffer): void

  /** 结束录音，触发处理 */
  stop(opts?: StopOptions): boolean

  /** 断开连接 / 释放资源 */
  disconnect(): void

  /** 是否已就绪可以开始转写 */
  isReady(): boolean
}
