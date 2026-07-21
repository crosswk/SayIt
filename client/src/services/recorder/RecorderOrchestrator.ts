import * as bridge from '../bridge'
import { startCapture, stopCapture } from '../audio'
import { getProvider, type TranscriptionProvider, type TranscriptionCallbacks, type FinalResult } from '../transcription'
import { isStreamingDisplayReady } from '@/lib/asrModels'
import {
  addHistory,
  getActivePresetId,
  getPromptPresets,
  getSetting,
  setActivePresetId,
  type PromptPreset,
} from '../store'
import { setActivePresetKnown } from '../../stores/activePreset'
import { addRuntimeEvent } from '../debugLog'
import { saveRecordingAudio } from '../audioFileService'
import {
  BUILTIN_SET_ACTIVE_KEY,
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
import { OverlayService } from './OverlayService'
import { PasteService } from './PasteService'
import { createDefaultUserStats } from '../personalization/defaults'
import { resolvePromptRouting } from '../personalization/promptRouter'
import {
  getAppPromptRules,
  getUserStats,
  recordSessionStats,
} from '../personalization/store'
import type { AppPromptRule, PromptResolution, UserStats } from '../personalization/types'
import type { PTTEventPayload, RecorderState } from './types'
import {
  summarizeAppContext as _summarizeAppContext,
  buildStatsAppId as _buildStatsAppId,
  isModifierPTTSetting as _isModifierPTTSetting,
  computeProcessingTimeoutMs as _computeProcessingTimeoutMs,
} from './helpers'

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
const MODIFIER_PTT_RELEASE_GUARD_MS = 200

interface TimedOutProcessingContext {
  timedOutAt: number
  audioDurationSec: number
  wallTimeSec: number
  promptResolution: PromptResolution | null
  appContext: ActiveAppContext | null
}

interface ResetToIdleOptions {
  keepOverlay?: boolean
  preserveLateFinalContext?: boolean
}

export class RecorderOrchestrator {
  private state: RecorderState = 'idle'
  private onStateChange: ((s: RecorderState) => void) | null = null
  private initialized = false

  private recordStartPerf = 0
  private audioSentSamples = 0
  /** Wall time captured at stopRecording — used for history durationSec so it
   *  matches what the user saw on the overlay (not inflated by backend latency). */
  private wallTimeAtStopSec = 0
  private finalHandledInCurrentRun = false
  private textInsertionInFlight = false
  /** Guard against re-entrant startRecording calls during async setup */
  private startRecordingLock = false
  /** PTT up arrived while startRecording was still initializing — stop immediately after setup */
  private pendingStopWhileStarting = false
  private processingTimeoutId: ReturnType<typeof setTimeout> | null = null
  private finalReceivedAt = 0
  private timedOutProcessingContext: TimedOutProcessingContext | null = null

  private handsFreeMode = false
  private pttSuppressed = false
  private lastToggleTime = 0
  private lastPTTUpAt = 0
  private lastPTTUpUsedModifier = false

  private cachedMicId = ''
  /** 是否在录音期间静音系统输出（防外放被麦克风回采）。默认关闭。 */
  private cachedMuteSystemAudio = false
  /** 插入文本后是否自动还原剪贴板为插入前内容。默认开启。 */
  private cachedProtectClipboard = true
  /** 标记本次录音是否已施加系统静音，用于配对恢复。 */
  private systemMuteApplied = false
  /** 延迟静音定时器（等提示音播完再静音）。 */
  private systemMuteTimerId: ReturnType<typeof setTimeout> | null = null
  private cachedPresets: PromptPreset[] = []
  private cachedActivePresetId = 'intent'
  private cachedAiEnabled = true
  private cachedClientRuntimeInfo: ClientRuntimeInfo | null = null
  private cachedAppPromptRules: AppPromptRule[] = []
  private cachedUserStats: UserStats = createDefaultUserStats()
  private cachedHotwords: string[] = []
  /** 是否把热词注入 AI 提示词（默认关，用户可在热词页开启）。 */
  private cachedInjectHotwords = false
  private cachedLanguage: string = ''
  /** 是否开启流式实时显示（识别过程中把中间结果实时显示在悬浮窗）。默认关闭。 */
  private cachedStreamingDisplay = false
  private currentActiveAppContext: ActiveAppContext | null = null
  private currentPromptResolution: PromptResolution | null = null
  /** Probe result captured at startRecording time (before audio capture begins).
   *  Used by handleTextInsertion so we inject into the window that was focused
   *  when the user started speaking, not whatever happens to be focused later. */
  private cachedProbeResult: import('./PasteService').ProbeResult | null = null

  private readonly overlayWaveState = createWaveformBarState()
  private readonly overlayService = new OverlayService(() => this.getLiveElapsedSec())
  private readonly pasteService = new PasteService()
  private get provider(): TranscriptionProvider { return getProvider() }
  private recordedChunks: ArrayBuffer[] = []
  private captureReadyPromise: Promise<void> | null = null
  /** 5-minute auto-stop timer for hands-free mode */
  private handsFreeAutoStopId: ReturnType<typeof setTimeout> | null = null
  /** Low volume detection: consecutive silent samples count */
  private consecutiveSilentSamples = 0
  /** 连续正常音量的采样数——用于「持续说话一段时间才清除低音量警告」的迟滞判断，避免瞬时小声音把警告瞬间清掉造成闪烁 */
  private consecutiveVoicedSamples = 0
  /** 低音量警告当前是否正在显示 */
  private lowVolumeWarningShown = false
  /** 本次录音是否已经听到过一次正常音量的说话。一旦听到过，说明麦克风正常、距离合适，
   *  后续静音只是正常停顿思考，不再弹「请靠近麦克风」，避免催促感/压迫感。 */
  private hasDetectedVoiceThisSession = false
  private lastLowVolumeWarnAt = 0

  /** Audio stats tracking */
  private audioStatsRmsSum = 0
  private audioStatsPeakRms = 0
  private audioStatsPeakAmplitude = 0
  private audioStatsSilentFrames = 0
  private audioStatsTotalFrames = 0
  private static readonly SILENCE_RMS_THRESHOLD = 0.01

  setStateListener(cb: (s: RecorderState) => void) {
    this.onStateChange = cb
  }

  getState() {
    return this.state
  }

  /** 若已开启「录音时静音系统声音」，在就绪提示音播放之后再静音系统输出。
   *  延迟略长于提示音时长（~150ms），避免把提示音也一起静掉。 */
  private scheduleSystemMuteIfEnabled() {
    if (!this.cachedMuteSystemAudio) return
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
      addRuntimeEvent('warn', 'recorder', '静音系统输出失败', { error: String(e) })
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
      addRuntimeEvent('warn', 'recorder', '恢复系统输出失败', { error: String(e) })
    })
  }

  /** 未就绪时的简短提示文案（按当前工作模式区分）。 */
  private notReadyMessage(): string {
    switch (this.provider.mode) {
      case 'server':
        return '服务器未连接'
      case 'local':
        return '模型未就绪'
      default:
        return '服务未就绪'
    }
  }

  /** 通过快捷键切换当前润色模式，并在空闲时用悬浮窗提示。 */
  private async handlePresetSwitch(presetId: string) {
    try {
      // 优先用已缓存的预设列表，避免 IPC 等待导致的延时
      let target = this.cachedPresets.find((p) => p.id === presetId)
      if (!target) {
        const presets = await getPromptPresets()
        target = presets.find((p) => p.id === presetId)
        this.cachedPresets = presets
      }
      if (!target) {
        addRuntimeEvent('warn', 'recorder', '切换润色模式失败：未找到预设', { presetId })
        return
      }
      // 立即生效：更新录音器缓存 + 通知 UI + 悬浮窗提示（均无需等待 IPC）
      this.cachedActivePresetId = presetId
      setActivePresetKnown(presetId, target.name)
      if (this.state === 'idle') {
        this.overlayService.showPresetSwitched(target.name)
      }
      addRuntimeEvent('info', 'recorder', '快捷键切换润色模式', { presetId, name: target.name })
      // 持久化放到后台，不阻塞 UI 反馈
      void setActivePresetId(presetId)
    } catch (error) {
      addRuntimeEvent('error', 'recorder', '切换润色模式异常', { error: String(error) })
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
    this.ensureConnection()

    // 快捷键切换润色模式（由 Rust global_shortcut 触发）
    void bridge.listen('switch-preset', (event: unknown) => {
      const payload = (event as { payload?: { presetId?: string } })?.payload
      const presetId = payload?.presetId
      if (presetId) void this.handlePresetSwitch(presetId)
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
        this.pendingStopWhileStarting = true
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
        addRuntimeEvent('warn', 'recorder', '录音即将达到 5 分钟上限')
        this.overlayService.showTimeoutWarning()
      }
    })
  }

  cleanup() {
    this.clearProcessingTimeout()
    this.overlayService.dispose()
    stopInsertionTargetTracking()
    void stopCapture().catch(() => {})
    this.provider.disconnect()
  }

  /** 仅更新 AI 整理开关的缓存值，无 IPC/热词/语言等全量刷新。
   *  供标题栏/设置页的开关按钮使用，避免快速切换时卡顿。 */
  setAiEnabledCache(next: boolean) {
    this.cachedAiEnabled = next
  }

  /** 仅更新当前润色模式（preset）的缓存值，无 IPC/热词/语言等全量刷新。
   *  供设置页点击切换润色模式使用，避免快速切换时卡顿。 */
  setActivePresetCache(id: string) {
    this.cachedActivePresetId = id
  }

  /** 仅更新「流式实时显示」开关缓存，供外观设置切换后立即生效。 */
  setStreamingDisplayCache(next: boolean) {
    this.cachedStreamingDisplay = next
  }

  /** 录音开始时实时判定是否激活流式字幕气泡（读最新的开关/供应商/WorkspaceId，避免缓存过期）。
   *  仅 doubao_v2 与 qwen_realtime（且 qwen 需配 WorkspaceId）才激活；qwen3-asr-flash 等不激活。 */
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
      appPromptRules,
      userStats,
      streamingDisplay,
      injectHotwords,
    ] = await Promise.all([
      getSetting('selectedMic', ''),
      getSetting('muteSystemAudioWhileRecording', false),
      getSetting('protectClipboard', true),
      getPromptPresets(),
      getActivePresetId(),
      getSetting('aiEnabled', false),
      getAppPromptRules(),
      getUserStats(),
      getSetting('streamingDisplayEnabled', false),
      getSetting('injectHotwordsToPrompt', false),
    ])

    this.cachedMicId = String(micId || '')
    this.cachedMuteSystemAudio = Boolean(muteSystemAudio)
    this.cachedProtectClipboard = Boolean(protectClipboard)
    this.cachedInjectHotwords = Boolean(injectHotwords)
    this.cachedPresets = presets
    this.cachedActivePresetId = activePresetId
    this.cachedAiEnabled = Boolean(aiEnabled)
    this.cachedAppPromptRules = appPromptRules
    this.cachedUserStats = userStats
    this.cachedStreamingDisplay = Boolean(streamingDisplay)
    await this.overlayService.refreshSettings()

    // 热词 / 服务器语言 / 客户端运行时信息彼此独立，并行加载而非依次 await，
    // 减少本函数的总耗时（每次切换 AI 整理开关等都会触发这里）。
    const [hotwordsResult, languageResult, runtimeInfoResult] = await Promise.allSettled([
      Promise.all([
        getSetting(BUILTIN_SET_WORDS_KEY, {}),
        getSetting(BUILTIN_SET_ACTIVE_KEY, {}),
        getSetting(CUSTOM_THEMES_KEY, []),
        getSetting(CUSTOM_THEME_ACTIVE_KEY, {}),
      ]).then(([rawSetWords, rawSetActive, rawCustomThemes, rawCustomThemeActive]) => {
        const setWords = normalizeBuiltinSetWords(rawSetWords as Record<string, unknown>)
        const setActive = normalizeBuiltinSetActive(rawSetActive as Record<string, unknown>)
        const themes = normalizeCustomThemes(rawCustomThemes)
        const themeActive = normalizeCustomThemeActive(rawCustomThemeActive as Record<string, unknown>, themes)
        return composeHotwords([], setWords, setActive, themes, themeActive)
      }),
      getSetting('server.language', 'auto').then((lang) => {
        const l = lang as string
        return l && l !== 'auto' ? l : ''
      }),
      bridge.getClientRuntimeInfo(),
    ])

    this.cachedHotwords = hotwordsResult.status === 'fulfilled' ? hotwordsResult.value : []
    this.cachedLanguage = languageResult.status === 'fulfilled' ? languageResult.value : ''
    this.cachedClientRuntimeInfo = runtimeInfoResult.status === 'fulfilled' ? runtimeInfoResult.value : null
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
      addRuntimeEvent('warn', 'recorder', `非法状态转移 ${this.state} → ${to}，已忽略`)
      return false
    }
    addRuntimeEvent('info', 'recorder', '状态切换', { from: this.state, to })
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

  private getLiveElapsedSec() {
    if (this.state === 'recording' && this.recordStartPerf > 0) {
      return elapsedSecFromPerf(this.recordStartPerf)
    }
    return this.getAudioDurationSec()
  }

  private getAudioDurationSec() {
    return this.audioSentSamples > 0 ? this.audioSentSamples / 16000 : 0
  }

  private resetToIdle(options?: ResetToIdleOptions) {
    addRuntimeEvent('info', 'recorder', '重置到 idle', {
      fromState: this.state,
      keepOverlay: Boolean(options?.keepOverlay),
      handsFreeMode: this.handsFreeMode,
      textInsertionInFlight: this.textInsertionInFlight,
    })
    this.clearProcessingTimeout()
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
    this.pendingStopWhileStarting = false
    this.handsFreeMode = false
    this.finalHandledInCurrentRun = false
    this.textInsertionInFlight = false
    this.captureReadyPromise = null
    this.finalReceivedAt = 0
    this.currentActiveAppContext = null
    this.currentPromptResolution = null
    this.cachedProbeResult = null
    this.consecutiveSilentSamples = 0
    this.consecutiveVoicedSamples = 0
    this.lowVolumeWarningShown = false
    this.hasDetectedVoiceThisSession = false
    this.lastLowVolumeWarnAt = 0
    clearCapturedInsertionTarget()
    this.recordStartPerf = 0
    if (!options?.preserveLateFinalContext) {
      this.timedOutProcessingContext = null
    }
    this.transition('idle')
    if (!options?.keepOverlay) {
      this.overlayService.clearFallbackHideTimer()
      this.overlayService.hide()
    }
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
        if (this.finalHandledInCurrentRun) return

        if (!result.text || result.text.trim() === '') {
          const audioDur = this.getAudioDurationSec()
          const wallSec = this.wallTimeAtStopSec > 0 ? this.wallTimeAtStopSec : audioDur
          // Save audio even for empty results
          const saveAndRecord = async () => {
            let audioFilePath: string | undefined
            const recordId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
            const saveAudioEnabled = await getSetting('audioRetentionEnabled', true)
            if (saveAudioEnabled && this.recordedChunks.length > 0) {
              try {
                const savedPath = await saveRecordingAudio(recordId, this.recordedChunks)
                if (savedPath) audioFilePath = savedPath
              } catch (err) {
                addRuntimeEvent('warn', 'recorder', '保存音频文件失败（空结果）', { error: String(err) })
              }
            }
            await addHistory({
              id: recordId,
              timestamp: Date.now(),
              asrText: '',
              llmText: '',
              asrMs: result.asrMs || 0,
              llmMs: 0,
              durationSec: wallSec,
              audioDurationSec: audioDur > 0 ? audioDur : undefined,
              asrDurationSec: result.durationSec > 0 ? result.durationSec : undefined,
              charCount: 0,
              isEmpty: true,
              audioFilePath,
              ...this.buildHistoryMetadata(),
            })
            void bridge.emit('history-updated')
          }
          void saveAndRecord()
          // 明确提示"未检测到有效声音"再收尾，避免悬浮窗一闪而逝让用户困惑。
          // keepOverlay 让提示留到它自己的计时器（约 2.5s）隐藏。
          this.overlayService.showNoSpeech()
          this.resetToIdle({ keepOverlay: true })
        }
      },

      onFinal: (result) => {
        if (this.state !== 'processing') {
          const lateContext = this.consumeTimedOutProcessingContext()
          if (!lateContext) return

          addRuntimeEvent('warn', 'recorder', '收到迟到 final，补处理已超时会话', {
            timedOutAt: lateContext.timedOutAt,
            lateByMs: Date.now() - lateContext.timedOutAt,
            durationSec: result.durationSec,
            asrMs: result.asrMs,
            llmMs: result.llmMs,
          })
          void this.processFinalResult(result, lateContext, { allowInsertionWhenIdle: true, source: 'late_after_timeout' })
          return
        }
        if (this.finalHandledInCurrentRun) {
          addRuntimeEvent('warn', 'recorder', '忽略重复 final 消息')
          return
        }
        this.finalHandledInCurrentRun = true
        this.finalReceivedAt = Date.now()

        const localAudioDur = this.getAudioDurationSec()
        console.log('[ptt-diag] onFinal', {
          backendDurationSec: result.durationSec,
          localAudioDurSec: localAudioDur.toFixed(2),
          audioSentSamples: this.audioSentSamples,
          asrMs: result.asrMs,
          llmMs: result.llmMs,
        })

        void this.processFinalResult(result, {
          timedOutAt: 0,
          audioDurationSec: this.getAudioDurationSec(),
          wallTimeSec: this.wallTimeAtStopSec > 0 ? this.wallTimeAtStopSec : this.getAudioDurationSec(),
          promptResolution: this.currentPromptResolution ? { ...this.currentPromptResolution } : null,
          appContext: this.currentActiveAppContext ? { ...this.currentActiveAppContext } : null,
        }, {
          allowInsertionWhenIdle: false,
          source: 'processing',
        })
      },

      onDone: () => {
        if (this.state !== 'processing') return
        if (this.finalHandledInCurrentRun) return
        if (this.textInsertionInFlight) return
        this.resetToIdle()
      },

      onError: (msg) => {
        addRuntimeEvent('error', 'backend', msg)

        // 停止音频采集
        if (this.state === 'recording') {
          this.overlayService.stopListeningTicker()
          void stopCapture().catch(() => {})
        }

        // 保存音频到历史记录（即使识别失败，也保留音频以便重新识别）
        const audioDur = this.getAudioDurationSec()
        const wallSec = this.wallTimeAtStopSec > 0 ? this.wallTimeAtStopSec : audioDur
        if (audioDur >= 0.5 && this.recordedChunks.length > 0) {
          const saveErrorHistory = async () => {
            let audioFilePath: string | undefined
            const recordId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
            const saveAudioEnabled = await getSetting('audioRetentionEnabled', true)
            if (saveAudioEnabled) {
              try {
                const savedPath = await saveRecordingAudio(recordId, this.recordedChunks)
                if (savedPath) audioFilePath = savedPath
              } catch (err) {
                addRuntimeEvent('warn', 'recorder', '保存音频文件失败（错误恢复）', { error: String(err) })
              }
            }
            await addHistory({
              id: recordId,
              timestamp: Date.now(),
              asrText: '',
              llmText: '',
              asrMs: 0,
              llmMs: 0,
              durationSec: wallSec,
              audioDurationSec: audioDur > 0 ? audioDur : undefined,
              charCount: 0,
              isEmpty: true,
              audioFilePath,
              ...this.buildHistoryMetadata(),
            })
            void bridge.emit('history-updated')
          }
          void saveErrorHistory().catch(() => {})
        }

        this.resetToIdle()
      },
    }
  }

  // ── Text insertion: uses pre-probed editable result ──

  private async handleTextInsertion(text: string, options?: { allowWhenIdle?: boolean }) {
    const insertionStartedAt = Date.now()
    const allowWhenIdle = options?.allowWhenIdle === true
    // Guard: if we're no longer in processing (e.g. timeout fired), bail out
    if (this.state !== 'processing' && !allowWhenIdle) {
      addRuntimeEvent('warn', 'recorder', 'handleTextInsertion 跳过：状态已不是 processing', { state: this.state })
      return
    }

    // Cancel the processing timeout — we're handling the result now
    if (this.state === 'processing') {
      this.clearProcessingTimeout()
    }

    // Fetch the probe result that was captured at PTT-down time
    // Prefer the cached probe from startRecording (captured when target was focused)
    // over a fresh probe (which may return the wrong window after recording ends)
    const probe = this.cachedProbeResult ?? await this.pasteService.getProbeResult()
    const usedCachedProbe = this.cachedProbeResult !== null
    const probeAgeMs = typeof probe.completedAt === 'number' ? Date.now() - probe.completedAt : undefined
    const probeDurationMs = (
      typeof probe.completedAt === 'number'
      && typeof probe.startedAt === 'number'
    )
      ? probe.completedAt - probe.startedAt
      : undefined
    addRuntimeEvent('info', 'recorder', '粘贴决策', {
      probeId: probe.probeId,
      editable: probe.editable,
      hwnd: probe.hwnd,
      focusHwnd: probe.focusHwnd,
      pid: probe.pid,
      process: probe.process,
      verdict: probe.verdict,
      isCurrentAppProcess: probe.isCurrentAppProcess,
      windowClass: probe.windowClass,
      focusClass: probe.focusClass,
      usedCachedProbe,
      probeAgeMs,
      probeDurationMs,
      finalToDecisionMs: this.finalReceivedAt > 0 ? insertionStartedAt - this.finalReceivedAt : undefined,
      detail: probe.detail,
      textLen: text.length,
    })

    if (probe.isCurrentAppProcess) {
      // SayIt 自身也是 Chromium 窗口，renderer 直插对 React 受控组件无效
      // （DOM value 被设置但 React state 不同步，下次 re-render 会覆盖）。
      // 所以不走 renderer 直插，而是和外部窗口一样走 Rust paste（Ctrl+V）。
      // 先尝试把文本复制到剪贴板，然后通过 SendInput 粘贴。
      addRuntimeEvent('info', 'recorder', '命中 SayIt 自身进程，走 Rust paste 而非 renderer 直插', {
        probeId: probe.probeId,
        editable: probe.editable,
        hwnd: probe.hwnd,
        focusHwnd: probe.focusHwnd,
      })
      // Fall through to the normal editable / not_editable flow below
    }

    if (!probe.editable) {
      // Target was not editable at PTT-down → copy to clipboard + show fallback card
      addRuntimeEvent('info', 'recorder', '目标不可编辑，进入兜底流程并复制到剪贴板', {
        probeId: probe.probeId,
        pid: probe.pid,
        process: probe.process,
        verdict: probe.verdict,
        isCurrentAppProcess: probe.isCurrentAppProcess,
        detail: probe.detail,
      })
      await this.copyTextSafely(text, 'not_editable')

      addRuntimeEvent('info', 'recorder', '目标不是当前 SayIt 进程，准备展示兜底卡片', {
        probeId: probe.probeId,
        pid: probe.pid,
        process: probe.process,
      })
      this.showFallbackAndReset(text, 'not_editable')
      return
    }

    await this.waitForModifierPTTReleaseIfNeeded()

    // Target was editable → paste (pass probe so Rust uses pre-probed hwnd)
    const pasteStartedAt = Date.now()
    const result = await this.pasteService.pasteText(text, probe, this.cachedProtectClipboard)
    if (result.ok) {
      addRuntimeEvent('info', 'recorder', '外部文本注入成功', {
        strategy: result.strategy,
        detail: result.detail,
        attempts: result.attempts,
        finalToPasteDoneMs: this.finalReceivedAt > 0 ? Date.now() - this.finalReceivedAt : undefined,
        pasteExecMs: Date.now() - pasteStartedAt,
      })

      if (this.state === 'processing') {
        this.resetToIdle()
      }
      return
    }

    // Paste command failed (SendInput error, timeout, etc.)
    const level = result.reason === 'paste_exception' ? 'error' : 'warn'
    addRuntimeEvent(level, 'recorder', '外部文本注入失败，展示兜底卡片', {
      strategy: result.strategy,
      reason: result.reason,
      detail: result.detail,
      attempts: result.attempts,
      finalToPasteDoneMs: this.finalReceivedAt > 0 ? Date.now() - this.finalReceivedAt : undefined,
      pasteExecMs: Date.now() - pasteStartedAt,
    })
    await this.copyTextSafely(text, result.reason || 'paste_failed')
    this.showFallbackAndReset(text, result.reason || 'paste_failed')
  }

  private async copyTextSafely(text: string, reason: string) {
    try {
      await bridge.copyText(text)
      addRuntimeEvent('info', 'recorder', '已复制文本到剪贴板', {
        reason,
        textLen: text.length,
      })
    } catch (error) {
      addRuntimeEvent('warn', 'recorder', '复制兜底文本到剪贴板失败', {
        reason,
        error: String(error),
      })
    }
  }

  /**
   * Show fallback card and transition to idle.
   * Ensures overlay layout is switched to fallback BEFORE hiding other states.
   */
  private showFallbackAndReset(text: string, reason: string) {
    addRuntimeEvent('info', 'recorder', '展示兜底卡片', {
      reason,
      textLen: text.length,
      stateBeforeReset: this.state,
    })
    // First: tell overlay to switch to fallback (this sends overlay-update with state='fallback',
    // which triggers applyOverlayLayout in main process to resize the window)
    this.overlayService.showFallback(text, reason)
    // Then: transition to idle but keep overlay visible
    if (this.state === 'processing') {
      this.resetToIdle({ keepOverlay: true })
    }
  }

  // ── Connection management ──

  private ensureConnection() {
    if (this.provider.isReady()) return
    this.provider.connect(this.buildProviderCallbacks()).catch((err) => {
      addRuntimeEvent('warn', 'websocket', '预连接失败，5s 后重试', { error: String(err) })
      setTimeout(() => this.ensureConnection(), 5000)
    })
  }

  // ── Recording lifecycle ──

  private async startRecording() {
    if (this.state !== 'idle' || this.startRecordingLock) {
      addRuntimeEvent('info', 'recorder', '开始录音请求已忽略', { state: this.state, locked: this.startRecordingLock })
      return
    }

    // 未就绪（如 server 模式后端未连接）：给出告警，不进入录音，避免悬浮窗卡住关不掉
    if (!this.provider.isReady()) {
      this.handsFreeMode = false
      addRuntimeEvent('warn', 'recorder', '未就绪，忽略开始录音', { mode: this.provider.mode })
      this.overlayService.showError(this.notReadyMessage())
      this.ensureConnection()
      return
    }

    this.startRecordingLock = true
    this.pendingStopWhileStarting = false
    this.timedOutProcessingContext = null

    const targetCapture = captureActiveInsertionTarget(undefined, {
      preserveExistingOnFailure: true,
    })
    let activeAppContext: ActiveAppContext | null = null
    try {
      activeAppContext = await bridge.getActiveAppContext()
    } catch {
      activeAppContext = null
    }
    this.currentActiveAppContext = activeAppContext

    // Capture probe result NOW (while the target window is still focused).
    // This is critical for hands-free mode where the user may switch windows
    // during recording. The probe captures hwnd/focusHwnd of the target.
    try {
      this.cachedProbeResult = await this.pasteService.getProbeResult()
      addRuntimeEvent('info', 'recorder', '录音开始时 probe 已缓存', {
        probeId: this.cachedProbeResult.probeId,
        hwnd: this.cachedProbeResult.hwnd,
        focusHwnd: this.cachedProbeResult.focusHwnd,
        editable: this.cachedProbeResult.editable,
        process: this.cachedProbeResult.process,
        verdict: this.cachedProbeResult.verdict,
      })
    } catch {
      this.cachedProbeResult = null
    }

    this.currentPromptResolution = resolvePromptRouting({
      appContext: activeAppContext,
      presets: this.cachedPresets,
      activePresetId: this.cachedActivePresetId,
      appRules: this.cachedAppPromptRules,
      userStats: this.cachedUserStats,
      hotwords: this.cachedHotwords,
      injectHotwords: this.cachedInjectHotwords,
    })

    addRuntimeEvent('info', 'recorder', '开始录音', {
      micId: this.cachedMicId || 'default',
      preset: this.currentPromptResolution.preset.id || this.currentPromptResolution.preset.name || 'none',
      targetCapture,
      appContext: this.summarizeAppContext(activeAppContext || null),
      promptRouting: {
        appId: this.currentPromptResolution.appId,
        appName: this.currentPromptResolution.appName,
        presetId: this.currentPromptResolution.preset.id,
        presetName: this.currentPromptResolution.preset.name,
        promptRuleId: this.currentPromptResolution.matchedRule?.id,
        summary: this.currentPromptResolution.summary,
      },
    })
    addRuntimeEvent('info', 'personalization', 'Prompt 路由已解析', {
      appContext: this.summarizeAppContext(activeAppContext || null),
      appId: this.currentPromptResolution.appId,
      appName: this.currentPromptResolution.appName,
      presetId: this.currentPromptResolution.preset.id,
      presetName: this.currentPromptResolution.preset.name,
      promptRuleId: this.currentPromptResolution.matchedRule?.id,
      summary: this.currentPromptResolution.summary,
    })

    // Show overlay immediately in "waiting/preparing" state
    this.overlayService.clearFallbackHideTimer()
    this.overlayService.showWaiting()

    this.finalHandledInCurrentRun = false
    this.audioSentSamples = 0
    this.wallTimeAtStopSec = 0
    this.recordedChunks = []
    // Reset audio stats
    this.audioStatsRmsSum = 0
    this.audioStatsPeakRms = 0
    this.audioStatsPeakAmplitude = 0
    this.audioStatsSilentFrames = 0
    this.audioStatsTotalFrames = 0
    this.consecutiveSilentSamples = 0
    this.consecutiveVoicedSamples = 0
    this.lowVolumeWarningShown = false
    this.hasDetectedVoiceThisSession = false
    this.lastLowVolumeWarnAt = 0
    resetWaveformBarState(this.overlayWaveState, this.overlayService.getBarCount(), 3)

    // Hands-free mode: arm a 5-minute auto-stop timer
    // is handled by the Rust keyboard hook's hard_timeout_release)
    const armHandsFreeTimer = () => {
      if (!this.handsFreeMode) return
      this.handsFreeAutoStopId = setTimeout(() => {
        if (this.state === 'recording' && this.handsFreeMode) {
          addRuntimeEvent('warn', 'recorder', '免提模式即将达到 5 分钟上限')
          this.overlayService.showTimeoutWarning()
          // Auto-stop after 1 more minute
          this.handsFreeAutoStopId = setTimeout(() => {
            if (this.state === 'recording' && this.handsFreeMode) {
              addRuntimeEvent('warn', 'recorder', '免提模式 5 分钟到达，自动停止')
              void this.stopRecording()
            }
          }, 60_000)
        }
      }, 240_000) // 4 minutes
    }

    const promptOpts = this.currentPromptResolution
      ? {
          systemPrompt: this.cachedAiEnabled ? this.currentPromptResolution.systemPrompt : undefined,
          disableAi: !this.cachedAiEnabled,
          clientMeta: this.cachedClientRuntimeInfo,
          appContext: activeAppContext,
          hotwords: this.cachedHotwords.length > 0 ? this.cachedHotwords : undefined,
          language: this.cachedLanguage || undefined,
          streamingDisplay: this.cachedStreamingDisplay,
        }
      : {
          disableAi: !this.cachedAiEnabled,
          clientMeta: this.cachedClientRuntimeInfo,
          appContext: activeAppContext,
          hotwords: this.cachedHotwords.length > 0 ? this.cachedHotwords : undefined,
          language: this.cachedLanguage || undefined,
          streamingDisplay: this.cachedStreamingDisplay,
        }

    // Wrap the async setup so stopRecording can wait for it
    let resolveCaptureReady: () => void
    this.captureReadyPromise = new Promise<void>((resolve) => { resolveCaptureReady = resolve })

    try {

      // 并行执行 WebSocket 连接和麦克风采集，减少等待时间
      const [, captureResult] = await Promise.all([
        this.provider.connect(this.buildProviderCallbacks()),
        startCapture(
          this.cachedMicId || undefined,
          (buffer) => {
            if (this.audioSentSamples === 0) {
              console.log('[ptt-diag] 首个 onData buffer', {
                byteLength: buffer.byteLength,
                samples: buffer.byteLength / 2,
              })
            }
            this.recordedChunks.push(buffer.slice(0))
            this.provider.sendAudio(buffer)
          },
          undefined,
          (pcmFrame) => {
          this.audioSentSamples += pcmFrame.length
          const bars = computeBarsFromPCM(pcmFrame, this.overlayWaveState, {
            barCount: this.overlayService.getBarCount(),
            minHeight: 3,
            maxHeight: 18,
          })
          this.overlayService.pushListeningBars(bars)

          // Low volume detection: accumulate silent samples at 16kHz
          // 3 seconds = 48000 samples, warn every 5 seconds = 80000 samples
          let sum = 0
          for (let i = 0; i < pcmFrame.length; i++) {
            sum += pcmFrame[i] * pcmFrame[i]
          }
          const rms = Math.sqrt(sum / pcmFrame.length) / 32768

          // Audio stats tracking
          this.audioStatsTotalFrames++
          this.audioStatsRmsSum += rms
          if (rms > this.audioStatsPeakRms) this.audioStatsPeakRms = rms
          // Track peak amplitude (max absolute sample value / 32768) for backend silent detection
          for (let j = 0; j < pcmFrame.length; j++) {
            const amp = Math.abs(pcmFrame[j]) / 32768
            if (amp > this.audioStatsPeakAmplitude) this.audioStatsPeakAmplitude = amp
          }
          if (rms < RecorderOrchestrator.SILENCE_RMS_THRESHOLD) this.audioStatsSilentFrames++

          if (rms < 0.0003) {
            this.consecutiveSilentSamples += pcmFrame.length
            this.consecutiveVoicedSamples = 0
            // 两级静音阈值，避免过度提醒又不漏真问题：
            //  - 还没听到过说话（可能设备选错/离太远/静音）：静音 2s 就提醒（最有价值）。
            //  - 已经听到过说话（设备正常）：正常停顿思考不该催，静音 5s 才提醒。
            //  两种情况都每 5s 重弹一次。
            const FIRST_WARN = this.hasDetectedVoiceThisSession ? 80000 : 32000 // 5s / 2s @16kHz
            const REWARN_MS = 5000
            if (this.consecutiveSilentSamples >= FIRST_WARN) {
              const now = Date.now()
              if (now - this.lastLowVolumeWarnAt >= REWARN_MS) {
                this.lastLowVolumeWarnAt = now
                this.lowVolumeWarningShown = true
                addRuntimeEvent('warn', 'recorder', '持续低音量，可能未检测到声音')
                this.overlayService.showLowVolumeWarning()
              }
            }
          } else {
            // 需连续 ~0.5s（8000 采样 @16kHz）正常音量才认定“已恢复”，再清警告 + 重置静音累计。
            // 单帧/瞬时小声音不会清掉警告，避免“一闪而逝”；用户真正开口约 0.5s 后自然消失。
            this.consecutiveVoicedSamples += pcmFrame.length
            const CLEAR_VOICED = 8000
            if (this.consecutiveVoicedSamples >= CLEAR_VOICED) {
              this.hasDetectedVoiceThisSession = true
              if (this.lowVolumeWarningShown) {
                this.overlayService.clearWarning()
                this.lowVolumeWarningShown = false
              }
              this.consecutiveSilentSamples = 0
            }
          }
        },
      ),
      ])
      resolveCaptureReady!()

      // Both WebSocket and mic are ready — send start command
      const started = this.provider.start(promptOpts)
      if (!started) {
        throw new Error('sendStart failed')
      }
      addRuntimeEvent('info', 'recorder', '已发送 start，开始采集音频')

      // Audio capture is now active — transition to recording state and show audio bars
      this.recordStartPerf = performance.now()
      if (!this.transition('recording')) {
        this.startRecordingLock = false
        return
      }
      this.startRecordingLock = false
      // 若本次会走流式实时显示，录音一开始就让气泡显示占位，避免中途弹出+缩放导致的抖动。
      // 实时读取供应商/WorkspaceId（避免切换供应商后缓存过期，导致非实时模型也弹气泡）。
      void this.applyStreamingActive()
      this.overlayService.startListeningTicker()
      // 就绪提示音已触发，稍后再静音系统输出（避免把提示音一起静掉）
      this.scheduleSystemMuteIfEnabled()
      armHandsFreeTimer()

      // Check if PTT up arrived while we were initializing
      if (this.pendingStopWhileStarting) {
        this.pendingStopWhileStarting = false
        addRuntimeEvent('info', 'recorder', 'PTT up 在初始化期间到达，立即停止录音')
        void this.stopRecording()
        return
      }

    } catch (error) {
      resolveCaptureReady!()
      this.startRecordingLock = false
      this.pendingStopWhileStarting = false
      // 录音启动失败也要恢复系统输出，避免系统一直静音
      this.restoreSystemMuteIfNeeded()
      addRuntimeEvent('error', 'recorder', '开始录音失败', { error: String(error) })
      try { await stopCapture() } catch { /* ignore */ }
      this.provider.stop({ pttHoldMs: elapsedSecFromPerf(this.recordStartPerf) * 1000 })
      // 在悬浮窗显示错误信息，让用户知道发生了什么
      const errMsg = String(error)
      if (errMsg.includes('麦克风') || errMsg.includes('microphone') || errMsg.includes('audio')) {
        this.overlayService.showError('麦克风不可用')
      } else {
        this.overlayService.showError('录音启动失败')
      }
      this.resetToIdle({ keepOverlay: true })
    }
  }

  private async stopRecording() {
    if (this.state !== 'recording') {
      addRuntimeEvent('info', 'recorder', '停止录音请求已忽略', { state: this.state })
      return
    }

    // Wait for capture setup to complete (getUserMedia + AudioWorklet can take time)
    if (this.captureReadyPromise) {
      try {
        await Promise.race([
          this.captureReadyPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 3000)), // 3s max wait
        ])
      } catch { /* ignore */ }
      this.captureReadyPromise = null
    }

    this.overlayService.stopListeningTicker()
    addRuntimeEvent('info', 'recorder', '停止录音')

    try { await stopCapture() } catch (error) {
      addRuntimeEvent('error', 'recorder', '停止采集失败', { error: String(error) })
    }

    // 采集已停止，恢复系统输出到静音前的状态
    this.restoreSystemMuteIfNeeded()

    const audioDur = this.getAudioDurationSec()
    const pttHoldMs = elapsedSecFromPerf(this.recordStartPerf) * 1000
    const wallTimeSec = pttHoldMs / 1000
    this.wallTimeAtStopSec = wallTimeSec
    console.log('[ptt-diag] stopRecording', {
      audioSentSamples: this.audioSentSamples,
      audioDurSec: audioDur.toFixed(2),
      wallTimeSec: wallTimeSec.toFixed(2),
      durationRatio: pttHoldMs > 0 ? (audioDur / wallTimeSec).toFixed(3) : 'N/A',
    })

    // 数据一致性检查：PCM 时长应接近实际按住时长
    const durationRatio = wallTimeSec > 0 ? audioDur / wallTimeSec : 1
    if (wallTimeSec > 1 && (durationRatio > 2.0 || durationRatio < 0.3)) {
      addRuntimeEvent('warn', 'recorder', '音频数据量异常，可能采样率不匹配', {
        audioDurSec: audioDur.toFixed(2),
        wallTimeSec: wallTimeSec.toFixed(2),
        durationRatio: durationRatio.toFixed(3),
        audioSentSamples: this.audioSentSamples,
        recordedChunksCount: this.recordedChunks.length,
        recordedChunksTotalBytes: this.recordedChunks.reduce((s, c) => s + c.byteLength, 0),
      })
      // 不再丢弃音频，保留以便用户回放和重新识别
    }
    this.provider.stop({
      pttHoldMs,
      audioStats: this.audioStatsTotalFrames > 0 ? {
        avgRms: Math.round((this.audioStatsRmsSum / this.audioStatsTotalFrames) * 10000) / 10000,
        peakRms: Math.round(this.audioStatsPeakRms * 10000) / 10000,
        peakAmplitude: Math.round(this.audioStatsPeakAmplitude * 10000) / 10000,
        silenceRatio: Math.round((this.audioStatsSilentFrames / this.audioStatsTotalFrames) * 1000) / 1000,
        totalFrames: this.audioStatsTotalFrames,
      } : undefined,
    })
    addRuntimeEvent('info', 'recorder', '已发送 stop', { audioSec: audioDur, pttHoldMs: Math.round(pttHoldMs) })

    if (audioDur < 0.5) {
      addRuntimeEvent('info', 'recorder', '录音过短（<0.5s），直接丢弃')
      this.resetToIdle()
      return
    }

    if (!this.transition('processing')) return

    const processingTimeoutMs = this.computeProcessingTimeoutMs(audioDur)
    addRuntimeEvent('info', 'recorder', '进入 processing', {
      audioSec: audioDur,
      timeoutMs: processingTimeoutMs,
    })
    this.overlayService.showThinking(audioDur)
    this.processingTimeoutId = setTimeout(() => {
      if (this.state !== 'processing') return
      if (this.textInsertionInFlight) {
        addRuntimeEvent('warn', 'recorder', '处理超时但文本插入仍在进行，延长等待')
        return
      }
      this.timedOutProcessingContext = {
        timedOutAt: Date.now(),
        audioDurationSec: audioDur,
        wallTimeSec,
        promptResolution: this.currentPromptResolution ? { ...this.currentPromptResolution } : null,
        appContext: this.currentActiveAppContext ? { ...this.currentActiveAppContext } : null,
      }
      addRuntimeEvent('warn', 'recorder', '处理超时，自动回到空闲状态', {
        audioSec: audioDur,
        timeoutMs: processingTimeoutMs,
        lateFinalGraceMs: LATE_FINAL_GRACE_MS,
      })
      this.resetToIdle({ preserveLateFinalContext: true })
    }, processingTimeoutMs)
  }

  // ── Toggle / hands-free ──

  private pttToggle(isHandsFree = false) {
    const now = Date.now()
    if (now - this.lastToggleTime < 500) {
      addRuntimeEvent('info', 'ptt', 'toggle 请求已忽略', {
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

    addRuntimeEvent('info', 'ptt', 'toggle 请求已忽略', {
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
    addRuntimeEvent('info', 'recorder', '等待修饰键释放稳定后再注入文本', {
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

  private buildHistoryMetadata(promptResolution?: PromptResolution | null) {
    const resolved = promptResolution || this.currentPromptResolution || undefined
    const ctx = this.currentActiveAppContext
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

  /** 异步获取当前模式下的 ASR/AI 供应商信息 */
  private async buildProviderMetadata(finalResult?: { asrEngine?: string; asrModel?: string }): Promise<{
    asrProvider?: string
    aiProvider?: string
    aiModel?: string
  }> {
    const mode = this.provider.mode
    if (mode === 'server') {
      let asrProvider = finalResult?.asrModel || finalResult?.asrEngine || 'server'
      // 后端返回 HuggingFace repo 全名如 "Qwen/Qwen3-ASR-1.7B"，只取模型名
      const slashIdx = asrProvider.lastIndexOf('/')
      if (slashIdx >= 0) asrProvider = asrProvider.slice(slashIdx + 1)
      return { asrProvider, aiProvider: 'server' }
    }
    if (mode === 'cloud_api') {
      const asrProviderKey = await getSetting('cloudAsr.provider', '') as string
      // 映射内部 key 到实际模型 ID
      const ASR_MODEL_ID_MAP: Record<string, string> = {
        doubao_v2: 'Doubao-Seed-ASR-2.0',
        qwen: 'qwen3-asr-flash',
        mimo: 'mimo-v2.5-asr',
        qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
        qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
        qwen_omni_flash: 'qwen3-omni-flash-realtime',
        qwen_omni_turbo: 'qwen-omni-turbo-realtime',
        qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
      }
      const asrProvider = ASR_MODEL_ID_MAP[asrProviderKey] || asrProviderKey || 'cloud'
      const aiProvider = await getSetting('cloudAi.provider', '') as string
      const aiModel = await getSetting('cloudAi.model', '') as string
      return { asrProvider, aiProvider: aiProvider || undefined, aiModel: aiModel || undefined }
    }
    if (mode === 'local') {
      const modelId = await getSetting('localAsr.modelId', '') as string
      const aiEnabled = Boolean(await getSetting('aiEnabled', false))
      const aiProvider = aiEnabled ? await getSetting('cloudAi.provider', '') as string : undefined
      const aiModel = aiEnabled ? await getSetting('cloudAi.model', '') as string : undefined
      return { asrProvider: modelId || 'local', aiProvider, aiModel: aiModel || undefined }
    }
    return {}
  }

  private computeProcessingTimeoutMs(audioDurationSec: number) {
    return _computeProcessingTimeoutMs(audioDurationSec, this.provider.mode)
  }

  private consumeTimedOutProcessingContext() {
    if (!this.timedOutProcessingContext) return null
    const context = this.timedOutProcessingContext
    this.timedOutProcessingContext = null
    if (Date.now() - context.timedOutAt > LATE_FINAL_GRACE_MS) {
      return null
    }
    return context
  }

  private async processFinalResult(
    result: FinalResult,
    context: TimedOutProcessingContext,
    options: { allowInsertionWhenIdle: boolean; source: 'processing' | 'late_after_timeout' },
  ) {
    // 极速模式下 llmText === asrText（后端未经 LLM 处理时直接复制 asrText）
    // 此时文本可参与智能分段（是否分段由用户开关决定，见 applyTextTransforms）
    const needsSegment = !result.llmText || result.llmText === result.asrText
    const baseText = needsSegment ? result.asrText : result.llmText
    const textToPaste = await applyTextTransforms(baseText, { segmentable: needsSegment })
    const hasText = Boolean(textToPaste && textToPaste.trim())
    const audioDur = context.audioDurationSec
    const wallSec = context.wallTimeSec > 0 ? context.wallTimeSec : audioDur
    const promptResolution = context.promptResolution
    const appContext = context.appContext

    addRuntimeEvent('info', 'recorder', '收到 final', {
      hasText,
      asrMs: result.asrMs,
      llmMs: result.llmMs,
      durationSec: result.durationSec,
      audioSec: audioDur,
      textLen: textToPaste ? textToPaste.length : 0,
      source: options.source,
    })

    try {
      // Save audio file if we have recorded chunks
      let audioFilePath: string | undefined
      const recordId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const saveAudioEnabled = await getSetting('audioRetentionEnabled', true)
      if (saveAudioEnabled && this.recordedChunks.length > 0) {
        try {
          const savedPath = await saveRecordingAudio(recordId, this.recordedChunks)
          if (savedPath) audioFilePath = savedPath
        } catch (err) {
          addRuntimeEvent('warn', 'recorder', '保存音频文件失败', { error: String(err) })
        }
      }

      const providerMeta = await this.buildProviderMetadata(result)

      await addHistory({
        id: recordId,
        timestamp: Date.now(),
        asrText: result.asrText,
        llmText: textToPaste,
        asrMs: result.asrMs,
        llmMs: result.llmMs,
        durationSec: wallSec,
        audioDurationSec: audioDur > 0 ? audioDur : undefined,
        asrDurationSec: result.durationSec > 0 ? result.durationSec : undefined,
        charCount: hasText ? textToPaste.length : 0,
        isEmpty: !hasText,
        audioFilePath,
        ...this.buildHistoryMetadata(promptResolution),
        ...providerMeta,
      })
      void bridge.emit('history-updated')
    } catch (error) {
      addRuntimeEvent('warn', 'recorder', '写入历史记录失败', { error: String(error) })
    }

    if (!hasText) {
      if (this.state === 'processing') {
        // 结果为空（未检测到有效声音）：给一个明确的悬浮窗提示再收尾，
        // 而不是悄悄关闭让用户困惑。keepOverlay 让提示留到它自己的计时器隐藏。
        this.overlayService.showNoSpeech()
        this.resetToIdle({ keepOverlay: true })
      }
      return
    }

    void this.updatePersonalizationFromFinal(textToPaste, promptResolution, appContext)

    this.textInsertionInFlight = true
    void this.handleTextInsertion(textToPaste, { allowWhenIdle: options.allowInsertionWhenIdle }).finally(() => {
      this.textInsertionInFlight = false
    })
  }

  private async updatePersonalizationFromFinal(
    finalText: string,
    promptResolution: PromptResolution | null,
    appContext: ActiveAppContext | null,
  ) {
    if (!finalText.trim()) return

    try {
      const wordCount = finalText.length
      const appId = this.buildStatsAppId(appContext, promptResolution)

      this.cachedUserStats = await recordSessionStats(appId, wordCount)
      addRuntimeEvent('info', 'personalization', 'session stats recorded', {
        appId,
        appName: promptResolution?.appName,
        wordCount,
        totalWords: this.cachedUserStats.totalWords,
        totalSessions: this.cachedUserStats.totalSessions,
      })
    } catch (error) {
      addRuntimeEvent('warn', 'personalization', 'failed to record session stats', {
        error: String(error),
      })
    }
  }
}
