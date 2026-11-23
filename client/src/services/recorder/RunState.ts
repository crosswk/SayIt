import type { AiConfigSnapshot } from '../transcription/aiPolicy'
import type { ActiveAppContext } from '../../types/appContext'
import type { PromptResolution } from '../personalization/types'
import type { ProbeResult } from './PasteService'
import type { VoiceIntent } from '../voiceActions/settings'

/**
 * 一次录音的运行期数据，从 RecorderOrchestrator 的散字段收拢而来（模块 6 第二步）。
 *
 * 这一步只是把字段搬到一处：每个字段在编排器里什么时候复位，和原来逐字段写时一模一样。
 * 「插入中」「正在插入的文字」和迟到结果相关的字段**不在这里**：超时后的迟到结果会在
 * 空闲状态下插字，那时它们属于上一代，不能跟着新一次录音一起复位。
 */
export class RunState {
  recordStartPerf = 0
  audioSentSamples = 0
  /** Wall time captured at stopRecording — used for history durationSec so it
   *  matches what the user saw on the overlay (not inflated by backend latency). */
  wallTimeAtStopSec = 0
  finalHandledInCurrentRun = false
  /** Esc 仅在 processing 的可逆阶段允许取消；进入系统粘贴前永久关闭。 */
  processingCancelable = false
  /** PTT up arrived while startRecording was still initializing — stop immediately after setup */
  pendingStopWhileStarting = false
  finalReceivedAt = 0
  recordedChunks: ArrayBuffer[] = []
  captureReadyPromise: Promise<void> | null = null
  /**
   * 本次录音开始时冻结的 AI 配置与日志关联标识。
   *
   * 不直接用 cached* 那几个字段算策略：它们会被设置页的改动随时刷新，用户录完之后
   * 改一下门槛，这一条的原因就跟着变了 —— 事后没法解释历史记录。
   */
  currentAiConfig: AiConfigSnapshot | undefined
  /**
   * 这次录音要做什么：口述输入 / 语音翻译 / 随便问。开始录音时由触发它的快捷键决定，
   * 整次录音不变（录到一半改设置不影响这一次）。
   */
  intent: VoiceIntent = 'dictate'
  currentOperationId: string | undefined
  currentActiveAppContext: ActiveAppContext | null = null
  currentPromptResolution: PromptResolution | null = null
  /** Probe result captured at startRecording time (before audio capture begins).
   *  Used by handleTextInsertion so we inject into the window that was focused
   *  when the user started speaking, not whatever happens to be focused later. */
  cachedProbeResult: ProbeResult | null = null
}
