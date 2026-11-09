import { getLocale, t } from '@/i18n'
import * as bridge from '../bridge'
import { addRuntimeEvent } from '../debugLog'
import { getSetting } from '../store'
import { clampSec } from '../timeModel'
import {
  DEFAULT_CUSTOM_WAVE,
  normalizeCustomWave,
  normalizeWaveTheme,
  type CustomWaveColors,
} from '@/lib/overlayWaveColors'
import {
  formatRecordingLimit,
  OVERLAY_WIDTH_PRESETS,
  type OverlayCommonPayload,
  type OverlayWaveTheme,
  type OverlayWidthPreset,
} from './types'
import type { MicSourceMode } from './micSourceReminder'

type OverlayVisualState =
  | 'waiting'
  | 'listening'
  | 'thinking'
  | 'fallback'
  | 'failure'
  | 'error'
  | 'toast'

/**
 * 卡片快捷键/Esc 的续期间隔。
 *
 * 必须明显小于 Rust 侧的硬 TTL（卡片快捷键 20s、dismiss_fallback 30s）—— 那两个 TTL
 * 是异常兜底（渲染端卡死时不能永久吞用户的按键），不是正常生命周期。卡片现在不再
 * 自动消失，所以正常生命周期只能靠这里续。
 */
const CARD_KEEPALIVE_INTERVAL_MS = 8000

/** listening 补位定时器的间隔与阈值。取值原因见 startListeningTicker。 */
const LISTENING_TICKER_IDLE_MS = 250

/**
 * 失败卡的可见时长。
 *
 * 只有**失败卡**能自动收起：它里面没有需要交付给用户的东西，只有一条原因和一个
 * 操作机会，看过就没用了。
 *
 * 结果卡刻意没有这个上限 —— 里面那段文字此刻既不在输入框、也不在剪贴板（不可编辑
 * 那条路不提前改写剪贴板），关了历史的用户更是连别处都没有。任何"到时自动隐藏"都
 * 等于把"文本还没交付"当成"通知已读"：用户离开几分钟回来，文字就没了。它的收场只
 * 有三条：Esc / 点关闭 / 开始下一次口述。
 */
/**
 * 失败卡自动收起的时间。
 *
 * 5 秒，不按内容长短分档。这张卡不需要承担"必须被读到"的责任 —— 录音已经在历史记录里，
 * 原因也在日志里，错过了不丢任何东西（结果卡不一样，那上面的文字只此一份，所以它
 * 不自动消失，见 showFallback）。原先是 60 秒，实测用户是手动关掉的，等于把一条
 * 通知做成了待办事项。
 */
const FAILURE_CARD_VISIBLE_MS = 5 * 1000

/** 失败卡的恢复提示：音频到底有没有存下来，只能由实际存档结果决定。 */
export type FailureRecovery = 'unknown' | 'history' | 'none'

interface MicSourceHint {
  mode: MicSourceMode
  label: string
}

const MIC_SOURCE_HINT_DURATION_MS = 3000

function normalizeWidthPreset(value: unknown): OverlayWidthPreset {
  if (value === 'short' || value === 'medium' || value === 'long') return value
  return 'long'
}

export class OverlayService {
  private theme: OverlayWaveTheme = 'black-rainbow'
  private customWave: CustomWaveColors = DEFAULT_CUSTOM_WAVE
  private showDuration = true
  private readySoundEnabled = true
  private widthPreset: OverlayWidthPreset = 'medium'
  private lastFrameAt = 0
  private tickerId: ReturnType<typeof setInterval> | null = null
  private fallbackHideId: ReturnType<typeof setTimeout> | null = null
  /** Persistent warning text — included in every overlay update until cleared */
  private activeWarning = ''
  private timeoutWarningHideId: ReturnType<typeof setTimeout> | null = null
  /** 流式实时识别文本 — 录音期间随中间结果更新，会被并入每次 listening 更新一起下发 */
  private streamingText = ''
  /** 本次录音是否开启流式实时显示：为真则从录音一开始就显示气泡（占位），中途不再缩放窗口 */
  private streamingActive = false
  private currentState: OverlayVisualState = 'waiting'
  /**
   * 当前失败卡的标题与原因。
   *
   * 存着它只为一件事：`updateFailureRecovery` 发送时把这两个字段**重新带上**。
   * 原生侧的 `update_overlay_state` 是**整份替换** `latest_overlay_payload`，不是合并
   * （见 window/mod.rs）。所以只发 `{ state, failureRecovery }` 的话，那份"最近状态"
   * 底稿会被换成一份没有标题、没有原因的残缺 payload —— 而界面此刻看起来完全正常，
   * 因为渲染端是合并语义（没传的字段保留上一次的值）。
   *
   * 残缺只在**有人重放底稿**时暴露：overlay 重挂后 `overlay_ready` 会重放最近状态，
   * 健康恢复与 ack 超时重发也会。实测 2026-09-23：overlay 因整页重载重挂，重放到
   * 这份残缺 payload，卡片显示成「出错了」+「录音已保存」，标题落到兜底文案、
   * 原因整行消失（内容高度从 125.33 掉到 81.33）。
   *
   * 为什么不去改原生那侧的替换语义：录音中的 listening 更新在不流式时**不带**
   * `streaming` 字段，改成合并的话它会残留在底稿里，重放时悬浮窗会画出实时字幕气泡、
   * 窗口也跟着变大 —— 那是 pitfalls 30 那一族，代价比这里大得多。
   */
  private activeFailureCard: { title: string; detail: string } | null = null

  private activeMicSourceHint: MicSourceHint | null = null
  private micSourceHintHideId: ReturnType<typeof setTimeout> | null = null
  private micSourceHintGeneration = 0
  /** 常驻卡片的按键续期定时器；卡片一消失必须停掉，否则会替别人续期。 */
  private cardKeepAliveId: ReturnType<typeof setInterval> | null = null
  private activeCardToken = 0
  private activeCardHotkeys: bridge.CardHotkeyAction[] = []
  private activeCardEscapeMode: bridge.EscapeActionMode = 'off'

  constructor(private readonly getElapsedSec: () => number) { }

  async refreshSettings() {
    this.theme = normalizeWaveTheme(await getSetting('overlayWaveTheme', 'black-rainbow'), 'black-blue')
    this.customWave = normalizeCustomWave(await getSetting('overlayWaveCustom', DEFAULT_CUSTOM_WAVE))
    this.showDuration = Boolean(await getSetting('overlayShowDuration', true))
    this.readySoundEnabled = Boolean(await getSetting('readySoundEnabled', true))
    this.widthPreset = normalizeWidthPreset(await getSetting('overlayWidth', 'medium'))
  }

  private readySoundCtx: AudioContext | null = null
  private readyTonesPlaying = 0

  private playReadySound() {
    if (!this.readySoundEnabled) return
    try {
      if (!this.readySoundCtx || this.readySoundCtx.state === 'closed') {
        this.readySoundCtx = new AudioContext()
      }
      const ctx = this.readySoundCtx
      // AudioContext 新建或长时间无操作后常处于 suspended 状态（浏览器自动播放/省电策略）。
      // resume() 是异步的，若不等它完成就 start()，振荡器可能被静默丢弃或延迟——
      // 这正是「第一次按免提键听不到提示音，过一会又听不到」的根因。
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => this.emitReadyTone(ctx)).catch(() => { /* ignore */ })
      } else {
        this.emitReadyTone(ctx)
      }
    } catch { /* ignore */ }
  }

  private emitReadyTone(ctx: AudioContext) {
    try {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 880
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.2, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.15)
      // 播完就把 AudioContext 挂起。一个处于 running 的 AudioContext 哪怕什么都不播，
      // 渲染进程和音频服务进程也会每 10ms 跑一次音频图：2026-10 实测空闲 20 秒多耗约 360ms CPU
      // （约 1.8% 个核），而且从第一次录音起一直耗到退出 —— 正式版「用久了空闲 CPU 变高」就是它。
      // 下次播放前 playReadySound 会先 resume。计数是为了上一声没播完时别把下一声掐掉。
      this.readyTonesPlaying++
      osc.onended = () => {
        this.readyTonesPlaying = Math.max(0, this.readyTonesPlaying - 1)
        if (this.readyTonesPlaying === 0 && ctx.state === 'running') {
          ctx.suspend().catch(() => { /* ignore */ })
        }
      }
    } catch { /* ignore */ }
  }

  getCommonPayload(): OverlayCommonPayload {
    const cfg = OVERLAY_WIDTH_PRESETS[this.widthPreset]
    return {
      theme: this.theme,
      customWave: this.customWave,
      showDuration: this.showDuration,
      baseWidth: cfg.windowWidth,
      barCount: cfg.barCount,
      // 每次都带上：悬浮窗可能在语言切换之后才第一次创建，没有"只发一次"的时机。
      locale: getLocale(),
    }
  }

  getBarCount(): number {
    return OVERLAY_WIDTH_PRESETS[this.widthPreset].barCount
  }

  private setEscapeMode(mode: bridge.EscapeActionMode, token = 0) {
    void bridge.setEscapeActionMode(mode, token).catch(() => { /* 原生钩子不可用时不影响悬浮窗 */ })
  }

  /**
   * 切换到一个**非卡片**状态：顺手结束上一张卡片的按键接管。
   *
   * 所有短暂状态都必须走这里，不要直接调 setEscapeMode —— 否则卡片还在续期（它的
   * 定时器每 8 秒把 Esc/Ctrl+C 重新注册一次），会把新状态刚设好的模式覆盖掉，
   * 表现为"新录音开始了，Esc 却还在关那张已经不存在的卡片"。
   */
  private enterTransientState(mode: bridge.EscapeActionMode, token = 0) {
    this.stopCardKeepAlive()
    this.setEscapeMode(mode, token)
  }

  /**
   * 失败卡的标题与原因。**每一次 failure 状态的下发都必须带上它**（present 和 update
   * 都算），理由见 activeFailureCard 上的注释。不要在调用点手写这两个字段。
   */
  private failureCardPayload() {
    return {
      failureTitle: this.activeFailureCard?.title ?? '',
      failureDetail: this.activeFailureCard?.detail ?? '',
    }
  }

  private getMicSourceHintPayload() {
    return this.activeMicSourceHint
      ? {
        micSourceMode: this.activeMicSourceHint.mode,
        micSourceLabel: this.activeMicSourceHint.label,
      }
      : {
        micSourceMode: null,
        micSourceLabel: '',
      }
  }

  /**
   * 构造一次 listening 状态更新。**所有 listening 出口都必须走这里**，不要再手写字面量。
   *
   * 原因：`streaming` 是原生侧判断悬浮窗布局的唯一依据（window/mod.rs 的
   * apply_payload_layout）。任何一次 listening 更新漏带它，窗口就会当场从流式尺寸
   * （480×200 CSS px）收缩回基础尺寸，再被 33ms 后的下一帧心跳撑回去 —— 而 webview 里的
   * DOM 完全没变，于是气泡被 overlay.html 的 overflow:hidden 裁掉一帧。用户看到的就是
   * 「开着实时字幕、不说话时悬浮窗每 5 秒闪一下」（5s 是低音量警告的重弹节拍，见
   * RecorderOrchestrator.updateVolumeWarning 的 REWARN_MS）。
   *
   * 这个坑之所以值得抽一个方法：五个警告方法各自手写了一份 payload，五份全漏了这个字段，
   * 而漏掉它既不报错也不进日志（原生侧的 resize 路径一行日志都不写）。
   */
  private listeningPayload(overrides: Record<string, unknown> = {}) {
    return {
      state: 'listening',
      elapsedSec: clampSec(this.getElapsedSec()),
      ...(this.activeWarning ? { warning: this.activeWarning } : {}),
      ...(this.streamingActive ? { streaming: true } : {}),
      ...(this.streamingText ? { streamingText: this.streamingText } : {}),
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
      ...overrides,
    }
  }

  private clearMicSourceHint() {
    this.micSourceHintGeneration++
    if (this.micSourceHintHideId) {
      clearTimeout(this.micSourceHintHideId)
      this.micSourceHintHideId = null
    }
    this.activeMicSourceHint = null
  }

  /** Briefly confirm the actual input route after a successful microphone open. */
  showMicSourceHint(hint: MicSourceHint) {
    this.clearMicSourceHint()
    this.activeMicSourceHint = hint
    const generation = this.micSourceHintGeneration

    void bridge.updateOverlay(this.listeningPayload({ state: this.currentState }))

    this.micSourceHintHideId = setTimeout(() => {
      if (generation !== this.micSourceHintGeneration) return
      this.micSourceHintHideId = null
      this.activeMicSourceHint = null
      void bridge.updateOverlay(this.listeningPayload({ state: this.currentState }))
    }, MIC_SOURCE_HINT_DURATION_MS)
  }

  /** 文本即将进入不可逆的系统粘贴阶段；先关闭全局 Esc 取消，避免“已取消”后仍完成粘贴。 */
  async disableEscapeAction(): Promise<void> {
    // 同时解除卡片按键接管：粘贴一旦开始就不该再有任何悬浮窗快捷键生效。
    this.stopCardKeepAlive()
    try {
      await bridge.setEscapeActionMode('off', 0)
    } catch { /* 原生钩子不可用时不影响文本插入 */ }
  }

  showWaiting() {
    this.currentState = 'waiting'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    this.clearFallbackHideTimer()
    void bridge.presentOverlay({
      state: 'waiting',
      elapsedSec: 0,
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
    })
  }

  startListeningTicker(token = 0) {
    this.currentState = 'listening'
    this.stopListeningTicker()
    // 真实录音代次才开启全局 Esc；PTT Lab 等 token=0 的预览绝不吞系统按键。
    this.enterTransientState(token > 0 ? 'cancel_recording' : 'off', token)
    this.playReadySound()
    // 采集链路已经成功启动时立刻发布 listening；不要再为 ticker 的首个 33ms
    // 人为保留 waiting。PCM 随后仍通过 pushListeningBars 驱动真实波形。
    this.pushListeningBars(undefined, true)
    // 有 PCM 时波形那一路（pushListeningBars）已经按 33ms 带着计时和流式文本在发了，
    // 这里只在很久没人发过时补位（采集卡住、还没收到第一帧）。原来两路各自 33ms，
    // 合起来每秒约 60 次 IPC 和 60 次悬浮窗重渲染，画面却只需要 30 帧。
    //
    // 补位阈值必须明显大于波形那一路的 33ms 节流：两者共用 lastFrameAt，阈值若也是 33ms，
    // 这个 33ms 的定时器每轮都刚好过线、先把名额拿走，而它发的帧不带 bars，
    // 波形帧全被节流丢掉（0.2.3 悬浮窗波形掉帧，issue #90）。
    // 补位只为推进秒表（一秒才变一次），250ms 足够；间隔同步放大，免得每秒空转 30 次。
    this.tickerId = setInterval(() => {
      const now = Date.now()
      if (now - this.lastFrameAt < LISTENING_TICKER_IDLE_MS) return
      this.lastFrameAt = now
      void bridge.updateOverlay(this.listeningPayload())
    }, LISTENING_TICKER_IDLE_MS)
  }

  /** 设置本次录音是否开启流式实时显示（录音开始时调用）。开启后气泡从一开始就显示占位。 */
  setStreamingActive(on: boolean) {
    this.streamingActive = on
  }

  /** 更新流式实时识别文本。下一次 listening 心跳（33ms）会把它带给悬浮窗一起渲染。
   *  传空字符串可清除气泡。 */
  setStreamingText(text: string) {
    this.streamingText = text || ''
  }

  /** 清除流式实时文本与激活标志（录音停止 / 重置时调用）。 */
  resetStreamingText() {
    this.streamingText = ''
    this.streamingActive = false
  }

  stopListeningTicker() {
    if (this.tickerId) {
      clearInterval(this.tickerId)
      this.tickerId = null
    }
  }

  pushListeningBars(bars?: number[], force = false) {
    const now = Date.now()
    if (!force && now - this.lastFrameAt < 33) return
    this.lastFrameAt = now
    void bridge.updateOverlay(this.listeningPayload({ bars }))
  }

  /**
   * @param options.ai 这次处理会走 AI 整理（按本次的 aiPolicy.allowCall，不按开关：
   *   开关开着但录音短于门槛时并不整理，那时显示「AI 整理中」就是假的）。
   */
  showThinking(elapsedSec: number, token = 0, options: { ai?: boolean } = {}) {
    this.currentState = 'thinking'
    // PTT Lab 也复用 thinking 动画，但没有真实录音代次；token=0 时只显示，绝不吞全局 Esc。
    this.enterTransientState(token > 0 ? 'cancel_processing' : 'off', token)
    void bridge.updateOverlay({
      state: 'thinking',
      ...(options.ai && { thinkingAi: true }),
      elapsedSec: clampSec(elapsedSec),
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
    })
  }

  /**
   * 即将到达单次上限的提示。**一闪即走**，之后由计时区的倒计时持续告知剩余时间。
   *
   * 以前这条是常驻到录音结束的，加上 Overlay 里"有警告就不显示计时"的条件，
   * 导致最后一整分钟只剩一句「单次记录最长300s」，既不知道已录多久、也不知道还剩多久。
   */
  showTimeoutWarning() {
    const text = t('overlay.warnMaxDuration', { limit: formatRecordingLimit() })
    this.activeWarning = text
    void bridge.updateOverlay(this.listeningPayload({ warning: text, warningTone: 'warn' }))

    if (this.timeoutWarningHideId) clearTimeout(this.timeoutWarningHideId)
    this.timeoutWarningHideId = setTimeout(() => {
      this.timeoutWarningHideId = null
      // 期间若被更高优先级的警告（如麦克风被静音）取代，就不要抢回来
      if (this.activeWarning !== text) return
      this.activeWarning = ''
      void bridge.updateOverlay(this.listeningPayload({ warning: '', warningTone: 'warn' }))
    }, 4000)
  }

  /** Show low volume warning on the overlay（有声音但偏低：请靠近麦克风，琥珀色） */
  showLowVolumeWarning() {
    if (this.activeWarning) return
    void bridge.updateOverlay(this.listeningPayload({
      warning: t('overlay.warnLowVolume'),
      warningTone: 'warn',
    }))
  }

  /** Show "no signal detected" warning（持续无输入意味着设备不可用，使用红色高警）。
   *  打开的是虚拟声卡时直接说出来：「未检测到声音」会把人引去查麦克风线和静音键，
   *  而真正要做的是换设备。 */
  showNoSignalWarning(options: { virtualMic?: boolean } = {}) {
    if (this.activeWarning) return
    void bridge.updateOverlay(this.listeningPayload({
      warning: t(options.virtualMic ? 'overlay.warnNoSignalVirtual' : 'overlay.warnNoSignal'),
      warningTone: 'error',
    }))
  }

  /** Show "mic is muted" high-alert（系统层面确认被静音：红色高警） */
  showMicMutedAlert() {
    if (this.activeWarning) return
    void bridge.updateOverlay(this.listeningPayload({
      warning: t('overlay.warnMicMuted'),
      warningTone: 'error',
    }))
  }

  /** Clear transient warnings (low volume etc.) — does NOT clear timeout warning */
  clearWarning() {
    if (this.activeWarning) return
    void bridge.updateOverlay(this.listeningPayload({ warning: '', warningTone: 'warn' }))
  }

  /**
   * 是否有常驻（sticky）警告正在挡住临时警告的显示/清除。
   * 排查"低音量提示不消失/不出现"这类问题时很有用：那类症状多半就是被它挡着。
   */
  hasStickyWarning() {
    return !!this.activeWarning
  }

  /** Reset all warnings including persistent ones (called on recording stop/reset) */
  resetWarnings() {
    if (this.timeoutWarningHideId) {
      clearTimeout(this.timeoutWarningHideId)
      this.timeoutWarningHideId = null
    }
    this.activeWarning = ''
  }

  /**
   * 目标窗口收不下文本时的结果卡：显示识别结果，用户自己取走。
   *
   * **不自动消失**（2026-09 改）。原先 10 秒就隐藏，等于把"文本还没交付"当成
   * "通知已读"：用户去够鼠标的时间里卡片就没了，文字也跟着没了（那时剪贴板里
   * 也没有它——不可编辑那条路刻意不提前改写剪贴板）。现在靠 Esc / 关闭按钮 /
   * Ctrl+C 显式收场，只有 CARD_MAX_VISIBLE_MS 作为最终安全网。
   */
  showFallback(text: string, reason: string, token = 0) {
    this.currentState = 'fallback'
    this.clearMicSourceHint()
    addRuntimeEvent('info', 'overlay', 'Showing result card', {
      reason,
      textLen: text.length,
      token,
    })
    void bridge.presentOverlay({
      state: 'fallback',
      fallbackText: text,
      fallbackReason: reason,
      cardToken: token,
      ...this.getCommonPayload(),
    })
    // token=0 的 PTT Lab 预览没有 Orchestrator 代次，不能开启无人消费的全局按键接管。
    this.beginCardLifecycle(token, 'dismiss_fallback', text ? ['copy'] : [], { autoHide: false })
  }

  /**
   * 识别失败（而不是"没插进去"）时的卡片。
   *
   * 与结果卡的区别：没有文本可交付，只有一条原因和一个关闭按钮，所以不注册 Ctrl+C。
   * `recovery` 决定要不要告诉用户"可以去历史记录重新识别" —— 它必须来自**实际存档
   * 结果**，不能靠设置开关猜：历史关着、录音保留关着、写盘失败，任何一条都会让
   * 那句话变成空头承诺。拿不到结论时传 'unknown'，界面就什么都不承诺。
   */
  showFailure(params: {
    title: string
    detail?: string
    recovery: FailureRecovery
    token?: number
  }) {
    const token = params.token ?? 0
    this.currentState = 'failure'
    this.clearMicSourceHint()
    this.activeFailureCard = { title: params.title, detail: params.detail || '' }
    addRuntimeEvent('warn', 'overlay', 'Showing failure card', {
      title: params.title,
      recovery: params.recovery,
      token,
    })
    void bridge.presentOverlay({
      state: 'failure',
      ...this.failureCardPayload(),
      failureRecovery: params.recovery,
      cardToken: token,
      ...this.getCommonPayload(),
    })
    // 失败卡里没有需要交付给用户的内容，只有一条原因和一个操作机会，所以允许自动收起。
    this.beginCardLifecycle(token, 'dismiss_fallback', [], { autoHide: true })
  }

  /**
   * 失败卡已经显示之后，音频存档才有结论 —— 就地把那句恢复提示补上。
   *
   * 为什么要分两步：提示必须在失败的**那一刻**出现（用户正盯着屏幕等结果），而
   * 存档是异步的，最长可能等 30 秒（AUDIO_ARCHIVE_WAIT_MS）。宁可先说"失败了"、
   * 稍后再补"录音留下了"，也不要为了凑齐一句完整的话让用户先干等半分钟。
   */
  updateFailureRecovery(recovery: FailureRecovery, token: number) {
    if (this.currentState !== 'failure') return
    if (token !== this.activeCardToken) return
    void bridge.updateOverlay({
      state: 'failure',
      // 标题和原因必须**每次都重发**，见 failureCardPayload 上的注释。
      ...this.failureCardPayload(),
      failureRecovery: recovery,
      ...this.getCommonPayload(),
    })
  }

  /**
   * 处理已超时，但还在宽限期里等迟到结果。
   *
   * 这一步以前是**完全静默**的：悬浮窗直接消失，而 15 秒内迟到的 final 仍会自动
   * 插字。用户看到的是"什么都没发生，然后文字忽然出现"。现在明确告知仍在等待，
   * 并且给 Esc 一个放弃的机会（放弃后迟到结果不再插字）。
   */
  showAwaitingLateResult(graceSec: number, token: number) {
    this.currentState = 'thinking'
    this.clearMicSourceHint()
    this.enterTransientState(token > 0 ? 'abandon_late_result' : 'off', token)
    void bridge.presentOverlay({
      state: 'thinking',
      thinkingNote: 'late',
      elapsedSec: clampSec(graceSec),
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
  }

  /**
   * 进入一张常驻卡片的生命周期：注册按键接管，并在可见期间周期性续期。
   *
   * Rust 侧那两个 TTL 是异常兜底，不是正常生命周期（见 CARD_KEEPALIVE_INTERVAL_MS）。
   * 卡片既然不再自动消失，就必须由这里持续证明"我还在"。
   */
  private beginCardLifecycle(
    token: number,
    escapeMode: bridge.EscapeActionMode,
    hotkeys: bridge.CardHotkeyAction[],
    options: { autoHide: boolean },
  ) {
    this.stopCardKeepAlive()
    this.activeCardToken = token
    this.activeCardHotkeys = token > 0 ? hotkeys : []
    this.activeCardEscapeMode = token > 0 ? escapeMode : 'off'

    this.setEscapeMode(this.activeCardEscapeMode, token)
    this.setCardHotkeys(this.activeCardHotkeys, token)

    if (token > 0) {
      this.cardKeepAliveId = setInterval(() => {
        this.setEscapeMode(this.activeCardEscapeMode, this.activeCardToken)
        this.setCardHotkeys(this.activeCardHotkeys, this.activeCardToken)
      }, CARD_KEEPALIVE_INTERVAL_MS)
    }

    this.clearFallbackHideTimer()
    if (options.autoHide) {
      this.fallbackHideId = setTimeout(() => {
        addRuntimeEvent('info', 'overlay', 'Card hit its visible time limit; hiding', {
          token,
          visibleMs: FAILURE_CARD_VISIBLE_MS,
        })
        this.hide()
      }, FAILURE_CARD_VISIBLE_MS)
    }
  }

  /**
   * 悬浮窗那边自己收起了卡片（点关闭按钮、或复制完成后自动收起）。
   *
   * 卡片的生命周期归这里管，悬浮窗只是渲染端。不收到这个通知的话，续期定时器会在
   * 8 秒后把 Esc / Ctrl+C 重新注册一遍 —— 卡片早已不在，用户的按键却还被接管，
   * 而且原生侧会重新抓一次前台窗口（那时可能已经是别的程序）。
   */
  noteCardDismissed(token: number) {
    if (token !== this.activeCardToken) {
      addRuntimeEvent('info', 'overlay', 'Ignored a dismissal for a card that is no longer active', {
        token,
        activeCardToken: this.activeCardToken,
      })
      return
    }
    this.currentState = 'toast'
    this.clearFallbackHideTimer()
    // 这里**不**再调 hideOverlay：悬浮窗自己已经隐藏了，重复下发只会多一次 IPC。
    this.enterTransientState('off', 0)
  }

  private stopCardKeepAlive() {
    if (this.cardKeepAliveId) {
      clearInterval(this.cardKeepAliveId)
      this.cardKeepAliveId = null
    }
    if (this.activeCardHotkeys.length > 0) {
      this.setCardHotkeys([], 0)
    }
    this.activeCardToken = 0
    this.activeCardHotkeys = []
    this.activeCardEscapeMode = 'off'
  }

  private setCardHotkeys(actions: bridge.CardHotkeyAction[], token: number) {
    void bridge.setCardHotkeys(actions, token).catch(() => { /* 原生钩子不可用时不影响卡片 */ })
  }

  clearFallbackHideTimer() {
    if (this.fallbackHideId) {
      clearTimeout(this.fallbackHideId)
      this.fallbackHideId = null
    }
  }

  hide() {
    this.clearMicSourceHint()
    // 卡片没了，标题和原因就不该再被任何一次下发带出去。
    this.activeFailureCard = null
    this.clearFallbackHideTimer()
    // enterTransientState 内部会解除卡片的按键接管并停掉续期定时器。
    this.enterTransientState('off', 0)
    void bridge.hideOverlay()
  }

  /** 快捷键切换润色模式后，用悬浮窗短暂提示当前模式名，约 1.6s 后自动隐藏。 */
  showPresetSwitched(name: string) {
    this.currentState = 'toast'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      toastText: t('overlay.toastPresetSwitched', { name }),
      toastTone: 'info',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 1600)
  }

  /** 全局快捷键切换 AI 整理后的轻量确认，不打断正在录音的状态。 */
  showAiCleanupToggled(enabled: boolean) {
    this.currentState = 'toast'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      toastText: t(enabled ? 'overlay.toastAiCleanupOn' : 'overlay.toastAiCleanupOff'),
      toastTone: 'info',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 1400)
  }

  /**
   * 识别结果为空（未检测到有效声音）时的提示。
   *
   * `diagnostic` 由调用方补充成因上下文。日志刻意放在这里、而不是各个调用点：
   * 这句提示是全软件最容易被误读的一条 —— 真实成因可能是用户没说话、供应商额度
   * 耗尽、服务端提前断开、文本后处理失败，用户看到的却是同一句话。放在这个唯一
   * 出口，就保证「用户看到这句」和「日志里有记录」永远一一对应，不会因为将来
   * 新增一个调用点而漏掉。
   */
  /**
   * 识别没出文字时的短提示。两种成因共用这一条路，**都不弹失败卡**。
   *
   * - `'silent'`：采集侧有近静音实证，确实没人说话。
   * - `'no_text'`：录到了声音，但识别没返回任何文字。
   *
   * 为什么 `'no_text'` 也只给 toast：原先拿采集侧峰值（> 0.01）区分「没说话」和
   * 「调用失败」，这个判据两头都穿。实测日志里连着三次都是什么都没说，一次弹了失败卡
   * 两次只弹 toast，差别仅仅是底噪峰值（0.019 / 0.0001 / 0.0015）—— 一次呼吸、碰一下
   * 桌子就能超过 0.01；反过来额度耗尽同样会返回空文本、峰值却很低。用它当判据只会
   * 让同一个动作时而弹卡片时而不弹。
   *
   * 真正的故障都有各自的路径（连接断开 / stop 发不出去 / 处理超时 / 后处理把文字清空），
   * 失败卡留给那几条。
   */
  showNoSpeech(reason: 'silent' | 'no_text', diagnostic?: Record<string, unknown>) {
    this.currentState = 'toast'
    this.clearMicSourceHint()
    addRuntimeEvent('warn', 'recorder', 'Showing no-speech warning', { ...(diagnostic ?? {}), reason })
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      // 'no_text' 不说「未检测到有效声音」：声音是收到了，那句话会把用户直接引去查麦克风。
      toastText: t(reason === 'silent' ? 'overlay.toastNoSpeech' : 'overlay.toastNoText'),
      toastTone: 'warn',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 1500)
  }

  /** 用户主动取消处理后的短提示。 */
  showCanceled() {
    this.currentState = 'toast'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      toastText: t('overlay.toastCanceled'),
      toastTone: 'info',
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 900)
  }

  /** 显示错误信息，几秒后自动隐藏 */
  showError(message: string) {
    this.currentState = 'error'
    this.clearMicSourceHint()
    this.enterTransientState('off', 0)
    void bridge.presentOverlay({
      state: 'error',
      errorMessage: message,
      ...this.getCommonPayload(),
    })
    this.clearFallbackHideTimer()
    this.fallbackHideId = setTimeout(() => this.hide(), 4000)
  }

  dispose() {
    this.stopListeningTicker()
    this.resetStreamingText()
    this.hide()
  }
}
