import * as bridge from '../bridge'
import { startCapture, stopCapture } from '../audio'
import { getProvider, MID_SESSION_DISCONNECT_ERROR, type TranscriptionProvider, type TranscriptionCallbacks, type FinalResult } from '../transcription'
import { resolveAiPolicy, serverShouldPolish, type AiConfigSnapshot } from '../transcription/aiPolicy'
import { getRuntimeServerAiSource } from '../transcription/serverAiSource'
import { loadSelectionAiConfig } from '../transcription/selectionAi'
import { isStreamingDisplayReady } from '@/lib/asrModels'
import {
  getActivePresetId,
  getPromptPresets,
  getSetting,
  setActivePresetId,
  type HistoryFailReasonCode,
  type HistoryRecord,
  type PromptPreset,
} from '../store'
import { setActivePresetKnown } from '../../stores/activePreset'
import { addRuntimeEvent } from '../debugLog'
import {
  BUILTIN_SET_ACTIVE_KEY,
  BUILTIN_SET_EXTRA_WORDS_KEY,
  BUILTIN_SET_WORDS_KEY,
  CUSTOM_THEME_ACTIVE_KEY,
  CUSTOM_THEMES_KEY,
  composeHotwords,
  normalizeBuiltinSetActive,
  normalizeBuiltinSetWords,
  normalizeCustomThemeActive,
  normalizeCustomThemes,
} from '../hotwords/model'
import { createWaveformBarState, computeBarsFromPCM, resetWaveformBarState } from '../waveform'
import { elapsedSecFromPerf } from '../timeModel'
import {
  captureActiveInsertionTarget,
  clearCapturedInsertionTarget,
  startInsertionTargetTracking,
  stopInsertionTargetTracking,
} from '../textInsertion'
import { applyTextTransforms } from '../textPostProcess'
import type { ActiveAppContext } from '../../types/appContext'
import type { ClientRuntimeInfo } from '../../types/appApi'
import { OverlayService, type FailureRecovery } from './OverlayService'
import { PasteService, type ProbeResult } from './PasteService'
import { AudioArchiveService } from './AudioArchiveService'
import { MicLevelMonitor } from './MicLevelMonitor'
import { HistoryWriter, type HistoryMetadata } from './HistoryWriter'
import { RunState } from './RunState'
import { InsertionController } from './InsertionController'
import { defaultRecordingSettings, type RecordingSettings } from './RecordingSettings'
import { createDefaultUserStats } from '../personalization/defaults'
import { resolvePromptRouting } from '../personalization/promptRouter'
import {
  getAppPromptRules,
  getUserStats,
  recordSessionStats,
} from '../personalization/store'
import type { PromptResolution, UserStats } from '../personalization/types'
import type { PTTEventPayload, RecorderState } from './types'
import { MAX_RECORDING_SEC, RECORDING_COUNTDOWN_SEC } from './types'
import {
  summarizeAppContext as _summarizeAppContext,
  buildStatsAppId as _buildStatsAppId,
  isModifierPTTSetting as _isModifierPTTSetting,
  computeProcessingTimeoutMs as _computeProcessingTimeoutMs,
} from './helpers'
import { t } from '@/i18n'
import { describeProviderError } from '@/lib/errorMessages'
import { describeMicSource, micSourceChanged } from './micSourceReminder'
import {
  CONTEXT_SELECTION_EDIT_PROMPT,
  CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY,
  normalizeContextSelectionEditPrompt,
  resolveContextAwareOutput,
  usableTextContext,
  withContextAwareInstructions,
} from '../contextAware'

type StateTransition =
  | ['idle', 'recording']
  | ['recording', 'processing']
  | ['recording', 'idle']
  | ['processing', 'idle']

const VALID_TRANSITIONS: StateTransition[] = [
  ['idle', 'recording'],
  ['recording', 'processing'],
  ['recording', 'idle'],
  ['processing', 'idle'],
]

const LATE_FINAL_GRACE_MS = 15000
/** 文本插入还没收尾时，超时定时器每次顺延多久。 */
const INSERTION_TIMEOUT_EXTENSION_MS = 5000
/**
 * 插入阶段专属超时。见 armInsertionTimeout 的注释 —— 处理超时在 onFinal 里就被清掉了，
 * 管不到插入这一段，所以这一段必须自带一个。
 */
const INSERTION_TIMEOUT_MS = 15000
/** 顺延次数上限；用尽就强制把界面从「处理中」放出来。 */
const MAX_INSERTION_TIMEOUT_EXTENSIONS = 3
const MODIFIER_PTT_RELEASE_GUARD_MS = 200

function classifyHistoryProviderFailure(message: string): HistoryFailReasonCode {
  // 录音中掉线要单列：这段语音从未送达服务端，跟「服务端处理失败」的排查方向完全不同。
  if (message === MID_SESSION_DISCONNECT_ERROR) return 'connection_lost'
  const code = describeProviderError(message).code
  switch (code) {
    case 'provider_timeout':
    case 'provider_unreachable':
    case 'provider_bad_key':
    case 'provider_forbidden':
    case 'provider_rate_limit':
    case 'provider_no_model':
      return code
    default:
      return 'provider_failed'
  }
}

interface TimedOutProcessingContext {
  runId: number
  timedOutAt: number
  /**
   * 这一代是否已经收尾（迟到 final 已被消费并落库）。
   *
   * 宽限期兜底定时器**只认这个标志**，不再看 `timedOutProcessingContext` 还指着自己：
   * 新一次录音会在 startRecording 里把那个字段清空，于是兜底定时器直接 return，
   * 上一段录音的音频与历史一起消失（实测丢过 60 秒录音）。用户又按了一次热键，
   * 不等于他放弃了上一段。
   */
  settled: boolean
  audioDurationSec: number
  wallTimeSec: number
  promptResolution: PromptResolution | null
  appContext: ActiveAppContext | null
  audioChunks: ArrayBuffer[]
  probeResult: ProbeResult | null
}

interface ResetToIdleOptions {
  keepOverlay?: boolean
  preserveLateFinalContext?: boolean
}



export class RecorderOrchestrator {
  private state: RecorderState = 'idle'
  /** 本次录音的运行期数据（模块 6）。字段的复位时机与原来逐字段写时完全一致。 */
  private readonly run = new RunState()
  private onStateChange: ((s: RecorderState) => void) | null = null
  private initialized = false
  private runSequence = 0
  private activeRunId = 0

  private textInsertionInFlight = false
  /**
   * 正在插入的那段文本。
   *
   * 只为一件事存在：插入收尾卡死、顺延用尽时，把文字交还给用户（展示结果卡）。
   * 那条路上文本已经识别出来了，历史也已落库，唯独没人知道它到底进没进输入框 ——
   * 以前那里直接 resetToIdle()，界面凭空恢复空闲，用户什么也没拿到。
   */
  private textBeingInserted = ''
  /**
   * 用户已明确放弃等待迟到结果（宽限期内按了 Esc，或关掉了失败卡）。
   *
   * 置位后迟到的 final 只许落历史，**绝不自动插字**：界面已经告诉他"失败了"，
   * 再往输入框里塞字是最让人措手不及的行为。
   */
  private lateResultAbandoned = false
  /**
   * 正在"超时后等迟到结果"的那一代。
   *
   * 不能拿 `timedOutProcessingContext` 当这个判据：迟到 final 一到达就会被
   * `consumeTimedOutProcessingContext()` 清成 null，而此后还要异步落历史、再插字。
   * 那段时间里悬浮窗仍显示"仍在等结果"，用户按 Esc 却因为上下文没了被当成过期事件
   * 丢掉 —— 提示关不掉，文字随后照样插进去。这个字段活到**真正收尾**为止。
   */
  private lateResultRunId = 0
  /** 迟到 final 正在完成历史/插入；此期间禁止新录音复用 Provider。 */
  private finalizingLateRunId = 0
  /** 当前 fallback 卡片对应的 run token；用于拒绝队列中迟到的旧 dismiss。 */
  private activeFallbackToken = 0
  /** Guard against re-entrant startRecording calls during async setup */
  private startRecordingLock = false
  private processingTimeoutId: ReturnType<typeof setTimeout> | null = null
  /** 插入阶段专属超时；处理超时在 onFinal 里已被清掉，管不到这一段。 */
  private insertionTimeoutId: ReturnType<typeof setTimeout> | null = null
  private timedOutProcessingContext: TimedOutProcessingContext | null = null
  /** 各代录音的音频存档（停止录音就落盘，不等识别结果）。 */
  private audioArchive = new AudioArchiveService((runId) => this.overlayService.updateFailureRecovery('history', runId))
  /** 历史记录的写入、取消后的清理，以及「哪些代被用户主动取消」。 */
  private readonly history = new HistoryWriter(this.audioArchive)

  private handsFreeMode = false
  private pttSuppressed = false
  private lastToggleTime = 0
  private lastPTTUpAt = 0
  private lastPTTUpUsedModifier = false

  /** 录音要用的设置（麦克风、AI 整理、热词……），见 RecordingSettings。 */
  private settings: RecordingSettings = defaultRecordingSettings()
  /** Last successfully opened input route in this app process. Kept in memory on purpose. */
  private lastMicSourceIdentity: string | null = null
  /** 标记本次录音是否已施加系统静音，用于配对恢复。 */
  private systemMuteApplied = false
  /** 延迟静音定时器（等提示音播完再静音）。 */
  private systemMuteTimerId: ReturnType<typeof setTimeout> | null = null
  private clientRuntimeInfo: ClientRuntimeInfo | null = null
  /** 客户端运行时信息是否已成功采集一次。它是进程内静态元数据（区域/内存/主机名等），
   *  只需启动时取一次，不该挂在每次改设置都触发的刷新热路径上。失败时保持 false 以便重试。 */
  private clientRuntimeInfoLoaded = false
  private userStats: UserStats = createDefaultUserStats()

  private readonly overlayWaveState = createWaveformBarState()
  private readonly overlayService = new OverlayService(() => this.getLiveElapsedSec())
  /** 音量两档提醒、系统静音判定、本次录音的音频统计。 */
  private readonly micLevel = new MicLevelMonitor({
    overlay: this.overlayService,
    isRunCurrent: (runId) => this.isRunCurrent(runId),
    getState: () => this.state,
    isStarting: () => this.startRecordingLock,
    getActiveRunId: () => this.activeRunId,
    getSelectedMicId: () => this.settings.micId,
    cancelForMutedMic: (runId) => { void this.cancelRecording(runId, { showCanceled: false, reason: 'mic_muted_timeout' }) },
  })
  /** 拿目标窗口、判断能不能写、粘贴、给结果分类。状态怎么变仍由编排器决定。 */
  private readonly insertion = new InsertionController(new PasteService())
  private get provider(): TranscriptionProvider { return getProvider() }
  /** 5-minute auto-stop timer for hands-free mode */
  private handsFreeAutoStopId: ReturnType<typeof setTimeout> | null = null

  setStateListener(cb: (s: RecorderState) => void) {
    this.onStateChange = cb
  }

  getState() {
    return this.state
  }

  private isRunCurrent(runId: number) {
    return runId !== 0 && this.activeRunId === runId
  }




  /**
   * 一次失败的统一收尾：**立刻**显示失败卡，随后按实际存档结果把恢复提示补上。
   *
   * 收口成一处的理由：失败有五条路（stop 没送出去、录音中报错、处理中报错、处理超时、
   * 有录音却没结果），以前每条各自决定要不要提示、显示几秒、要不要留悬浮窗 —— 结果
   * 其中两条完全静默，悬浮窗凭空消失，用户报的正是这个。再加一条失败路径时，只要
   * 走这里就不会重犯。
   *
   * 两段式是刻意的：提示必须在失败那一刻出现（用户正盯着屏幕等结果），而存档结论是
   * 异步的、最长能等 30 秒。先说"失败了"，再补"录音留下了"。
   */
  private async failRunWithCard(runId: number, params: {
    title: string
    detail?: string
    audioDurationSec: number
    wallTimeSec: number
    failReason: string
    failReasonCode: HistoryFailReasonCode
    historyMeta: HistoryMetadata
    asrMs?: number
    asrDurationSec?: number
    aiSource?: HistoryRecord['aiSource']
    aiStatus?: HistoryRecord['aiStatus']
  }): Promise<void> {
    const showCard = this.isRunCurrent(runId)
    if (showCard) {
      // 必须先认领 token，再显示卡片：Esc 的 dismiss_fallback 分支拿 activeFallbackToken
      // 比对，不设的话按 Esc 会被当成"迟到的旧关闭请求"丢掉，卡片关不掉。
      // （这个字段只在 startRecording 里清零，所以下面的 resetToIdle 不会把它弄丢。）
      this.activeFallbackToken = runId
      this.overlayService.showFailure({
        title: params.title,
        detail: params.detail,
        recovery: 'unknown',
        token: runId,
      })
    }

    const recovery = await this.history.writeFailedRun({
      runId,
      audioDurationSec: params.audioDurationSec,
      wallTimeSec: params.wallTimeSec,
      asrMs: params.asrMs,
      asrDurationSec: params.asrDurationSec,
      failReason: params.failReason,
      failReasonCode: params.failReasonCode,
      historyMeta: params.historyMeta,
      aiSource: params.aiSource,
      aiStatus: params.aiStatus,
    })
    if (showCard) this.overlayService.updateFailureRecovery(recovery, runId)
  }

  /**
   * 已经确定不会有结果了：存历史 + 给出可读提示 + 立刻回 idle。
   *
   * 用于「请求根本没送出去」这类当场就能判定的失败。关键是**不进等待** —— 让悬浮条转满
   * 一分钟再什么都不说，是最糟的处理方式，用户既不知道发生了什么，也不知道录音还在不在。
   */
  private async failRunWithoutResult(runId: number, params: {
    audioDurationSec: number
    wallTimeSec: number
    failReason: string
    failReasonCode: HistoryFailReasonCode
    title: string
    detail?: string
  }): Promise<void> {
    this.clearProcessingTimeout()
    this.run.processingCancelable = false
    const historyMeta = this.buildHistoryMetadata(
      this.run.currentPromptResolution,
      this.run.currentActiveAppContext,
    )
    addRuntimeEvent('warn', 'recorder', 'Run failed without any result', {
      runId,
      audioSec: params.audioDurationSec,
      failReasonCode: params.failReasonCode,
      mode: this.provider.mode,
    })
    this.provider.cancel()
    if (this.provider.mode === 'server') this.ensureConnection()
    await this.failRunWithCard(runId, {
      title: params.title,
      detail: params.detail,
      audioDurationSec: params.audioDurationSec,
      wallTimeSec: params.wallTimeSec,
      failReason: params.failReason,
      failReasonCode: params.failReasonCode,
      historyMeta,
    })
    if (!this.isRunCurrent(runId)) return
    this.finishRun(runId)
    this.resetToIdle({ keepOverlay: true })
  }

  /** 幂等结束指定代次；所有清理都带 runId 条件，绝不清除随后创建的新代次。 */
  private finishRun(runId: number) {
    if (runId === 0) return
    this.history.clearPendingFor(runId)
    if (this.timedOutProcessingContext?.runId === runId) {
      this.timedOutProcessingContext = null
    }
    if (this.activeRunId === runId) {
      this.activeRunId = 0
      this.run.processingCancelable = false
    }
  }

  /** 若已开启「录音时静音系统声音」，在就绪提示音播放之后再静音系统输出。
   *  延迟略长于提示音时长（~150ms），避免把提示音也一起静掉。 */
  private scheduleSystemMuteIfEnabled() {
    if (!this.settings.muteSystemAudio) return
    this.clearSystemMuteTimer()
    this.systemMuteTimerId = setTimeout(() => {
      this.systemMuteTimerId = null
      // 若此时已不在录音（短按等），不再静音，避免残留
      if (this.state !== 'recording') return
      this.applySystemMute()
    }, 250)
  }

  private applySystemMute() {
    if (this.systemMuteApplied) return
    this.systemMuteApplied = true
    void bridge.muteSystemOutput().catch((e) => {
      this.systemMuteApplied = false
      addRuntimeEvent('warn', 'recorder', 'Failed to mute system audio', { error: String(e) })
    })
  }

  private clearSystemMuteTimer() {
    if (this.systemMuteTimerId) {
      clearTimeout(this.systemMuteTimerId)
      this.systemMuteTimerId = null
    }
  }

  /** 恢复系统输出到静音前的状态，并清除挂起的静音定时器。 */
  private restoreSystemMuteIfNeeded() {
    this.clearSystemMuteTimer()
    if (!this.systemMuteApplied) return
    this.systemMuteApplied = false
    void bridge.restoreSystemOutput().catch((e) => {
      addRuntimeEvent('warn', 'recorder', 'Failed to restore system audio', { error: String(e) })
    })
  }

  /** 未就绪时的简短提示文案（按当前工作模式区分）。 */
  private notReadyMessage(): string {
    switch (this.provider.mode) {
      case 'server':
        return t('recorder.serverDisconnected')
      case 'local':
        return t('recorder.modelNotDownloaded')
      default:
        return t('recorder.serviceNotReady')
    }
  }

  /** 通过快捷键切换当前润色模式，并在空闲时用悬浮窗提示。 */
  private async handlePresetSwitch(presetId: string) {
    try {
      // 优先用已缓存的预设列表，避免 IPC 等待导致的延时
      let target = this.settings.presets.find((p) => p.id === presetId)
      if (!target) {
        const presets = await getPromptPresets()
        target = presets.find((p) => p.id === presetId)
        this.settings.presets = presets
      }
      if (!target) {
        addRuntimeEvent('warn', 'recorder', 'Failed to switch cleanup preset: preset not found', { presetId })
        return
      }
      // 立即生效：更新录音器缓存 + 通知 UI + 悬浮窗提示（均无需等待 IPC）
      this.settings.activePresetId = presetId
      setActivePresetKnown(presetId, target.name)
      if (this.state === 'idle') {
        this.overlayService.showPresetSwitched(target.name)
      }
      addRuntimeEvent('info', 'recorder', 'Cleanup preset switched by shortcut', { presetId, name: target.name })
      // 持久化放到后台，不阻塞 UI 反馈
      void setActivePresetId(presetId)
    } catch (error) {
      addRuntimeEvent('error', 'recorder', 'Cleanup preset switch failed', { error: String(error) })
    }
  }

  /** 临时禁用/启用 PTT（用于欢迎向导热键确认步骤） */
  setPttSuppressed(suppressed: boolean) {
    this.pttSuppressed = suppressed
  }

  async init() {
    if (this.initialized) return
    this.initialized = true

    startInsertionTargetTracking()
    await this.refreshRuntimeSettings()
    // 静态机器信息只在启动采集一次；不 await，避免拖慢建连（clientMeta 可空，采集期间为 null 无碍）。
    void this.ensureClientRuntimeInfo()
    this.ensureConnection()

    // 快捷键切换润色模式（由 Rust global_shortcut 触发）
    void bridge.listen('switch-preset', (event: unknown) => {
      const payload = (event as { payload?: { presetId?: string } })?.payload
      const presetId = payload?.presetId
      if (presetId) void this.handlePresetSwitch(presetId)
    })

    bridge.onEscapeAction(({ mode, token }) => {
      if (mode === 'cancel_recording') {
        // Esc 可能在录音 stop 已发起、事件尚在 dispatcher 队列时到达；若此时已进入
        // 可逆 processing，沿用同一 run token 取消，避免用户明明按了却被竞态吞掉。
        if (this.state === 'processing' && this.run.processingCancelable) {
          this.cancelProcessing(token)
        } else {
          void this.cancelRecording(token)
        }
        return
      }
      if (mode === 'cancel_processing') {
        this.cancelProcessing(token)
        return
      }
      if (mode === 'dismiss_fallback') {
        if (token === 0 || token !== this.activeFallbackToken) {
          addRuntimeEvent('info', 'recorder', 'Ignored stale Esc fallback dismissal', {
            token,
            activeFallbackToken: this.activeFallbackToken,
          })
          return
        }
        addRuntimeEvent('info', 'recorder', 'Card dismissed with Esc', { token })
        this.activeFallbackToken = 0
        // 关掉失败卡也算"我不等了"：之后迟到的结果只许落历史，不许再插字。
        if (token === this.lateResultRunId) {
          this.lateResultAbandoned = true
        }
        this.overlayService.hide()
        return
      }
      if (mode === 'abandon_late_result') {
        // 处理已超时、正在宽限期里等迟到结果时按了 Esc。
        //
        // 只收起提示是不够的 —— 关键是让随后到达的 final **不再自动插字**。否则界面
        // 上刚说完"不等了"，几秒后文字还是会自己出现在输入框里，那是最让人措手不及的
        // 一种行为。音频和历史照常保留，用户仍可以去历史里重新识别。
        // 判据是 lateResultRunId 而不是 timedOutProcessingContext：后者在迟到 final
        // 到达那一刻就被消费掉了，而落历史 + 插字还要花时间，这段时间里用户的 Esc
        // 会被当成过期事件丢掉（提示关不掉、文字照样插进去）。
        if (token === 0 || token !== this.lateResultRunId) {
          addRuntimeEvent('info', 'recorder', 'Ignored stale Esc for late-result abandonment', {
            token,
            lateResultRunId: this.lateResultRunId,
          })
          return
        }
        addRuntimeEvent('info', 'recorder', 'User abandoned waiting for the late result', { token })
        this.lateResultAbandoned = true
        this.overlayService.hide()
      }
    })

    // 悬浮窗自己收起了卡片（点关闭按钮、或复制完成后自动收起）。必须在这里收尾，
    // 否则 OverlayService 的续期定时器会在 8 秒后把按键接管重新注册一遍。
    bridge.onCardDismissed(({ reason, token }) => {
      addRuntimeEvent('info', 'recorder', 'Overlay reported a dismissed card', { reason, token })
      this.overlayService.noteCardDismissed(token)
      if (token !== 0 && token === this.activeFallbackToken) {
        this.activeFallbackToken = 0
      }
      // 关掉提示也算"我不等了"：随后到达的迟到结果只许落历史，不许再插字。
      if (token !== 0 && token === this.lateResultRunId) {
        this.lateResultAbandoned = true
      }
    })

    bridge.onPTTDown((payload) => {
      this.notePTTDown(payload)
      this.logPTTEvent('down', payload)
      if (this.pttSuppressed || this.handsFreeMode) {
        addRuntimeEvent('info', 'ptt', 'event:down ignored', {
          ...this.getPTTEventContext(payload),
          ignoreReason: this.pttSuppressed ? 'ptt_suppressed' : 'hands_free_mode',
        })
        return
      }
      if (this.state === 'idle') {
        addRuntimeEvent('info', 'ptt', 'event:down accepted -> startRecording', this.getPTTEventContext(payload))
        void this.startRecording()
        return
      }
      addRuntimeEvent('info', 'ptt', 'event:down ignored', {
        ...this.getPTTEventContext(payload),
        ignoreReason: 'state_not_idle',
      })
    })

    bridge.onPTTUp((payload) => {
      this.notePTTUp(payload)
      this.logPTTEvent('up', payload)
      if (this.pttSuppressed || this.handsFreeMode) {
        addRuntimeEvent('info', 'ptt', 'event:up ignored', {
          ...this.getPTTEventContext(payload),
          ignoreReason: this.pttSuppressed ? 'ptt_suppressed' : 'hands_free_mode',
        })
        return
      }
      if (this.state === 'recording') {
        addRuntimeEvent('info', 'ptt', 'event:up accepted -> stopRecording', this.getPTTEventContext(payload))
        void this.stopRecording()
        return
      }
      // PTT up arrived while startRecording is still initializing (state is still 'idle')
      if (this.startRecordingLock) {
        addRuntimeEvent('info', 'ptt', 'event:up deferred — startRecording in progress', this.getPTTEventContext(payload))
        this.run.pendingStopWhileStarting = true
        return
      }
      addRuntimeEvent('info', 'ptt', 'event:up ignored', {
        ...this.getPTTEventContext(payload),
        ignoreReason: 'state_not_recording',
      })
    })

    bridge.onPTTToggle((payload) => {
      this.logPTTEvent('toggle', payload)
      if (this.pttSuppressed || this.handsFreeMode) {
        addRuntimeEvent('info', 'ptt', 'event:toggle ignored', {
          ...this.getPTTEventContext(payload),
          ignoreReason: this.pttSuppressed ? 'ptt_suppressed' : 'hands_free_mode',
        })
        return
      }
      addRuntimeEvent('info', 'ptt', 'event:toggle accepted', this.getPTTEventContext(payload))
      this.pttToggle(false)
    })

    bridge.onToggleHandsFree((payload) => {
      this.logPTTEvent('hands_free', payload)
      if (this.pttSuppressed) {
        addRuntimeEvent('info', 'ptt', 'event:hands_free ignored', {
          ...this.getPTTEventContext(payload),
          ignoreReason: 'ptt_suppressed',
        })
        return
      }
      addRuntimeEvent('info', 'ptt', 'event:hands_free accepted', this.getPTTEventContext(payload))
      this.pttToggle(true)
    })

    // 9-minute warning from Rust keyboard hook (PTT hold mode)
    bridge.onPTTTimeoutWarning(() => {
      if (this.state === 'recording') {
        addRuntimeEvent('warn', 'recorder', 'Recording is approaching the five-minute limit')
        this.overlayService.showTimeoutWarning()
      }
    })
  }

  cleanup() {
    this.clearProcessingTimeout()
    this.micLevel.clearAutoCancelTimer()
    this.micLevel.invalidateProbes()
    this.overlayService.dispose()
    stopInsertionTargetTracking()
    void stopCapture().catch(() => { })
    this.provider.disconnect()
  }

  /** 仅更新 AI 整理开关的缓存值，无 IPC/热词/语言等全量刷新。
   *  供标题栏/设置页的开关按钮使用，避免快速切换时卡顿。 */
  setAiEnabledCache(next: boolean) {
    this.settings.aiEnabled = next
  }

  showAiEnabledToast(enabled: boolean) {
    if (this.state === 'idle') this.overlayService.showAiCleanupToggled(enabled)
  }

  /** 仅更新当前润色模式（preset）的缓存值，无 IPC/热词/语言等全量刷新。
   *  供设置页点击切换润色模式使用，避免快速切换时卡顿。 */
  setActivePresetCache(id: string) {
    this.settings.activePresetId = id
  }

  /** 新建、编辑或删除预设后同步最新列表，避免 active id 指向尚未进入运行时缓存的新预设。 */
  setPromptPresetsCache(presets: PromptPreset[]) {
    this.settings.presets = presets.map((preset) => ({ ...preset }))
  }

  /** 热词变更后同步下一次录音使用的快照；当前录音仍使用开始时已捕获的 StartOptions。 */
  setHotwordsCache(words: string[]) {
    this.settings.hotwords = Array.from(new Set(words.map((word) => word.trim()).filter(Boolean)))
  }

  /** 仅更新「流式实时显示」开关缓存，供外观设置切换后立即生效。 */
  setStreamingDisplayCache(next: boolean) {
    this.settings.streamingDisplay = next
  }

  /** 录音开始时实时判定是否激活流式字幕气泡（读最新的开关/供应商/WorkspaceId，避免缓存过期）。
   *  判据统一交给 isStreamingDisplayReady：doubao_v2 与 qwen_audio_stream 直接可用，
   *  qwen_realtime 还要配 WorkspaceId；qwen3-asr-flash 等非流式模型不激活。 */
  private async applyStreamingActive(): Promise<void> {
    try {
      const [streamOn, provider, workspaceId] = await Promise.all([
        getSetting('streamingDisplayEnabled', false),
        getSetting('cloudAsr.provider', 'doubao_v2'),
        getSetting('cloudAsr.qwen.workspaceId', ''),
      ])
      if (this.state !== 'recording') return
      const active = Boolean(streamOn)
        && this.provider.mode === 'cloud_api'
        && isStreamingDisplayReady(String(provider || ''), String(workspaceId || ''))
      this.overlayService.setStreamingActive(active)
    } catch {
      /* ignore — 气泡占位是锦上添花，读取失败不影响录音 */
    }
  }

  async refreshRuntimeSettings() {
    const [
      micId,
      muteSystemAudio,
      protectClipboard,
      presets,
      activePresetId,
      aiEnabled,
      aiMinDurationSec,
      contextAwareWriting,
      contextSelectionEditPrompt,
      appPromptRules,
      userStats,
      streamingDisplay,
      injectHotwords,
      noiseSuppression,
    ] = await Promise.all([
      getSetting('selectedMic', ''),
      getSetting('muteSystemAudioWhileRecording', false),
      getSetting('protectClipboard', true),
      getPromptPresets(),
      getActivePresetId(),
      getSetting('aiEnabled', false),
      getSetting('aiMinDurationSec', 0),
      getSetting('contextAwareWritingEnabled', false),
      getSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, CONTEXT_SELECTION_EDIT_PROMPT),
      getAppPromptRules(),
      getUserStats(),
      getSetting('streamingDisplayEnabled', false),
      getSetting('injectHotwordsToPrompt', false),
      getSetting('micNoiseSuppression', true),
    ])

    this.settings = {
      ...this.settings,
      noiseSuppression: Boolean(noiseSuppression),
      micId: String(micId || ''),
      muteSystemAudio: Boolean(muteSystemAudio),
      protectClipboard: Boolean(protectClipboard),
      injectHotwords: Boolean(injectHotwords),
      presets,
      activePresetId,
      aiEnabled: Boolean(aiEnabled),
      aiMinDurationSec: Math.max(0, Math.min(MAX_RECORDING_SEC, Number(aiMinDurationSec) || 0)),
      contextAwareWriting: Boolean(contextAwareWriting),
      contextSelectionEditPrompt: normalizeContextSelectionEditPrompt(contextSelectionEditPrompt),
      appPromptRules,
      streamingDisplay: Boolean(streamingDisplay),
    }
    this.userStats = userStats
    await this.overlayService.refreshSettings()

    // 热词 / 服务器语言彼此独立，并行加载而非依次 await，减少本函数的总耗时
    // （每次切换 AI 整理开关等都会触发这里）。
    // 客户端运行时信息（区域/内存/主机名等）是进程内静态元数据，已移出此热路径，
    // 仅在启动时经 ensureClientRuntimeInfo() 采集一次，避免改任意设置都重新采集。
    const [hotwordsResult, languageResult] = await Promise.allSettled([
      Promise.all([
        getSetting(BUILTIN_SET_WORDS_KEY, {}),
        getSetting(BUILTIN_SET_ACTIVE_KEY, {}),
        getSetting(CUSTOM_THEMES_KEY, []),
        getSetting(CUSTOM_THEME_ACTIVE_KEY, {}),
        getSetting(BUILTIN_SET_EXTRA_WORDS_KEY, {}),
      ]).then(([rawSetWords, rawSetActive, rawCustomThemes, rawCustomThemeActive, rawSetExtraWords]) => {
        const setWords = normalizeBuiltinSetWords(rawSetWords, rawSetExtraWords)
        const setActive = normalizeBuiltinSetActive(rawSetActive as Record<string, unknown>)
        const themes = normalizeCustomThemes(rawCustomThemes)
        const themeActive = normalizeCustomThemeActive(rawCustomThemeActive as Record<string, unknown>, themes)
        return composeHotwords([], setWords, setActive, themes, themeActive)
      }),
      getSetting('server.language', 'auto').then((lang) => {
        const l = lang as string
        return l && l !== 'auto' ? l : ''
      }),
    ])

    this.settings = {
      ...this.settings,
      hotwords: hotwordsResult.status === 'fulfilled' ? hotwordsResult.value : [],
      language: languageResult.status === 'fulfilled' ? languageResult.value : '',
    }
  }

  /** 采集一次客户端运行时信息并缓存。静态元数据，进程内只成功采集一次；
   *  失败不置位 loaded，留待下次重试（避免把 unknown/0 永久缓存）。
   *  clientMeta 本就可空，采集期间为 null 不影响业务。 */
  async ensureClientRuntimeInfo() {
    if (this.clientRuntimeInfoLoaded) return
    try {
      this.clientRuntimeInfo = await bridge.getClientRuntimeInfo()
      this.clientRuntimeInfoLoaded = true
    } catch {
      this.clientRuntimeInfo = null
    }
  }

  /** 工作模式或服务地址变更后强制重连 provider。
   *  先断开旧连接再按新配置连接，确保连接状态与新地址一致（否则改错地址后仍显示"已连接"）。
   *  录音进行中不强制断开，避免打断当前会话。 */
  reconnectProvider() {
    if (this.state === 'idle') {
      this.provider.disconnect()
    }
    this.ensureConnection()
  }

  /** 仅刷新 overlay 显示设置（主题/长度/时长），不触碰录音相关缓存。
   *  用于外观设置页面，避免改个颜色就触发十几个 IPC 调用。 */
  async refreshOverlaySettings() {
    await this.overlayService.refreshSettings()
  }

  // ── State machine ──

  private transition(to: RecorderState): boolean {
    const pair = [this.state, to] as [RecorderState, RecorderState]
    const valid = VALID_TRANSITIONS.some(([f, t]) => f === pair[0] && t === pair[1])
    if (!valid) {
      addRuntimeEvent('warn', 'recorder', `Ignored invalid state transition ${this.state} → ${to}`)
      return false
    }
    addRuntimeEvent('info', 'recorder', 'State changed', { from: this.state, to })
    this.state = to
    this.onStateChange?.(to)
    return true
  }

  private clearProcessingTimeout() {
    if (this.processingTimeoutId) {
      clearTimeout(this.processingTimeoutId)
      this.processingTimeoutId = null
    }
  }

  private clearInsertionTimeout() {
    if (this.insertionTimeoutId) {
      clearTimeout(this.insertionTimeoutId)
      this.insertionTimeoutId = null
    }
  }

  /**
   * 插入阶段必须有自己的超时。
   *
   * 为什么不能靠处理超时那一个：`onFinal` 收到结果时第一件事就是
   * `clearProcessingTimeout()`，而插入发生在那之后。定时器已经没了，
   * `onProcessingTimeout` 里那条"插入还在飞"的分支于是永远不会被触发 —— 粘贴真卡住
   * 的时候（Rust SendInput 停在目标进程上）没有任何人来收尾，界面停在「处理中」。
   *
   * 时长取 15 秒：Rust 侧最坏是两次 SendMessageTimeoutW（各 2s）加上几次 sleep，
   * 正常路径在几百毫秒内结束。到 15 秒还没回来就是真卡死了。
   */
  private armInsertionTimeout(runId: number, text: string) {
    this.clearInsertionTimeout()
    this.insertionTimeoutId = setTimeout(() => {
      this.insertionTimeoutId = null
      this.handleInsertionStuck(runId, text, INSERTION_TIMEOUT_MS)
    }, INSERTION_TIMEOUT_MS)
  }

  /**
   * 插入卡死的唯一收尾实现：把文字交还给用户，而不是让界面凭空恢复空闲。
   *
   * 两个定时器都可能走到这里（插入专属超时、以及处理超时那条兜底），所以必须幂等 ——
   * `textInsertionInFlight` 就是那把锁。
   *
   * 文案刻意是「无法确认是否已写入」而不是「插入失败」：SendInput 是发出即忘，卡在
   * 这里时目标程序**可能已经收到**那段文字（pitfalls 28：UIPI 拦截是静默的，成功与
   * 失败在这一侧长得一样）。说"失败了"会让用户再粘一遍、多出一份重复。
   */
  private handleInsertionStuck(runId: number, text: string, waitedMs: number) {
    if (!this.textInsertionInFlight) return
    if (!this.isRunCurrent(runId)) return
    addRuntimeEvent('error', 'recorder', 'Text insertion never finished; handing the text back to the user', {
      runId,
      waitedMs,
      textLen: text.length,
    })
    this.textInsertionInFlight = false
    this.clearInsertionTimeout()
    this.clearProcessingTimeout()
    if (text.trim()) {
      this.showFallbackAndReset(text, 'insertion_timeout', runId)
      return
    }
    this.finishRun(runId)
    this.resetToIdle()
  }




  private getLiveElapsedSec() {
    if (this.state === 'recording' && this.run.recordStartPerf > 0) {
      return elapsedSecFromPerf(this.run.recordStartPerf)
    }
    return this.getAudioDurationSec()
  }

  private getAudioDurationSec() {
    return this.run.audioSentSamples > 0 ? this.run.audioSentSamples / 16000 : 0
  }

  private resetToIdle(options?: ResetToIdleOptions) {
    addRuntimeEvent('info', 'recorder', 'Reset to idle', {
      fromState: this.state,
      keepOverlay: Boolean(options?.keepOverlay),
      handsFreeMode: this.handsFreeMode,
      textInsertionInFlight: this.textInsertionInFlight,
    })
    this.clearProcessingTimeout()
    this.clearInsertionTimeout()
    this.micLevel.clearAutoCancelTimer()
    this.micLevel.invalidateProbes()
    if (this.handsFreeAutoStopId) {
      clearTimeout(this.handsFreeAutoStopId)
      this.handsFreeAutoStopId = null
    }
    this.overlayService.stopListeningTicker()
    this.overlayService.resetWarnings()
    this.overlayService.resetStreamingText()
    // 安全网：若仍处于我们施加的系统静音中，确保恢复
    this.restoreSystemMuteIfNeeded()
    this.startRecordingLock = false
    this.run.pendingStopWhileStarting = false
    this.handsFreeMode = false
    this.run.finalHandledInCurrentRun = false
    this.textInsertionInFlight = false
    this.run.processingCancelable = false
    this.run.captureReadyPromise = null
    this.run.finalReceivedAt = 0
    this.history.clearPending()
    this.run.currentActiveAppContext = null
    this.run.currentPromptResolution = null
    this.run.cachedProbeResult = null
    this.micLevel.resetOnIdle()
    clearCapturedInsertionTarget()
    this.run.recordStartPerf = 0
    if (!options?.preserveLateFinalContext) {
      this.timedOutProcessingContext = null
    }
    this.transition('idle')
    if (!options?.keepOverlay) {
      this.overlayService.clearFallbackHideTimer()
      this.overlayService.hide()
    }
  }


  private async cancelRecording(
    token: number,
    options: { showCanceled?: boolean; reason?: 'user' | 'mic_muted_timeout' } = {},
  ) {
    const showCanceled = options.showCanceled ?? true
    const reason = options.reason ?? 'user'
    if (
      this.state !== 'recording'
      || token === 0
      || token !== this.activeRunId
    ) {
      addRuntimeEvent('info', 'recorder', 'Ignored recording cancellation', {
        state: this.state,
        token,
        activeRunId: this.activeRunId,
        reason,
      })
      return
    }

    const canceledRunId = this.activeRunId
    // 在任何 await 之前离开 recording 并让 run 失效。这样同时到达的 PTT up 不会
    // 再进入正常 stopRecording，Provider 的迟到 partial/error 也会被 run guard 丢弃。
    if (!this.transition('processing')) return
    this.history.markRunCanceled(canceledRunId)
    this.run.finalHandledInCurrentRun = true
    this.run.processingCancelable = false
    this.overlayService.stopListeningTicker()
    this.restoreSystemMuteIfNeeded()
    this.run.recordedChunks = []
    this.finishRun(canceledRunId)
    this.provider.cancel()

    addRuntimeEvent('info', 'recorder', 'Recording canceled', {
      runId: canceledRunId,
      mode: this.provider.mode,
      reason,
    })
    if (showCanceled) this.overlayService.showCanceled()

    try {
      await stopCapture()
    } catch (error) {
      addRuntimeEvent('warn', 'recorder', 'Failed to stop capture while canceling', { error: String(error) })
    } finally {
      // state 在停止采集期间保持 processing，阻止新录音复用同一个 capture；确认旧
      // capture 已结束后再回 idle。keepOverlay 保留短暂的“已取消”反馈。
      if (this.getState() === 'processing' && this.activeRunId === 0) {
        this.resetToIdle({ keepOverlay: showCanceled })
      }
      if (this.provider.mode === 'server') this.ensureConnection()
    }
  }

  private cancelProcessing(token: number) {
    if (
      this.state !== 'processing'
      || token === 0
      || token !== this.activeRunId
      || !this.run.processingCancelable
    ) {
      addRuntimeEvent('info', 'recorder', 'Ignored Esc processing cancellation', {
        state: this.state,
        token,
        activeRunId: this.activeRunId,
        processingCancelable: this.run.processingCancelable,
      })
      return
    }

    const canceledRunId = this.activeRunId
    const historyArtifact = this.history.getPending()
    this.clearProcessingTimeout()
    // 用户明确按了 Esc：这一代的音频存档和历史都该消失。这是唯一允许丢弃录音的入口。
    this.history.markRunCanceled(canceledRunId)
    this.audioArchive.discard(canceledRunId)
    if (this.timedOutProcessingContext?.runId === canceledRunId) {
      this.timedOutProcessingContext.settled = true
    }
    this.timedOutProcessingContext = null
    this.run.processingCancelable = false
    this.provider.cancel()
    this.run.recordedChunks = []
    this.finishRun(canceledRunId)
    if (historyArtifact?.runId === canceledRunId) {
      void this.history.discard(historyArtifact)
    }

    // token 与当前 run 在同一同步检查内通过后才允许提示“已取消”；旧队列动作不会影响新代次。
    addRuntimeEvent('info', 'recorder', 'Processing canceled by user', {
      runId: canceledRunId,
      mode: this.provider.mode,
    })
    this.overlayService.showCanceled()
    this.resetToIdle({ keepOverlay: true })

    // ServerProvider.cancel 会主动断开旧 socket，隔离可能迟到的服务端结果。
    if (this.provider.mode === 'server') this.ensureConnection()
  }

  // ── Provider callbacks ──

  private buildProviderCallbacks(): TranscriptionCallbacks {
    return {
      onPartialASR: (text) => {
        // 仅在录音进行中把流式中间结果推给悬浮窗；下一次 listening 心跳会带上它一起渲染
        if (this.state !== 'recording') return
        this.overlayService.setStreamingText(text)
      },

      onASR: (result) => {
        if (this.state !== 'processing') return
        if (this.run.finalHandledInCurrentRun) return
        if (result.text && result.text.trim() !== '') return

        const runId = this.activeRunId
        if (!this.isRunCurrent(runId)) return
        // 空 ASR 已是本代终态：同步阻止 timeout 与后续 final 再次收尾。
        this.run.finalHandledInCurrentRun = true
        this.clearProcessingTimeout()

        const audioDur = this.getAudioDurationSec()
        const wallSec = this.run.wallTimeAtStopSec > 0 ? this.run.wallTimeAtStopSec : audioDur
        const audioChunkCount = this.run.recordedChunks.length
        const historyMeta = this.buildHistoryMetadata(
          this.run.currentPromptResolution,
          this.run.currentActiveAppContext,
        )
        // ASR 跑完了，只是一个字都没出。这**不等于**用户没说话 —— 热词回显被判定
        // 清空、服务端提前收尾都会走到这里（pitfalls 15）。所以分两条说：
        // 采集侧有近静音实证的，才敢说「未检测到有效声音」；没有实证的只说
        // 「没有取得识别结果」，并给出可恢复的去处，别把人引去查麦克风。
        const silenceProven = this.micLevel.hasSilenceEvidence()
        const silenceDiagnostic = {
          reason: 'asr_empty',
          mode: this.provider.mode,
          audioSec: Number(audioDur.toFixed(1)),
          asrMs: result.asrMs || 0,
          audioChunks: audioChunkCount,
          silenceProven,
          peakAmplitude: this.micLevel.roundedPeakAmplitude(),
          runId,
        }
        // 识别没出文字一律只给 toast，不弹卡片。
        //
        // ⚠️ **同一个判据在 onFinal 的空结果分支里还有一份**（搜 showNoSpeech）。
        // 2026-09-23 实测代价：只把那一份改成 toast，这条路照旧弹卡片，用户原样复现。
        // 改任何一处都要同时改另一处；noTextNeverShowsCard 那条源码级断言钉着这件事。
        this.overlayService.showNoSpeech(silenceProven ? 'silent' : 'no_text', silenceDiagnostic)
        if (!silenceProven) {
          addRuntimeEvent('warn', 'recorder', 'ASR returned no text and there is no silence evidence', silenceDiagnostic)
        }
        void (async () => {
          // 两条路的存档参数本来就完全一样（同一个 failReasonCode），合并掉那份
          // 重复的 if/else —— 它正是上面那个漏改能发生的土壤。
          await this.history.writeFailedRun({
            runId,
            audioDurationSec: audioDur,
            wallTimeSec: wallSec,
            asrMs: result.asrMs || 0,
            asrDurationSec: result.durationSec > 0 ? result.durationSec : undefined,
            failReason: t('recorder.noTranscript'),
            failReasonCode: 'no_transcript',
            historyMeta,
            aiSource: result.aiSource,
            aiStatus: result.aiStatus,
          })

          if (!this.isRunCurrent(runId)) return
          this.finishRun(runId)
          this.resetToIdle({ keepOverlay: true })
        })()
      },

      onFinal: (result) => {
        if (this.state !== 'processing') {
          const lateContext = this.consumeTimedOutProcessingContext()
          if (!lateContext) return

          addRuntimeEvent('warn', 'recorder', 'Received a late final result for a timed-out session', {
            timedOutAt: lateContext.timedOutAt,
            lateByMs: Date.now() - lateContext.timedOutAt,
            durationSec: result.durationSec,
            asrMs: result.asrMs,
            llmMs: result.llmMs,
          })
          // final 已经快照到前端，立即废弃旧 Provider 会话；尤其 Server 必须断开旧 socket，
          // 防止随后迟到的 done/error 在下一代 start 后误清新会话。
          this.provider.cancel()
          if (this.provider.mode === 'server') this.ensureConnection()
          this.finalizingLateRunId = lateContext.runId
          // 用户已经放弃等待（宽限期里按了 Esc，或关掉了失败卡）：结果照样落历史，
          // 但**绝不自动插字**。界面上刚说完"不等了"，几秒后文字自己出现在输入框里，
          // 是最让人措手不及的一种行为。
          const abandoned = this.lateResultAbandoned
          if (abandoned) {
            addRuntimeEvent('warn', 'recorder', 'Late final arrived after the user abandoned it; saving without inserting', {
              runId: lateContext.runId,
              lateByMs: Date.now() - lateContext.timedOutAt,
            })
          }
          void this.processFinalResult(result, lateContext, {
            allowInsertionWhenIdle: true,
            source: 'late_after_timeout',
          }).finally(() => {
            if (this.finalizingLateRunId === lateContext.runId) this.finalizingLateRunId = 0
            // 这一代彻底收尾了：再晚到的 Esc 不该还能改它的行为。
            if (this.lateResultRunId === lateContext.runId) {
              this.lateResultRunId = 0
              this.lateResultAbandoned = false
            }
          })
          return
        }
        if (this.run.finalHandledInCurrentRun) {
          addRuntimeEvent('warn', 'recorder', 'Ignored duplicate final result')
          return
        }
        this.run.finalHandledInCurrentRun = true
        // 首个 processing final 在同步回调路径立即撤销 timeout，避免二者双收尾。
        this.clearProcessingTimeout()
        this.run.finalReceivedAt = Date.now()

        const localAudioDur = this.getAudioDurationSec()
        console.log('[ptt-diag] onFinal', {
          backendDurationSec: result.durationSec,
          localAudioDurSec: localAudioDur.toFixed(2),
          audioSentSamples: this.run.audioSentSamples,
          asrMs: result.asrMs,
          llmMs: result.llmMs,
        })

        void this.processFinalResult(result, {
          runId: this.activeRunId,
          timedOutAt: 0,
          settled: true,
          audioDurationSec: this.getAudioDurationSec(),
          wallTimeSec: this.run.wallTimeAtStopSec > 0 ? this.run.wallTimeAtStopSec : this.getAudioDurationSec(),
          promptResolution: this.run.currentPromptResolution ? { ...this.run.currentPromptResolution } : null,
          appContext: this.run.currentActiveAppContext ? { ...this.run.currentActiveAppContext } : null,
          audioChunks: this.run.recordedChunks.slice(),
          probeResult: this.run.cachedProbeResult ? { ...this.run.cachedProbeResult } : null,
        }, {
          allowInsertionWhenIdle: false,
          source: 'processing',
        })
      },

      onDone: () => {
        if (this.state !== 'processing') return
        if (this.run.finalHandledInCurrentRun) return
        if (this.textInsertionInFlight) return
        const runId = this.activeRunId
        this.clearProcessingTimeout()

        // Provider 说本轮结束了，却一个结果都没给（协议异常：done 先于 final 到达、
        // 或服务端只发了 done）。音频已经存档，别让它变成没人认领的孤儿文件 ——
        // 补一条带原因的记录，用户至少还能回放和重新识别。
        if (this.audioArchive.has(runId)) {
          const audioDur = this.getAudioDurationSec()
          const wallSec = this.run.wallTimeAtStopSec > 0 ? this.run.wallTimeAtStopSec : audioDur
          const historyMeta = this.buildHistoryMetadata(
            this.run.currentPromptResolution,
            this.run.currentActiveAppContext,
          )
          addRuntimeEvent('warn', 'recorder', 'Provider finished without any result; saving audio to history', {
            runId,
            mode: this.provider.mode,
            audioSec: audioDur,
          })
          // 协议没跑完（done 先于 final、或服务端只发了 done）。以前这里显示的是
          // 「未检测到有效声音」—— 历史里记的却是 provider_failed，两边对不上，
          // 而用户看到的那句话会把他引去查麦克风。这是调用失败，不是没说话。
          // 这条路**保留卡片**：它不是「没识别出文字」，是协议没跑完 —— 服务端结束了
          // 会话却什么都没回，属于确实出了错。文案也从 noResultTitle 换成专属的一条：
          // 两种成因共用一个标题时，日志里根本分不清弹的是哪一张卡（查这个 bug 时
          // 就被它误导过一次）。
          void (async () => {
            await this.failRunWithCard(runId, {
              title: t('recorder.protocolIncompleteTitle'),
              detail: t('recorder.protocolIncompleteDetail'),
              audioDurationSec: audioDur,
              wallTimeSec: wallSec,
              failReason: t('record.providerFailed'),
              failReasonCode: 'provider_failed',
              historyMeta,
            })
            this.finishRun(runId)
          })()
          this.resetToIdle({ keepOverlay: true })
          return
        }

        this.finishRun(runId)
        this.resetToIdle()
      },

      onError: (msg) => {
        const runId = this.activeRunId
        if (!this.isRunCurrent(runId) || (this.state !== 'recording' && this.state !== 'processing')) {
          addRuntimeEvent('warn', 'backend', 'Ignored error callback from a stale session', { msg, state: this.state, runId })
          return
        }
        const friendlyFailure = describeProviderError(msg)
        addRuntimeEvent('error', 'backend', msg)
        this.clearProcessingTimeout()
        this.run.processingCancelable = false
        void this.overlayService.disableEscapeAction()
        this.run.finalHandledInCurrentRun = true

        // 停止音频采集，并进入不可再触发 stopRecording 的收尾状态。
        const failedWhileRecording = this.state === 'recording'
        if (failedWhileRecording) {
          this.overlayService.stopListeningTicker()
          void stopCapture().catch(() => { })
          this.restoreSystemMuteIfNeeded()
          this.transition('processing')
        }

        const audioDur = this.getAudioDurationSec()
        const wallSec = this.run.wallTimeAtStopSec > 0 ? this.run.wallTimeAtStopSec : audioDur
        const historyMeta = this.buildHistoryMetadata(
          this.run.currentPromptResolution,
          this.run.currentActiveAppContext,
        )
        // 错误在录音进行中到达时还没走过 stopRecording，音频尚未开始落盘 —— 在这里补上，
        // 否则「说到一半连接断了」这段语音谁都没保存。
        if (audioDur >= 0.5 && this.run.recordedChunks.length > 0) {
          this.audioArchive.ensure(runId, this.run.recordedChunks.slice())
        }
        void (async () => {
          if (audioDur >= 0.5) {
            // 供应商/后端给的原话（额度、资源未开通、连接被断都在这里）。
            //
            // ⚠️ 这里以前按 failedWhileRecording 分叉：只有**录音中**到达的错误才提示，
            // 在「处理中」到达就一句话不说、悬浮窗凭空消失（resetToIdle 不带 keepOverlay
            // 就会走到 overlayService.hide()）。而接口调用失败恰恰基本都发生在处理中 ——
            // 这就是用户报的「识别失败没有任何提示」。两条路现在都显示失败卡。
            await this.failRunWithCard(runId, {
              title: t('recorder.recognitionFailedTitle'),
              detail: friendlyFailure.message,
              audioDurationSec: audioDur,
              wallTimeSec: wallSec,
              failReason: friendlyFailure.detail,
              failReasonCode: classifyHistoryProviderFailure(msg),
              historyMeta,
            })
          } else if (this.isRunCurrent(runId)) {
            // 不足 0.5 秒：没有音频可存，也没什么可恢复的，只给一句短提示。
            this.overlayService.showError(friendlyFailure.message)
          }

          if (!this.isRunCurrent(runId)) return
          this.finishRun(runId)
          this.resetToIdle({ keepOverlay: true })
        })()
      },
    }
  }

  // ── Text insertion: uses pre-probed editable result ──

  private async handleTextInsertion(
    text: string,
    options: { allowWhenIdle?: boolean; runId: number; probeResult?: ProbeResult | null },
  ) {
    const { runId } = options
    const allowWhenIdle = options.allowWhenIdle === true
    if (!this.isRunCurrent(runId)) return

    // Guard: if we're no longer in processing (e.g. timeout fired), bail out unless this
    // is the explicitly retained late-final path.
    if (this.state !== 'processing' && !allowWhenIdle) {
      addRuntimeEvent('warn', 'recorder', 'Skipped text insertion because state is no longer processing', { state: this.state, runId })
      return
    }

    // 用户放弃等待迟到结果 —— 这一刀必须扎在**真正插字之前**。
    //
    // 只在 onFinal 那一刻判一次是不够的：结果到达之后还要落历史，那段时间里悬浮窗
    // 仍显示"仍在等结果"，用户正是在那时按 Esc 的。判早了，他的按键全都白按，文字
    // 照样出现在输入框里。
    if (runId === this.lateResultRunId && this.lateResultAbandoned) {
      addRuntimeEvent('warn', 'recorder', 'Skipped text insertion because the user abandoned this late result', {
        runId,
        textLen: text.length,
      })
      this.overlayService.hide()
      return
    }

    // Cancel the processing timeout — we're handling the result now.
    if (this.state === 'processing') {
      this.clearProcessingTimeout()
    }

    const outcome = await this.insertion.insert(text, {
      runId,
      probeResult: options.probeResult ?? null,
      finalReceivedAt: this.run.finalReceivedAt,
      protectClipboard: this.settings.protectClipboard,
      isCurrent: () => this.isRunCurrent(runId),
      waitForModifierRelease: () => this.waitForModifierPTTReleaseIfNeeded(),
      // pasteText 一旦进入 Rust SendInput 就无法撤销。先关闭本地取消屏障，再确认原生
      // Esc 模式已关闭，最后验代；已排队的旧 cancel 因 processingCancelable=false 只能被忽略。
      beforeIrreversiblePaste: async () => {
        this.run.processingCancelable = false
        await this.overlayService.disableEscapeAction()
      },
    })
    switch (outcome.kind) {
      case 'stale':
        return
      case 'fallback':
        this.showFallbackAndReset(text, outcome.reason, runId)
        return
      case 'inserted':
        this.finishRun(runId)
        if (this.state === 'processing') {
          this.resetToIdle()
        } else {
          // 迟到结果那条路进来时状态已经是 idle，resetToIdle 不会执行 —— 而"仍在等结果"
          // 那条提示还挂在屏幕上。文字都插进去了，提示必须跟着收起来。
          this.overlayService.hide()
        }
        return
    }
  }

  /**
   * Show fallback card and transition to idle.
   * Ensures overlay layout is switched to fallback BEFORE hiding other states.
   */
  private showFallbackAndReset(text: string, reason: string, runId: number) {
    if (!this.isRunCurrent(runId)) return
    addRuntimeEvent('info', 'recorder', 'Showing fallback card', {
      runId,
      reason,
      textLen: text.length,
      stateBeforeReset: this.state,
    })
    // 先发布带本代 token 的 fallback，再结束 run；后续旧 dismiss 只能匹配这张卡片。
    this.activeFallbackToken = runId
    this.overlayService.showFallback(text, reason, runId)
    this.finishRun(runId)
    // Then: transition to idle but keep overlay visible
    if (this.state === 'processing') {
      this.resetToIdle({ keepOverlay: true })
    }
  }

  // ── Connection management ──

  private ensureConnection() {
    if (this.provider.isReady()) return
    this.provider.connect(this.buildProviderCallbacks()).catch((err) => {
      // 服务器模式由 websocket.ts 的 onclose 按指数退避自动重连（3s→30s）。这里再每 5 秒
      // 补一次，断网时（拒连秒失败）日志会刷屏；主动断开（cleanup/取消）后也会被它拉回来。
      if (this.provider.mode === 'server') {
        addRuntimeEvent('warn', 'websocket', 'Preconnection failed; websocket auto-reconnect will retry', { error: String(err) })
        return
      }
      addRuntimeEvent('warn', 'websocket', 'Preconnection failed; retrying in 5s', { error: String(err) })
      setTimeout(() => this.ensureConnection(), 5000)
    })
  }

  // ── Recording lifecycle ──

  /**
   * 开始录音的外层兜底。
   *
   * startRecordingInner 自己的 try 只包住「建连 + 开麦」那一段；在它之前还有取上下文、
   * 提示词路由等十几步，都发生在 startRecordingLock 置位之后。那里抛的异常以前没人接
   * （调用方是 `void this.startRecording()`），锁永远不释放，之后每次按热键都被当成
   * 「正在启动」忽略 —— 热键全部失灵直到重启，悬浮窗停在「等待中」，日志里一个字都没有。
   */
  private async startRecording() {
    try {
      await this.startRecordingInner()
    } catch (error) {
      const runId = this.activeRunId
      addRuntimeEvent('error', 'recorder', 'Failed to start recording', {
        error: String(error),
        stage: 'setup',
        runId,
      })
      this.startRecordingLock = false
      this.run.pendingStopWhileStarting = false
      this.restoreSystemMuteIfNeeded()
      if (runId !== 0) {
        this.finishRun(runId)
        this.provider.cancel()
      }
      this.overlayService.showError(t('recorder.startFailed'))
      this.resetToIdle({ keepOverlay: true })
    }
  }

  private async startRecordingInner() {
    if (
      this.state !== 'idle'
      || this.startRecordingLock
      || this.textInsertionInFlight
      || this.finalizingLateRunId !== 0
    ) {
      addRuntimeEvent('info', 'recorder', 'Ignored start-recording request', {
        state: this.state,
        locked: this.startRecordingLock,
        textInsertionInFlight: this.textInsertionInFlight,
        finalizingLateRunId: this.finalizingLateRunId,
      })
      return
    }

    // 未就绪（如 server 模式后端未连接）：给出告警，不进入录音，避免悬浮窗卡住关不掉
    if (!this.provider.isReady()) {
      this.handsFreeMode = false
      addRuntimeEvent('warn', 'recorder', 'Provider not ready; ignored start-recording request', { mode: this.provider.mode })
      this.overlayService.showError(this.notReadyMessage())
      this.ensureConnection()
      return
    }

    // 新 run 创建前先废弃 timeout 宽限期的旧 provider 代次；后续原有 connect 流程
    // 会为 ServerProvider 建立新 socket，Cloud/Local 也会因 cancel 丢弃旧回调。
    const timedOutContext = this.timedOutProcessingContext
    if (timedOutContext) {
      this.timedOutProcessingContext = null
      this.provider.cancel()
      this.finishRun(timedOutContext.runId)
    }

    const runId = ++this.runSequence
    this.activeRunId = runId
    this.activeFallbackToken = 0
    this.startRecordingLock = true
    this.run.pendingStopWhileStarting = false
    this.timedOutProcessingContext = null
    this.micLevel.resetMuteState()

    // 先给用户即时视觉反馈；overlay 不聚焦，因此后续原生上下文捕获仍指向原目标窗口。
    // 首次 WebView 已在启动空闲期预热，正常情况下这里只剩一次轻量 show + emit。
    this.overlayService.showWaiting()
    // 不等待上下文捕获、Provider 建连或 AudioWorklet 初始化：提前拿到系统静音标志，
    // 好让第一帧 PCM 一到就能立刻裁决（标志本身不足以判定，见 pendingOsMicMuted）。
    void this.micLevel.checkConfiguredMicMuted(runId)

    const targetCapture = captureActiveInsertionTarget(undefined, {
      preserveExistingOnFailure: true,
    })
    let activeAppContext: ActiveAppContext | null = null
    try {
      // AI is the only consumer of editor text. If cleanup is off, do not read the text even when
      // the preference remains enabled, so the privacy boundary matches actual behavior.
      const includeTextContext = this.settings.contextAwareWriting && this.settings.aiEnabled
      const recordingContext = await bridge.getRecordingContext(includeTextContext)
      activeAppContext = recordingContext.appContext as unknown as ActiveAppContext
      this.run.cachedProbeResult = recordingContext.probe as unknown as ProbeResult
      addRuntimeEvent('info', 'recorder', 'Insertion probe cached at recording start', {
        probeId: this.run.cachedProbeResult.probeId,
        hwnd: this.run.cachedProbeResult.hwnd,
        focusHwnd: this.run.cachedProbeResult.focusHwnd,
        editable: this.run.cachedProbeResult.editable,
        process: this.run.cachedProbeResult.process,
        verdict: this.run.cachedProbeResult.verdict,
      })
    } catch {
      activeAppContext = null
      this.run.cachedProbeResult = null
    }
    const textContext = usableTextContext(activeAppContext?.textContext)
    if (activeAppContext) {
      if (textContext) activeAppContext.textContext = textContext
      else delete activeAppContext.textContext
    }
    this.run.currentActiveAppContext = activeAppContext

    this.run.currentPromptResolution = resolvePromptRouting({
      appContext: activeAppContext,
      presets: this.settings.presets,
      activePresetId: this.settings.activePresetId,
      appRules: this.settings.appPromptRules,
      userStats: this.userStats,
      hotwords: this.settings.hotwords,
      injectHotwords: this.settings.injectHotwords,
    })
    if (textContext) {
      this.run.currentPromptResolution = {
        ...this.run.currentPromptResolution,
        systemPrompt: withContextAwareInstructions(
          this.run.currentPromptResolution.systemPrompt,
          textContext,
          this.settings.contextSelectionEditPrompt,
        ),
        summary: `${this.run.currentPromptResolution.summary} | Text context: ${textContext.selectedText ? 'selection' : 'caret'}`,
      }
      addRuntimeEvent('info', 'recorder', 'Text context captured', {
        source: textContext.source,
        beforeLen: textContext.textBefore.length,
        selectedLen: textContext.selectedText.length,
        afterLen: textContext.textAfter.length,
      })
    }

    addRuntimeEvent('info', 'recorder', 'Recording started', {
      micId: this.settings.micId || 'default',
      preset: this.run.currentPromptResolution.preset.id || this.run.currentPromptResolution.preset.name || 'none',
      targetCapture,
      appContext: this.summarizeAppContext(activeAppContext || null),
      promptRouting: {
        appId: this.run.currentPromptResolution.appId,
        appName: this.run.currentPromptResolution.appName,
        presetId: this.run.currentPromptResolution.preset.id,
        presetName: this.run.currentPromptResolution.preset.name,
        promptRuleId: this.run.currentPromptResolution.matchedRule?.id,
        summary: this.run.currentPromptResolution.summary,
      },
    })
    addRuntimeEvent('info', 'personalization', 'Prompt routing resolved', {
      appContext: this.summarizeAppContext(activeAppContext || null),
      appId: this.run.currentPromptResolution.appId,
      appName: this.run.currentPromptResolution.appName,
      presetId: this.run.currentPromptResolution.preset.id,
      presetName: this.run.currentPromptResolution.preset.name,
      promptRuleId: this.run.currentPromptResolution.matchedRule?.id,
      summary: this.run.currentPromptResolution.summary,
    })

    this.run.finalHandledInCurrentRun = false
    // 只在开始新一次录音时清：resetToIdle 也会在超时路径上跑，那时宽限期才刚开始，
    // 清掉它就等于把用户的"我不等了"忘掉。
    this.lateResultAbandoned = false
    this.lateResultRunId = 0
    this.run.audioSentSamples = 0
    this.run.wallTimeAtStopSec = 0
    this.run.recordedChunks = []
    this.micLevel.resetLevels()
    resetWaveformBarState(this.overlayWaveState, this.overlayService.getBarCount(), 3)

    // Hands-free mode: arm a 5-minute auto-stop timer
    // is handled by the Rust keyboard hook's hard_timeout_release)
    const armHandsFreeTimer = () => {
      if (!this.handsFreeMode) return
      this.handsFreeAutoStopId = setTimeout(() => {
        if (this.state === 'recording' && this.handsFreeMode) {
          addRuntimeEvent('warn', 'recorder', 'Hands-free recording is approaching the five-minute limit')
          this.overlayService.showTimeoutWarning()
          // Auto-stop after 1 more minute
          this.handsFreeAutoStopId = setTimeout(() => {
            if (this.state === 'recording' && this.handsFreeMode) {
              addRuntimeEvent('warn', 'recorder', 'Hands-free recording reached five minutes and stopped automatically')
              void this.stopRecording()
            }
          }, RECORDING_COUNTDOWN_SEC * 1000)
        }
        // 与上限统一由常量推导，避免"改了上限忘了改提醒时机"
      }, (MAX_RECORDING_SEC - RECORDING_COUNTDOWN_SEC) * 1000)
    }

    // 冻结本次的 AI 配置。理由是事后解释：用户录完之后改了设置（这次排查里他就把
    // 门槛从 60 改成了 0），这一条的原因也不能跟着变。
    this.run.currentAiConfig = {
      workMode: this.provider.mode,
      aiEnabled: this.settings.aiEnabled,
      aiMinDurationSec: this.settings.aiMinDurationSec,
      serverAiSource: getRuntimeServerAiSource(),
    }
    this.run.currentOperationId = `${runId}-${Date.now().toString(36)}`

    // 选区编辑单独选了模型时，这次录音改由本机用那个模型整理（见 selectionAi.ts）。
    // 读设置放进下面和建连、开麦并行的那一组里，不在这里 await：这一段处在
    // startRecordingLock 置位之后、外层兜底之外，多一个 await 就多一处让热键卡死的
    // 可能，开始录音也会慢一拍。没有选区时它不读设置，直接返回 null。
    const selectionAiConfigPromise = this.settings.aiEnabled
      ? loadSelectionAiConfig(textContext)
      : Promise.resolve(null)

    const promptOpts = this.run.currentPromptResolution
      ? {
        runId,
        operationId: this.run.currentOperationId,
        aiConfig: this.run.currentAiConfig,
        systemPrompt: this.settings.aiEnabled ? this.run.currentPromptResolution.systemPrompt : undefined,
        disableAi: !this.settings.aiEnabled,
        aiMinDurationSec: this.settings.aiMinDurationSec,
        clientMeta: this.clientRuntimeInfo,
        appContext: activeAppContext,
        textContext,
        hotwords: this.settings.hotwords.length > 0 ? this.settings.hotwords : undefined,
        language: this.settings.language || undefined,
        streamingDisplay: this.settings.streamingDisplay,
      }
      : {
        runId,
        operationId: this.run.currentOperationId,
        aiConfig: this.run.currentAiConfig,
        disableAi: !this.settings.aiEnabled,
        aiMinDurationSec: this.settings.aiMinDurationSec,
        clientMeta: this.clientRuntimeInfo,
        appContext: activeAppContext,
        textContext,
        hotwords: this.settings.hotwords.length > 0 ? this.settings.hotwords : undefined,
        language: this.settings.language || undefined,
        streamingDisplay: this.settings.streamingDisplay,
      }

    // Wrap the async setup so stopRecording can wait for it
    let resolveCaptureReady: () => void
    this.run.captureReadyPromise = new Promise<void>((resolve) => { resolveCaptureReady = resolve })

    try {

      // 并行执行 WebSocket 连接和麦克风采集，减少等待时间
      const [, captureResult, selectionAiConfig] = await Promise.all([
        this.provider.connect(this.buildProviderCallbacks()),
        startCapture(
          this.settings.micId || undefined,
          (buffer) => {
            if (!this.isRunCurrent(runId)) return
            if (this.run.audioSentSamples === 0) {
              console.log('[ptt-diag] first onData buffer', {
                byteLength: buffer.byteLength,
                samples: buffer.byteLength / 2,
              })
            }
            this.run.recordedChunks.push(buffer.slice(0))
            this.provider.sendAudio(buffer)
          },
          undefined,
          (pcmFrame) => {
            if (!this.isRunCurrent(runId)) return
            this.run.audioSentSamples += pcmFrame.length
            const bars = computeBarsFromPCM(pcmFrame, this.overlayWaveState, {
              barCount: this.overlayService.getBarCount(),
              minHeight: 3,
              maxHeight: 18,
            })
            this.overlayService.pushListeningBars(bars)

            this.micLevel.onFrame(pcmFrame)
          },
          this.settings.noiseSuppression,
        ),
        selectionAiConfigPromise,
      ])
      resolveCaptureReady!()
      if (!this.isRunCurrent(runId)) {
        await stopCapture().catch(() => { })
        return
      }

      // 冻结的 AI 配置要带上 selectionAiOverride：停止录音时 aiPolicy 靠它判成本机整理，
      // 服务器模式下才会让服务端只做识别。
      let startOpts: typeof promptOpts & { selectionAiConfig?: typeof selectionAiConfig } = promptOpts
      if (selectionAiConfig && this.run.currentAiConfig) {
        this.run.currentAiConfig = { ...this.run.currentAiConfig, selectionAiOverride: true }
        startOpts = { ...promptOpts, aiConfig: this.run.currentAiConfig, selectionAiConfig }
        addRuntimeEvent('info', 'ai', 'Selection edit uses its own AI service', {
          provider: selectionAiConfig.provider,
          model: selectionAiConfig.model,
        })
      }

      // Both WebSocket and mic are ready — send start command
      const started = this.provider.start(startOpts)
      if (!started) {
        throw new Error('sendStart failed')
      }
      addRuntimeEvent('info', 'recorder', 'Start sent; audio capture beginning')

      // Audio capture is now active — transition to recording state and show audio bars
      this.run.recordStartPerf = performance.now()
      if (!this.transition('recording')) {
        this.startRecordingLock = false
        this.provider.cancel()
        this.finishRun(runId)
        this.resetToIdle()
        if (this.provider.mode === 'server') this.ensureConnection()
        return
      }
      this.startRecordingLock = false
      // 若本次会走流式实时显示，录音一开始就让气泡显示占位，避免中途弹出+缩放导致的抖动。
      // 实时读取供应商/WorkspaceId（避免切换供应商后缓存过期，导致非实时模型也弹气泡）。
      void this.applyStreamingActive()
      this.overlayService.startListeningTicker(runId)
      const micSource = describeMicSource(
        captureResult,
        this.settings.micId,
        t('mic.title'),
        captureResult.devices,
      )
      if (micSourceChanged(this.lastMicSourceIdentity, micSource.identity)) {
        this.lastMicSourceIdentity = micSource.identity
        this.overlayService.showMicSourceHint({ mode: micSource.mode, label: micSource.label })
        // rawLabel 与 endpointCount 是判断"这行字为什么显示成这样"的唯一依据：
        // 显示名是由系统给的原始名 + 同一时刻有几个端点共同决定的，缺了这两个
        // 就只能靠猜（audio.ts 里的 trackLabel 只有原始名，没有快照规模）。
        addRuntimeEvent('info', 'recorder', 'Input source reminder shown', {
          mode: micSource.mode,
          label: micSource.label,
          rawLabel: captureResult.label,
          endpointCount: captureResult.devices.length,
        })
      }
      // 录音一开始就查一次麦克风是否被系统静音，被静音则悬浮窗即时红色高警（不阻塞录音）
      // 用 getUserMedia 实际打开的设备再复核；若系统在初始化期间切换了默认麦克风，以这里为准。
      void this.micLevel.checkMicMuted(
        captureResult.label || null,
        runId,
        this.micLevel.nextProbeSequence(),
      )
      // 就绪提示音已触发，稍后再静音系统输出（避免把提示音一起静掉）
      this.scheduleSystemMuteIfEnabled()
      armHandsFreeTimer()

      // Check if PTT up arrived while we were initializing
      if (this.run.pendingStopWhileStarting) {
        this.run.pendingStopWhileStarting = false
        addRuntimeEvent('info', 'recorder', 'PTT released during initialization; stopping immediately')
        void this.stopRecording()
        return
      }

    } catch (error) {
      resolveCaptureReady!()
      // 这一代已被取消/替换（Esc、切换模式）时，连接随之被关掉也会走到这里。
      // 锁、悬浮窗、provider 都归新的一代所有，按上面成功分支的 stale 处理只关采集，
      // 否则会把新一代重置掉、还弹一条「启动失败」。
      if (!this.isRunCurrent(runId)) {
        addRuntimeEvent('info', 'recorder', 'Start failed for a stale run; ignored', { runId, error: String(error) })
        await stopCapture().catch(() => { })
        return
      }
      this.startRecordingLock = false
      this.run.pendingStopWhileStarting = false
      // 录音启动失败也要恢复系统输出，避免系统一直静音
      this.restoreSystemMuteIfNeeded()
      addRuntimeEvent('error', 'recorder', 'Failed to start recording', { error: String(error) })
      try { await stopCapture() } catch { /* ignore */ }
      this.finishRun(runId)
      this.provider.cancel()
      // 在悬浮窗显示错误信息，让用户知道发生了什么
      const errMsg = String(error)
      if (errMsg.includes('麦克风') || errMsg.includes('microphone') || errMsg.includes('audio')) { // i18n-allow: 匹配底层中文错误串
        this.overlayService.showError(t('recorder.microphoneUnavailable'))
      } else {
        this.overlayService.showError(t('recorder.startFailed'))
      }
      this.resetToIdle({ keepOverlay: true })
    }
  }



  private async stopRecording() {
    if (this.state !== 'recording') {
      addRuntimeEvent('info', 'recorder', 'Ignored stop-recording request', { state: this.state })
      return
    }

    const runId = this.activeRunId
    this.micLevel.clearAutoCancelTimer()

    // Wait for capture setup to complete (getUserMedia + AudioWorklet can take time)
    if (this.run.captureReadyPromise) {
      try {
        await Promise.race([
          this.run.captureReadyPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 3000)), // 3s max wait
        ])
      } catch { /* ignore */ }
      this.run.captureReadyPromise = null
    }
    if (this.state !== 'recording' || !this.isRunCurrent(runId)) return

    this.overlayService.stopListeningTicker()
    addRuntimeEvent('info', 'recorder', 'Recording stopped')

    try { await stopCapture() } catch (error) {
      addRuntimeEvent('error', 'recorder', 'Failed to stop audio capture', { error: String(error) })
    }
    // stopCapture 等待期间用户可能按 Esc 使 run 失效；此时绝不能继续 provider.stop。
    if (this.state !== 'recording' || !this.isRunCurrent(runId)) return

    // 采集已停止，恢复系统输出到静音前的状态
    this.restoreSystemMuteIfNeeded()

    const audioDur = this.getAudioDurationSec()
    const pttHoldMs = elapsedSecFromPerf(this.run.recordStartPerf) * 1000
    const wallTimeSec = pttHoldMs / 1000
    this.run.wallTimeAtStopSec = wallTimeSec
    console.log('[ptt-diag] stopRecording', {
      audioSentSamples: this.run.audioSentSamples,
      audioDurSec: audioDur.toFixed(2),
      wallTimeSec: wallTimeSec.toFixed(2),
      durationRatio: pttHoldMs > 0 ? (audioDur / wallTimeSec).toFixed(3) : 'N/A',
    })

    // 数据一致性检查：PCM 时长应接近实际按住时长
    const durationRatio = wallTimeSec > 0 ? audioDur / wallTimeSec : 1
    if (wallTimeSec > 1 && (durationRatio > 2.0 || durationRatio < 0.3)) {
      addRuntimeEvent('warn', 'recorder', 'Unexpected audio byte count; sample rate may not match', {
        audioDurSec: audioDur.toFixed(2),
        wallTimeSec: wallTimeSec.toFixed(2),
        durationRatio: durationRatio.toFixed(3),
        audioSentSamples: this.run.audioSentSamples,
        recordedChunksCount: this.run.recordedChunks.length,
        recordedChunksTotalBytes: this.run.recordedChunks.reduce((s, c) => s + c.byteLength, 0),
      })
      // 不再丢弃音频，保留以便用户回放和重新识别
    }
    if (audioDur < 0.5) {
      addRuntimeEvent('info', 'recorder', 'Recording shorter than 0.5s; canceled provider and discarded audio')
      this.provider.cancel()
      this.finishRun(runId)
      this.resetToIdle()
      if (this.provider.mode === 'server') this.ensureConnection()
      return
    }

    // 短语音门槛只能等到这里才判断：时长要录完才知道。audioDur 用的是边发边累计的
    // 已发送采样数（不是本地攒下来的音频），所以不影响上传，服务器模式照旧流式。
    //
    // 本地/云 API 模式的 AI 是 Provider 在 ASR 之后自己另发的一次请求，它们在那时用
    // 同一个时长自行判断；这里这份只给服务器模式用 —— 服务端的 AI 紧跟 ASR 执行，
    // 客户端插不进中间，只能把结论随 stop 一起送过去。
    // 判据收口到 aiPolicy：此前这里、clientAiPolish、History 的三条重跑路径各判一遍，
    // 结论已经漂移（云 API 重跑漏了门槛、ollama 判据两处不一致）。
    // audioDur 用的是已发送采样数换算的实际 PCM 秒数，不四舍五入。
    const aiPolicy = resolveAiPolicy({
      ...(this.run.currentAiConfig ?? {
        workMode: this.provider.mode,
        aiEnabled: this.settings.aiEnabled,
        aiMinDurationSec: this.settings.aiMinDurationSec,
        serverAiSource: getRuntimeServerAiSource(),
      }),
      audioDurationSec: audioDur,
    })
    // 线上那个布尔只表达「服务端要不要做整理」。自配 AI 路线也会是 false，
    // 但那不是跳过——客户端接着会调。原因一律看 ai.outcome，别从这个布尔反推。
    const skipAiForShortSpeech = aiPolicy.reason === 'duration_below_min'

    // 提出成局部变量：下面的 'Entered processing' 也要带上它。那条日志会落盘，
    // 而 'Stop sent' 不会 —— peakAmplitude=0 是「麦克风一个字节都没收到」的铁证，
    // 必须挂在一条真的进 sayit.log 的日志上，否则等于没记。
    const audioStats = this.micLevel.summary()

    const stopAccepted = this.provider.stop({
      pttHoldMs,
      disableAi: serverShouldPolish(aiPolicy) ? undefined : true,
      aiPolicy,
      audioStats,
    })
    addRuntimeEvent('info', 'recorder', 'Stop sent', {
      audioSec: audioDur,
      pttHoldMs: Math.round(pttHoldMs),
      aiMinDurationSec: this.settings.aiMinDurationSec || undefined,
      skipAiForShortSpeech: skipAiForShortSpeech || undefined,
      stopAccepted,
    })

    if (!this.transition('processing')) {
      this.finishRun(runId)
      this.resetToIdle()
      return
    }
    this.run.processingCancelable = true

    // 音频先落盘，不等识别结果。此后无论超时、断连、还是进程被杀，这段录音都还在磁盘上。
    this.audioArchive.begin(runId, this.run.recordedChunks.slice())

    if (!stopAccepted) {
      // 请求根本没送出去（server 模式连接已断、或 provider 会话已失效）。以前这里照样
      // 进 45 秒超时等待 + 15 秒宽限：悬浮条转整整一分钟「处理中」，而根本没有任何请求
      // 在飞。实测 2026-09-07 两次长录音都是这条路（日志：Failed to send stop）。
      void this.failRunWithoutResult(runId, {
        audioDurationSec: audioDur,
        wallTimeSec,
        failReason: t('recorder.connectionLost'),
        failReasonCode: 'connection_lost',
        title: t('recorder.connectionLostTitle'),
        detail: t('recorder.connectionLostDetail'),
      })
      return
    }

    const processingTimeoutMs = this.computeProcessingTimeoutMs(audioDur)
    addRuntimeEvent('info', 'recorder', 'Entered processing', {
      audioSec: audioDur,
      timeoutMs: processingTimeoutMs,
      mode: this.provider.mode,
      // 这一段音频到底有没有声音，只记统计量、不记内容。读日志的判据：
      // peakAmplitude=0 且 silenceRatio=1 → 麦克风送来的是纯静音，与 ASR/网络无关。
      audioStats,
    })
    this.overlayService.showThinking(audioDur, runId)
    let insertionExtensions = 0
    const onProcessingTimeout = () => {
      if (this.state !== 'processing' || !this.isRunCurrent(runId)) return
      if (this.textInsertionInFlight) {
        if (insertionExtensions < MAX_INSERTION_TIMEOUT_EXTENSIONS) {
          insertionExtensions++
          // 插入已经在飞，给它一点时间；但**必须重新排一次定时器**。以前这里直接 return，
          // 于是插入一旦卡住（Rust SendInput 停在目标进程上）就再没有人来收尾，
          // 悬浮条无限停在「处理中」。
          addRuntimeEvent('warn', 'recorder', 'Processing timed out while text insertion is active; extending wait', {
            runId,
            extension: insertionExtensions,
            extendByMs: INSERTION_TIMEOUT_EXTENSION_MS,
          })
          this.processingTimeoutId = setTimeout(onProcessingTimeout, INSERTION_TIMEOUT_EXTENSION_MS)
          return
        }
        // 顺延用尽：插入大概率卡死了。收尾走 handleInsertionStuck —— 与插入阶段专属
        // 超时共用同一个实现（那个才是正常会触发的那条路，因为 onFinal 早就把这个
        // 处理超时清掉了；这里只是"万一定时器还活着"的兜底）。两条路都幂等。
        this.handleInsertionStuck(
          runId,
          this.textBeingInserted,
          processingTimeoutMs + insertionExtensions * INSERTION_TIMEOUT_EXTENSION_MS,
        )
        return
      }
      const timedOutCtx: TimedOutProcessingContext = {
        runId,
        timedOutAt: Date.now(),
        settled: false,
        audioDurationSec: audioDur,
        wallTimeSec,
        promptResolution: this.run.currentPromptResolution ? { ...this.run.currentPromptResolution } : null,
        appContext: this.run.currentActiveAppContext ? { ...this.run.currentActiveAppContext } : null,
        audioChunks: this.run.recordedChunks.slice(),
        probeResult: this.run.cachedProbeResult ? { ...this.run.cachedProbeResult } : null,
      }
      this.timedOutProcessingContext = timedOutCtx
      this.lateResultAbandoned = false
      this.lateResultRunId = runId
      addRuntimeEvent('warn', 'recorder', 'Processing timed out; waiting out the late-final grace period', {
        audioSec: audioDur,
        timeoutMs: processingTimeoutMs,
        lateFinalGraceMs: LATE_FINAL_GRACE_MS,
      })

      // 宽限期这 15 秒以前是**完全静默**的：悬浮窗当场消失，而迟到的 final 仍会自动
      // 插字。用户看到的是"什么都没发生，然后文字忽然自己出现了"。现在明说仍在等，
      // 并且给 Esc 一个放弃的机会（放弃后迟到结果只落历史、不插字）。
      this.overlayService.showAwaitingLateResult(LATE_FINAL_GRACE_MS / 1000, runId)

      // 安全网：宽限期内没等到迟到的 final，就把这段录音写进历史（空结果 + 明确原因），
      // 用户可以在历史里回放和「重新识别」。音频本身已在 stopRecording 时落盘。
      const historyMeta = this.buildHistoryMetadata(timedOutCtx.promptResolution, timedOutCtx.appContext)
      window.setTimeout(() => {
        // 只认 settled：迟到 final 已接手收尾时让位，避免同一段录音写出两条记录。
        // 绝不再判 isRunCurrent —— 用户又按了一次热键不等于放弃上一段（见 settled 注释）。
        if (timedOutCtx.settled) return
        timedOutCtx.settled = true
        // 仍是当前代时才动 Provider：新录音已在 startRecording 里换过会话，这里再 cancel
        // 会把用户正在录的这一段打断。
        if (this.timedOutProcessingContext === timedOutCtx) {
          this.timedOutProcessingContext = null
          this.provider.cancel()
          if (this.provider.mode === 'server') this.ensureConnection()
        }
        void (async () => {
          // 等待终止之后才进失败卡 —— 宽限期里显示的是「仍在获取结果」，两者不能同时。
          // 用户已经自己放弃（按过 Esc）时不要再弹一张卡片打扰他。
          const stillWaiting = !this.lateResultAbandoned && this.isRunCurrent(timedOutCtx.runId)
          if (stillWaiting) {
            await this.failRunWithCard(timedOutCtx.runId, {
              title: t('recorder.processingTimeoutTitle'),
              detail: t('recorder.processingTimeoutDetail'),
              audioDurationSec: timedOutCtx.audioDurationSec,
              wallTimeSec: timedOutCtx.wallTimeSec,
              failReason: t('recorder.processingTimeout'),
              failReasonCode: 'processing_timeout',
              historyMeta,
            })
          } else {
            await this.history.writeFailedRun({
              runId: timedOutCtx.runId,
              audioDurationSec: timedOutCtx.audioDurationSec,
              wallTimeSec: timedOutCtx.wallTimeSec,
              failReason: t('recorder.processingTimeout'),
              failReasonCode: 'processing_timeout',
              historyMeta,
            })
          }
          this.finishRun(timedOutCtx.runId)
          // 宽限期已经走完，这一代不会再有迟到结果了。
          if (this.lateResultRunId === timedOutCtx.runId) {
            this.lateResultRunId = 0
            this.lateResultAbandoned = false
          }
        })()
      }, LATE_FINAL_GRACE_MS)

      // keepOverlay：宽限期提示刚发出去，绝不能在这里把悬浮窗隐藏掉。
      this.resetToIdle({ preserveLateFinalContext: true, keepOverlay: true })
    }
    this.processingTimeoutId = setTimeout(onProcessingTimeout, processingTimeoutMs)
  }

  // ── Toggle / hands-free ──

  private pttToggle(isHandsFree = false) {
    const now = Date.now()
    if (now - this.lastToggleTime < 500) {
      addRuntimeEvent('info', 'ptt', 'Ignored toggle request', {
        isHandsFree,
        ignoreReason: 'cooldown',
        recorderState: this.state,
      })
      return
    }
    this.lastToggleTime = now

    if (this.state === 'idle') {
      if (isHandsFree) {
        this.handsFreeMode = true
        this.pttSuppressed = true
        setTimeout(() => { this.pttSuppressed = false }, 500)
      }
      addRuntimeEvent('info', 'ptt', 'toggle -> startRecording', {
        isHandsFree,
        recorderState: this.state,
      })
      void this.startRecording()
      return
    }

    if (this.state === 'recording') {
      if (isHandsFree || !this.handsFreeMode) {
        this.handsFreeMode = false
        addRuntimeEvent('info', 'ptt', 'toggle -> stopRecording', {
          isHandsFree,
          recorderState: this.state,
        })
        void this.stopRecording()
      }
      return
    }

    addRuntimeEvent('info', 'ptt', 'Ignored toggle request', {
      isHandsFree,
      ignoreReason: 'state_not_toggleable',
      recorderState: this.state,
      handsFreeMode: this.handsFreeMode,
    })
  }

  private getPTTEventContext(payload?: unknown) {
    const p = (payload && typeof payload === 'object')
      ? (payload as PTTEventPayload)
      : {}
    return {
      source: p.source || 'unknown',
      keycode: p.keycode,
      rawcode: p.rawcode,
      modifiers: {
        alt: p.altKey,
        ctrl: p.ctrlKey,
        shift: p.shiftKey,
      },
      reason: p.reason,
      pttSetting: p.pttSetting,
      timestamp: p.timestamp,
      recorderState: this.state,
      handsFreeMode: this.handsFreeMode,
      pttSuppressed: this.pttSuppressed,
    }
  }

  private logPTTEvent(event: 'down' | 'up' | 'toggle' | 'hands_free', payload?: unknown) {
    addRuntimeEvent('info', 'ptt', `event:${event}`, this.getPTTEventContext(payload))
  }

  private notePTTDown(payload?: unknown) {
    const p = (payload && typeof payload === 'object')
      ? (payload as PTTEventPayload)
      : {}
    this.lastPTTUpUsedModifier = Boolean(
      p.altKey
      || p.ctrlKey
      || p.shiftKey
      || this.isModifierPTTSetting(p.pttSetting),
    )
  }

  private notePTTUp(payload?: unknown) {
    const p = (payload && typeof payload === 'object')
      ? (payload as PTTEventPayload)
      : {}
    this.lastPTTUpAt = Date.now()
    this.lastPTTUpUsedModifier = Boolean(
      p.altKey
      || p.ctrlKey
      || p.shiftKey
      || this.isModifierPTTSetting(p.pttSetting),
    )
  }

  private isModifierPTTSetting(pttSetting?: string) {
    return _isModifierPTTSetting(pttSetting)
  }

  private async waitForModifierPTTReleaseIfNeeded() {
    if (!this.lastPTTUpUsedModifier || this.lastPTTUpAt <= 0) return
    const elapsedMs = Date.now() - this.lastPTTUpAt
    if (elapsedMs >= MODIFIER_PTT_RELEASE_GUARD_MS) return
    const waitMs = MODIFIER_PTT_RELEASE_GUARD_MS - elapsedMs
    addRuntimeEvent('info', 'recorder', 'Waiting for modifier keys to settle before inserting text', {
      waitMs,
      lastPTTUpAt: this.lastPTTUpAt,
    })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  private summarizeAppContext(context: ActiveAppContext | null) {
    return _summarizeAppContext(context)
  }

  private buildStatsAppId(appContext: ActiveAppContext | null, promptResolution: PromptResolution | null) {
    return _buildStatsAppId(appContext, promptResolution?.appId)
  }

  private buildHistoryMetadata(
    promptResolution?: PromptResolution | null,
    appContext?: ActiveAppContext | null,
  ) {
    const resolved = promptResolution || this.run.currentPromptResolution || undefined
    const ctx = appContext === undefined ? this.run.currentActiveAppContext : appContext
    return {
      appId: resolved?.appId,
      appName: resolved?.appName,
      // 录音时聚焦窗口的原始信息（用于反馈排错）
      windowTitle: ctx?.windowTitle || undefined,
      processName: ctx?.processName || undefined,
      windowClass: ctx?.windowClass || undefined,
      promptPresetId: resolved?.preset.id,
      promptPresetName: resolved?.preset.name,
      promptRuleId: resolved?.matchedRule?.id,
      promptSummary: resolved?.summary,
      workMode: this.provider.mode,
    }
  }


  private computeProcessingTimeoutMs(audioDurationSec: number) {
    return _computeProcessingTimeoutMs(audioDurationSec, this.provider.mode)
  }

  private consumeTimedOutProcessingContext() {
    const context = this.timedOutProcessingContext
    if (!context) return null
    if (!this.isRunCurrent(context.runId)) {
      this.timedOutProcessingContext = null
      return null
    }
    // 超过 15 秒时把 context 留给已排队的宽限期兜底定时器，避免双方都放弃收尾。
    if (Date.now() - context.timedOutAt > LATE_FINAL_GRACE_MS) return null
    this.timedOutProcessingContext = null
    // 迟到 final 接手收尾，兜底定时器必须让位，否则同一段录音会写出两条记录。
    context.settled = true
    return context
  }

  private async processFinalResult(
    result: FinalResult,
    context: TimedOutProcessingContext,
    options: { allowInsertionWhenIdle: boolean; source: 'processing' | 'late_after_timeout' },
  ) {
    const runId = context.runId
    if (!this.isRunCurrent(runId)) return

    // llmText === asrText 说明这段没经过 AI 整理（极速模式，或后端未跑 LLM 直接回 asrText）。
    // 此时文本仍是纯 ASR，「格式规范」由我们兜底；AI 整理过的文本则把格式交给 AI，只做文本替换。
    // New clients may talk to an older server that does not understand text_context. In that case
    // contextApplied is absent: paste the original selection back unchanged instead of replacing it
    // with a spoken edit command.
    const { baseText, rawAsr, selectedEditWasApplied } = resolveContextAwareOutput({
      asrText: result.asrText,
      llmText: result.llmText,
      contextApplied: result.contextApplied,
      textContext: context.appContext?.textContext,
    })
    let textToPaste: string
    try {
      textToPaste = selectedEditWasApplied
        ? await applyTextTransforms(baseText, { rawAsr })
        : baseText
    } catch (error) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('warn', 'recorder', 'Text post-processing failed', { error: String(error), runId })
      if (baseText && baseText.trim()) {
        this.showFallbackAndReset(baseText, 'text_transform_failed', runId)
      } else {
        if (this.state === 'processing') {
          // 后处理抛异常且没有可交付文本：识别本身是空的，所以用 'no_text'，
          // 不能说「未检测到有效声音」。
          this.overlayService.showNoSpeech('no_text', {
            reason: 'text_transform_failed',
            mode: this.provider.mode,
            error: String(error),
            runId,
          })
        }
        this.finishRun(runId)
        if (this.state === 'processing') this.resetToIdle({ keepOverlay: true })
      }
      return
    }
    if (!this.isRunCurrent(runId)) return

    const hasText = Boolean(textToPaste && textToPaste.trim())
    const audioDur = context.audioDurationSec
    const wallSec = context.wallTimeSec > 0 ? context.wallTimeSec : audioDur
    const promptResolution = context.promptResolution
    const appContext = context.appContext
    let historyArtifact: { runId: number; recordId: string; audioFilePath?: string } | null = null

    addRuntimeEvent('info', 'recorder', 'Final result received', {
      runId,
      hasText,
      asrMs: result.asrMs,
      llmMs: result.llmMs,
      durationSec: result.durationSec,
      audioSec: audioDur,
      textLen: textToPaste ? textToPaste.length : 0,
      source: options.source,
      contextApplied: result.contextApplied,
    })

    const written = await this.history.writeFinalRun({
      runId,
      result,
      textToPaste,
      hasText,
      audioDurationSec: audioDur,
      wallTimeSec: wallSec,
      mode: () => this.provider.mode,
      isRunCurrent: () => this.isRunCurrent(runId),
      // 与原来一样在写入那一刻才取：promptResolution 为空时会回落到「当前」的那份。
      metadata: () => this.buildHistoryMetadata(promptResolution, appContext),
    })
    if (written.aborted) return
    historyArtifact = written.artifact

    // 历史已经落定；下面是 UI 与文本插入，那些必须归当前代所有。
    if (!this.isRunCurrent(runId)) {
      if (this.history.isRunCanceled(runId) && historyArtifact) {
        await this.history.discard(historyArtifact)
      }
      return
    }

    if (!hasText) {
      // 三种成因完全不同，以前共用一句「未检测到有效声音」：
      //   · ASR 出了字、后处理把它清空了 —— 是我们自己的替换规则/格式化造成的
      //   · ASR 没出字，且采集侧有近静音实证 —— 确实没说话
      //   · ASR 没出字，但录到了声音 —— 调用侧的问题（额度、服务端提前断开、
      //     热词回显被判空），说成"没声音"会把用户直接引去查麦克风
      // asrLen / llmLen 只记长度不记内容。
      const asrHadText = Boolean(result.asrText?.trim())
      const silenceProven = !asrHadText && this.micLevel.hasSilenceEvidence()
      const diagnostic = {
        reason: 'final_empty',
        mode: this.provider.mode,
        audioSec: Number(audioDur.toFixed(1)),
        asrMs: result.asrMs,
        llmMs: result.llmMs,
        asrLen: result.asrText?.length ?? 0,
        llmLen: result.llmText?.length ?? 0,
        asrHadText,
        silenceProven,
        peakAmplitude: this.micLevel.roundedPeakAmplitude(),
        runId,
      }
      // 只有「ASR 出了字、被后处理清空」才弹失败卡：那指向用户自己的文本替换规则配错了，
      // 需要他去改一处设置，是一条待办。ASR 本身没出字（不管采集侧峰值高低）一律只给
      // toast —— 拿峰值区分「没说话」和「调用失败」是行不通的，见 OverlayService.showNoSpeech。
      if (asrHadText) {
        addRuntimeEvent('warn', 'recorder', 'Text processing emptied the transcript', diagnostic)
        this.overlayService.showFailure({
          title: t('recorder.emptyAfterProcessingTitle'),
          detail: t('recorder.emptyAfterProcessingDetail'),
          // 历史记录在上面已经写好了（含音频路径），所以这里能直接说去哪儿找。
          recovery: historyArtifact?.audioFilePath ? 'history' : 'none',
          token: runId,
        })
        this.activeFallbackToken = runId
      } else {
        this.overlayService.showNoSpeech(silenceProven ? 'silent' : 'no_text', diagnostic)
      }
      this.finishRun(runId)
      if (this.state === 'processing') {
        this.resetToIdle({ keepOverlay: true })
      }
      return
    }

    void this.updatePersonalizationFromFinal(runId, textToPaste, promptResolution, appContext)

    this.textInsertionInFlight = true
    // 插入卡死时要把这段文字交还给用户（见 handleInsertionStuck）。
    this.textBeingInserted = textToPaste
    this.armInsertionTimeout(runId, textToPaste)
    try {
      await this.handleTextInsertion(textToPaste, {
        allowWhenIdle: options.allowInsertionWhenIdle,
        runId,
        probeResult: context.probeResult,
      })
    } catch (error) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('error', 'recorder', 'Text insertion threw; showing fallback card', { error: String(error), runId })
      this.showFallbackAndReset(textToPaste, 'paste_exception', runId)
    } finally {
      this.clearInsertionTimeout()
      this.textInsertionInFlight = false
      this.textBeingInserted = ''
    }
  }

  private async updatePersonalizationFromFinal(
    runId: number,
    finalText: string,
    promptResolution: PromptResolution | null,
    appContext: ActiveAppContext | null,
  ) {
    if (!finalText.trim() || !this.isRunCurrent(runId)) return

    try {
      const wordCount = finalText.length
      const appId = this.buildStatsAppId(appContext, promptResolution)

      const nextStats = await recordSessionStats(appId, wordCount)
      if (!this.isRunCurrent(runId)) return
      this.userStats = nextStats
      addRuntimeEvent('info', 'personalization', 'session stats recorded', {
        appId,
        appName: promptResolution?.appName,
        wordCount,
        totalWords: this.userStats.totalWords,
        totalSessions: this.userStats.totalSessions,
      })
    } catch (error) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('warn', 'personalization', 'failed to record session stats', {
        error: String(error),
      })
    }
  }
}
