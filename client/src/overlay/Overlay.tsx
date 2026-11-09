import * as bridge from '../services/bridge'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlertCircle, Copy, MicVocal, Sparkles, X } from 'lucide-react'
import { SuccessCheck } from '@/components/ui/success-check'
import { isLocale, setLocale } from '@/i18n'
import { useT } from '@/i18n/useT'
import { addRuntimeEvent } from '../services/debugLog'
import { formatRecordingTimer } from '../services/recorder/types'
import { IS_MAC } from '@/lib/platform'
import {
  buildWavePalette,
  DEFAULT_CUSTOM_WAVE,
  getWaveThinkingColor,
  getWaveTimerColor,
  normalizeCustomWave,
  normalizeWaveTheme,
  sameCustomWave,
  type CustomWaveColors,
  type OverlayWaveTheme,
} from '@/lib/overlayWaveColors'
import { prefersReducedMotion, usePillMorph } from './pillMorph'

/**
 * `blank` 什么都不渲染，只在**隐藏窗口之前**用一下。
 *
 * 为什么需要它：隐藏悬浮窗只是 `overlay.hide()`，WebView 不销毁、这个组件也不卸载，
 * 所以合成器里留着的最后一帧就是上一条提示。下次 present 时原生窗口先显示出来、
 * 新内容要等 IPC + setState + 重绘才到，那一瞬间用户看到的是**上一次的文案**
 * （用户报的就是这个：切换润色模式后再按开关 AI 整理，悬浮窗先闪一下旧提示）。
 *
 * 于是隐藏时先发一帧 blank —— 那一刻窗口还看得见，重绘是确定会发生的（窗口一旦隐藏
 * 就没这个保证了，rAF 会被节流）。留在合成器里的最后一帧因此是空的，下次显示无从可闪。
 * 视觉上没有代价：blank 连胶囊底色都不画，看起来就是"提示消失了"，本来隐藏就是这个样子。
 */
type OverlayState =
  | 'blank'
  | 'waiting'
  | 'listening'
  | 'thinking'
  | 'fallback'
  | 'failure'
  | 'error'
  | 'toast'
/** 失败卡上那句恢复提示：只有确实存下来了才敢说"可以重新识别"。 */
type FailureRecovery = 'unknown' | 'history' | 'none'
type RecordingVisualPhase = 'preparing' | 'listening'
interface OverlayPayload {
  state?: OverlayState
  bars?: number[]
  elapsedSec?: number
  theme?: OverlayWaveTheme
  customWave?: CustomWaveColors
  showDuration?: boolean
  barCount?: number
  fallbackText?: string
  fallbackReason?: string
  failureTitle?: string
  failureDetail?: string
  failureRecovery?: FailureRecovery
  /** 这张卡片对应的录音代次。按键事件与关闭回报都要带上它做代次校验。 */
  cardToken?: number
  /** thinking 的变体：'late' = 已超时、仍在宽限期里等迟到结果。 */
  thinkingNote?: 'late'
  /** thinking 时这次会走 AI 整理：文字换成「AI 整理中」并带星芒图标。 */
  thinkingAi?: boolean
  errorMessage?: string
  warning?: string
  /** warning 的严重级别：warn=琥珀（声音小/未检测到），error=红色高警（麦克风已被静音） */
  warningTone?: 'warn' | 'error'
  toastText?: string
  /** toast 的语气：info=中性（如切换预设），warn=琥珀色+图标（如未检测到声音） */
  toastTone?: 'info' | 'warn'
  streaming?: boolean
  streamingText?: string
  micSourceMode?: 'auto' | 'fixed' | null
  micSourceLabel?: string
  /** 界面语言，由主窗随每次更新下发（见 OverlayCommonPayload.locale）。 */
  locale?: string
  _overlayShowId?: number
  _overlayGeneration?: number
  _overlayProbe?: boolean
}

const DEFAULT_BAR_COUNT = 24
const IDLE_BARS = Array(DEFAULT_BAR_COUNT).fill(3)


export default function Overlay() {
  const t = useT()
  // 初始 blank 而不是 waiting：这个页面会被**预热**（提前建好 WebView 并保持隐藏），
  // 首个状态事件到达之前它就已经画过一帧了。默认 waiting 的话那一帧是"准备中"胶囊，
  // 于是第一次真正显示悬浮窗时会先闪一下它 —— 和隐藏后残留旧提示是同一个毛病。
  // 没有状态就什么都不画，才是诚实的。
  const [state, setState] = useState<OverlayState>('blank')
  const [recordingVisualPhase, setRecordingVisualPhase] = useState<RecordingVisualPhase>('preparing')
  const [bars, setBars] = useState<number[]>(IDLE_BARS)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [theme, setTheme] = useState<OverlayWaveTheme>('black-blue')
  const [customWave, setCustomWave] = useState<CustomWaveColors>(DEFAULT_CUSTOM_WAVE)
  const [showDuration, setShowDuration] = useState(true)
  const [barCount, setBarCount] = useState(DEFAULT_BAR_COUNT)
  const [presentationId, setPresentationId] = useState(0)
  const [fallbackText, setFallbackText] = useState('')
  const [failureTitle, setFailureTitle] = useState('')
  const [failureDetail, setFailureDetail] = useState('')
  const [failureRecovery, setFailureRecovery] = useState<FailureRecovery>('unknown')
  const [cardToken, setCardToken] = useState(0)
  const [fallbackReason, setFallbackReason] = useState('')
  const [thinkingNote, setThinkingNote] = useState<'late' | null>(null)
  const [thinkingAi, setThinkingAi] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [toastText, setToastText] = useState('')
  const [toastTone, setToastTone] = useState<'info' | 'warn'>('info')
  const [streamingText, setStreamingText] = useState('')
  const [streamingOn, setStreamingOn] = useState(false)
  const [copied, setCopied] = useState(false)
  const [thinkingDuration, setThinkingDuration] = useState(0)
  const [warning, setWarning] = useState('')
  const [warningTone, setWarningTone] = useState<'warn' | 'error'>('warn')
  const [micSourceMode, setMicSourceMode] = useState<'auto' | 'fixed' | null>(null)
  const [micSourceLabel, setMicSourceLabel] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const pillRef = useRef<HTMLDivElement | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 给 Ctrl+C 用的当前卡片快照。
   *
   * 原生钩子发来的 card-hotkey 事件在 effect 里处理，而那个 effect 只跑一次（[]），
   * 拿不到后续的 state。用 ref 镜像一份，同时带上 presentationId —— 旧卡片的事件
   * （来自上一次显示）必须丢掉，不能拿新卡片的文本去响应。
   */
  const cardRef = useRef<{
    presentationId: number
    state: OverlayState
    text: string
    token: number
  }>({
    presentationId: 0,
    state: 'blank',
    text: '',
    token: 0,
  })
  const preparingPaintFrameRef = useRef<number | null>(null)
  const pendingListeningVisualRef = useRef(false)
  const elapsedSecRef = useRef(0)

  // 根据录音时长计算预估处理时间（秒）
  const calculateThinkingDuration = (recordingSec: number): number => {
    if (recordingSec <= 5) return 2
    if (recordingSec <= 15) return 3
    if (recordingSec <= 30) return 4
    if (recordingSec <= 60) return 5
    if (recordingSec <= 120) return 7
    if (recordingSec <= 180) return 9
    if (recordingSec <= 240) return 11
    return 13 // 240秒以上（4-5分钟）
  }

  useEffect(() => {
    let disposed = false
    let removeOverlayListener: (() => void) | null = null

    const cancelPreparingPaint = () => {
      if (preparingPaintFrameRef.current !== null) {
        cancelAnimationFrame(preparingPaintFrameRef.current)
        preparingPaintFrameRef.current = null
      }
    }

    const beginPreparingVisual = () => {
      cancelPreparingPaint()
      pendingListeningVisualRef.current = false
      setRecordingVisualPhase('preparing')
      // listening 可能在 WebView 的首帧之前就到达。跨两个 rAF 才放行视觉切换，
      // 保证准备胶囊至少真正绘制一帧；只延后视觉形变，不延后录音采集。
      preparingPaintFrameRef.current = requestAnimationFrame(() => {
        preparingPaintFrameRef.current = requestAnimationFrame(() => {
          preparingPaintFrameRef.current = null
          if (disposed || !pendingListeningVisualRef.current) return
          pendingListeningVisualRef.current = false
          setRecordingVisualPhase('listening')
        })
      })
    }

    const handleOverlayState = (data: unknown) => {
      const payload = data as OverlayPayload
      if (typeof payload._overlayShowId === 'number') setPresentationId(payload._overlayShowId)
      // 语言先落地再渲染本帧：悬浮窗没有自己的初始化时机，语言只能随 payload 来。
      // setLocale 对同值是空操作，所以每帧都调也不会造成额外重渲染。
      if (isLocale(payload.locale)) setLocale(payload.locale)
      const nextElapsedSec = typeof payload.elapsedSec === 'number'
        ? payload.elapsedSec
        : elapsedSecRef.current

      if (payload.state) {
        if (payload.state === 'waiting') {
          beginPreparingVisual()
        } else if (payload.state === 'listening') {
          if (preparingPaintFrameRef.current !== null) {
            pendingListeningVisualRef.current = true
          } else {
            setRecordingVisualPhase('listening')
          }
        } else {
          cancelPreparingPaint()
          pendingListeningVisualRef.current = false
        }
        setState(payload.state)
        if (payload.state !== 'listening') {
          setBars((prev) => Array(prev.length).fill(3))
          // 离开录音状态即清空实时文字气泡
          setStreamingText('')
          setStreamingOn(false)
        }
        setCopied(false)
        setCopyError(false)
        if (payload.state !== 'fallback' && hideTimerRef.current) {
          clearTimeout(hideTimerRef.current)
          hideTimerRef.current = null
        }
        if (payload.state === 'thinking') {
          setThinkingDuration(calculateThinkingDuration(nextElapsedSec))
          setThinkingNote(payload.thinkingNote ?? null)
          setThinkingAi(payload.thinkingAi === true)
        } else {
          setThinkingNote(null)
          setThinkingAi(false)
        }
        if (payload.state !== 'failure') {
          // 离开失败态就把恢复结论清回 unknown，否则下一张卡片会先闪一下上一次的
          // "可在历史记录重新识别"——那句话在新的失败里可能根本不成立。
          setFailureRecovery('unknown')
        }
      }

      if (Array.isArray(payload.bars) && payload.bars.length > 0) setBars(payload.bars)
      if (typeof payload.elapsedSec === 'number') {
        elapsedSecRef.current = payload.elapsedSec
        setElapsedSec(payload.elapsedSec)
      }
      if (typeof payload.showDuration === 'boolean') setShowDuration(payload.showDuration)
      if (payload.theme) setTheme(normalizeWaveTheme(payload.theme, 'black-blue'))
      if (payload.customWave) {
        // 每帧 payload 都会带一个新对象；内容没变就保留旧引用，否则下面按配色 memo 的
        // 调色板每帧都得重算一遍。
        const next = normalizeCustomWave(payload.customWave)
        setCustomWave((prev) => (sameCustomWave(prev, next) ? prev : next))
      }
      if (typeof payload.barCount === 'number' && payload.barCount > 0) setBarCount(payload.barCount)
      if (typeof payload.fallbackText === 'string') setFallbackText(payload.fallbackText)
      if (typeof payload.fallbackReason === 'string') setFallbackReason(payload.fallbackReason)
      if (typeof payload.cardToken === 'number') setCardToken(payload.cardToken)
      if (typeof payload.failureTitle === 'string') setFailureTitle(payload.failureTitle)
      if (typeof payload.failureDetail === 'string') setFailureDetail(payload.failureDetail)
      if (
        payload.failureRecovery === 'unknown'
        || payload.failureRecovery === 'history'
        || payload.failureRecovery === 'none'
      ) {
        setFailureRecovery(payload.failureRecovery)
      }
      if (typeof payload.errorMessage === 'string') setErrorMessage(payload.errorMessage)
      if (typeof payload.toastText === 'string') setToastText(payload.toastText)
      if (payload.toastTone === 'info' || payload.toastTone === 'warn') setToastTone(payload.toastTone)
      if (typeof payload.warning === 'string') setWarning(payload.warning)
      if (payload.warningTone === 'warn' || payload.warningTone === 'error') setWarningTone(payload.warningTone)
      if (typeof payload.streamingText === 'string') setStreamingText(payload.streamingText)
      if (typeof payload.streaming === 'boolean') setStreamingOn(payload.streaming)
      if (payload.micSourceMode === 'auto' || payload.micSourceMode === 'fixed' || payload.micSourceMode === null) {
        setMicSourceMode(payload.micSourceMode)
      }
      if (typeof payload.micSourceLabel === 'string') setMicSourceLabel(payload.micSourceLabel)
      if (payload.state === 'waiting') {
        setElapsedSec(0)
        setWarning('')
        setWarningTone('warn')
        setStreamingText('')
        setStreamingOn(false)
        setMicSourceMode(null)
        setMicSourceLabel('')
        setBars((prev) => Array(prev.length).fill(3))
      }

      if (!payload._overlayProbe) return
      const showId = payload._overlayShowId
      const generation = payload._overlayGeneration
      if (typeof showId !== 'number' || typeof generation !== 'number') return

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (disposed) return
          const root = rootRef.current
          const content = root?.querySelector<HTMLElement>('[data-overlay-content]') ?? null
          const rootRect = root?.getBoundingClientRect()
          const contentRect = content?.getBoundingClientRect()
          const style = content ? window.getComputedStyle(content) : null
          // 内容顶部越到视口上方多少 CSS px。overlay.html 给 html/body/#root 设了
          // overflow:hidden，所以这一段是**真的被裁掉**，不是滚出去了还能拉回来。
          // healthy 不看它（悬浮窗被裁一条仍然在工作），但必须上报：否则被裁成什么样
          // 日志里都只有一行 render ack OK。
          const clippedTop = contentRect ? Math.max(0, -contentRect.top) : 0
          const healthy = Boolean(
            rootRect && contentRect
            && rootRect.width > 0 && rootRect.height > 0
            && contentRect.width > 0 && contentRect.height > 0
            && style?.display !== 'none'
            && style?.visibility !== 'hidden'
            && Number(style?.opacity ?? '1') > 0
          )
          void bridge.overlayRenderAck({
            showId,
            generation,
            healthy,
            overlayState: payload.state ?? 'unknown',
            documentVisibility: document.visibilityState,
            rootWidth: rootRect?.width ?? 0,
            rootHeight: rootRect?.height ?? 0,
            contentWidth: contentRect?.width ?? 0,
            contentHeight: contentRect?.height ?? 0,
            clippedTop,
            // 原生侧按「逻辑像素 × 显示器 scale」定窗口大小，但 webview 的 1 CSS px 可能是
            // `显示器 scale × 额外缩放` 个设备像素（Windows 的文本大小设置会被 WebView2
            // 当页面缩放叠上来）。把 dpr 和真实视口报上去，原生侧才能把窗口开够。
            devicePixelRatio: window.devicePixelRatio,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            display: style?.display ?? 'missing',
            visibility: style?.visibility ?? 'missing',
            opacity: style?.opacity ?? 'missing',
          }).catch(() => { })
        })
      })
    }

    void bridge.listen<unknown>('overlay-state', (event) => handleOverlayState(event.payload))
      .then((unlisten) => {
        if (disposed) {
          unlisten()
          return
        }
        removeOverlayListener = unlisten
        void bridge.overlayReady(window.devicePixelRatio).catch(() => { })
      })

    return () => {
      disposed = true
      cancelPreparingPaint()
      pendingListeningVisualRef.current = false
      removeOverlayListener?.()
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [])

  // 让只跑一次的 card-hotkey 监听能看到最新的卡片内容与代次。
  const copyHandlerRef = useRef<(source: 'button' | 'hotkey') => void>(() => { })
  copyHandlerRef.current = (source) => { void handleCopyFallback(source) }
  cardRef.current = { presentationId, state, text: fallbackText, token: cardToken }

  useEffect(() => {
    // Ctrl+C 只能从原生钩子来：悬浮窗不抢焦点，按键始终发给用户原来的程序，
    // 这个 webview 里的 keydown 永远不会触发（与 Esc 同一个原因）。
    const removeCardHotkey = bridge.onCardHotkey(({ action, token }) => {
      if (action !== 'copy') return
      const card = cardRef.current
      // 代次校验必须在这个入口就做：上一张卡片的按键事件迟到时，只要新卡也是
      // fallback，不校验就会把**新卡的内容**复制出去。handleCopyFallback 里的
      // presentationId 只保护"复制开始之后"，补不上这一刀。
      if (card.state !== 'fallback' || !card.text || token !== card.token || token === 0) {
        addRuntimeEvent('info', 'overlay', 'Ignored a card hotkey that does not match the current card', {
          action,
          eventToken: token,
          cardToken: card.token,
          state: card.state,
        })
        return
      }
      copyHandlerRef.current('hotkey')
    })
    return removeCardHotkey
  }, [])

  const recordingPhase = state === 'waiting' || state === 'listening'
  // 胶囊"换了一种内容"的标识。waiting/listening 共用一个：录音中的逐帧刷新不算换内容，
  // 两者之间的展开另有 clip-path 负责。提示类把文案也算进去，连着两条不同的提示同样要变形。
  // 录音中出现/撤掉警告、进入倒计时都会让波形让出条数（见下面的 barBudget），宽度跟着变，
  // 所以它们算进宽度的 key；但录音内容本身不重挂，contentKey 仍是同一个。
  // 「处理中」→「仍在等待结果」同理：宽度要弹，内容不能重挂（进度条会从零重来）。
  const pillContentKey = recordingPhase ? 'recording' : state === 'thinking' ? 'thinking' : null
  const pillMorphKey = recordingPhase
    ? `recording:${warningTone}:${warning}:${formatRecordingTimer(elapsedSec).countdown ? 1 : 0}`
    : state === 'thinking'
      ? `thinking:${thinkingNote ?? ''}:${thinkingAi ? 'ai' : ''}`
      : state === 'toast'
        ? `toast:${toastTone}:${toastText}`
        : state === 'error'
          ? `error:${errorMessage}`
          : state
  const { animateContent: animatePillContent, enteredFrom: pillEnteredFrom } = usePillMorph(
    pillRef,
    pillMorphKey,
    presentationId,
    pillContentKey ?? pillMorphKey,
  )
  const visuallyListening = state === 'listening' && recordingVisualPhase === 'listening'
  const showStreamingBubble = visuallyListening && (streamingOn || streamingText.trim().length > 0)
  const hasStreamingText = streamingText.trim().length > 0
  const showMicSourceHint = Boolean(
    micSourceMode
    && micSourceLabel.trim()
    && (visuallyListening || state === 'thinking'),
  )

  const { text: timerText, countdown: inCountdown, remainingSec } = useMemo(
    () => formatRecordingTimer(elapsedSec),
    [elapsedSec],
  )
  // 越接近上限越醒目，但不用刺眼的纯红：琥珀 → 暖橙，最后 10 秒再叠一层脉动。
  // 悬浮窗是黑底小尺寸，纯红（#f87171）在这上面又艳又跳，和整体配色不搭。
  const urgent = inCountdown && remainingSec <= 10
  // 胶囊宽度按波形条数固定，文字挤进来时按需让出条数：
  //   · 同时有警告文字 + 倒计时 → 只画一半（最少 4 根，太少就不像波形了）
  //   · 只有其中一种 → 画三分之二
  // 这样波形始终是完整的整根条，不会被裁成半截。
  const normalizedBars = barCount === bars.length
    ? bars
    : Array.from({ length: barCount }, (_, index) => bars[index] ?? 3)
  const barBudget = warning && inCountdown
    ? Math.max(4, Math.floor(normalizedBars.length / 2))
    : (warning || inCountdown
      ? Math.max(6, Math.floor((normalizedBars.length * 2) / 3))
      : normalizedBars.length)
  const visibleBars = barBudget >= normalizedBars.length
    ? normalizedBars
    : normalizedBars.slice(0, barBudget)

  // 录音时每秒重渲染约 30 次，配色只在主题/条数变化时才变，没必要每帧重算（自定义色要做 OKLCH 换算）。
  const palette = useMemo(
    () => buildWavePalette(normalizedBars.length, theme, customWave),
    [normalizedBars.length, theme, customWave],
  )
  const themeTimerColor = useMemo(() => getWaveTimerColor(theme, customWave), [theme, customWave])
  const thinkingColor = useMemo(() => getWaveThinkingColor(theme, customWave), [theme, customWave])
  const timerColor = inCountdown
    ? (urgent ? '#fb923c' : '#fbbf24')
    : themeTimerColor

  // 「波形收成进度条」要用录音结束前的最后一帧波形。离开录音的那一刻 bars 已经被清成 3，
  // 所以只能在录音中逐帧记下来；静音高警时画的是红字不是波形，那就没有可收的东西。
  const waveSnapshotRef = useRef<{ heights: number[]; colors: string[] } | null>(null)
  if (visuallyListening) {
    waveSnapshotRef.current = warning && warningTone === 'error'
      ? null
      : { heights: visibleBars, colors: palette }
  } else if (state === 'waiting') {
    // 新一次录音开始就清掉。否则按一下就松（还没画出波形）时，收进进度条的会是上一次的波形。
    waveSnapshotRef.current = null
  }
  const waveSnapshot = waveSnapshotRef.current
  // 减少动态效果时不收：全局规则会把动画压成 0.01ms，但处理中内容的 170ms 延迟还在，
  // 等于白白让文字晚出来。
  const showWaveCollapse = state === 'thinking' && pillEnteredFrom === 'recording' && waveSnapshot !== null
    && waveSnapshot.heights.length > 0 && !prefersReducedMotion()
  // 进度条宽 48px（w-12）。波形行宽 = 条宽 2.5px × n + 间距 2px × (n - 1)。
  const waveCollapseScale = waveSnapshot && waveSnapshot.heights.length > 0
    ? 48 / (waveSnapshot.heights.length * 2.5 + (waveSnapshot.heights.length - 1) * 2)
    : 1

  const handleCopyFallback = async (source: 'button' | 'hotkey' = 'button') => {
    if (!fallbackText) return
    // 复制期间可能开始新一次录音（present 会换掉 presentationId）。旧回调绝不能
    // 关掉新悬浮窗 —— 那是"复制完上一张卡，正在录的这一次提示突然消失"的成因。
    const cardAtStart = presentationId

    try {
      await bridge.copyText(fallbackText)
      if (cardAtStart !== cardRef.current.presentationId) {
        addRuntimeEvent('info', 'overlay', 'Ignored a copy result from a superseded card', {
          cardAtStart,
          currentCard: cardRef.current.presentationId,
        })
        return
      }
      setCopied(true)
      setCopyError(false)
      addRuntimeEvent('info', 'overlay', 'Result card copied', {
        textLen: fallbackText.length,
        source,
      })

      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
      hideTimerRef.current = setTimeout(() => {
        if (cardAtStart !== cardRef.current.presentationId) return
        dismissCard('copied')
        hideTimerRef.current = null
      }, 500)
    } catch (error) {
      // 复制失败**保留卡片**：文本此刻既不在输入框里、也不在剪贴板里，把卡片关掉
      // 等于把它彻底丢掉。剪贴板被安全软件占用是真实场景（见 pitfalls 16）。
      addRuntimeEvent('error', 'overlay', 'Result card copy failed', {
        error: String(error),
        source,
      })
      if (cardAtStart !== cardRef.current.presentationId) return
      setCopied(false)
      setCopyError(true)
    }
  }

  /**
   * 收起当前卡片。
   *
   * 三件事必须一起做，缺一件都留下真实故障：
   *  1. 解除原生按键接管（否则用户的 Esc / Ctrl+C 继续被吞）；
   *  2. 隐藏窗口；
   *  3. **回报主窗**。卡片的生命周期归主窗的 OverlayService 管，它持有续期定时器；
   *     不回报的话 8 秒后它又把按键注册回来，而且原生侧会重新抓当前前台窗口。
   */
  const dismissCard = (reason: string) => {
    const token = cardRef.current.token
    addRuntimeEvent('info', 'overlay', 'Card dismissed', { reason, state: cardRef.current.state, token })
    void bridge.setEscapeActionMode('off')
    void bridge.setCardHotkeys([])
    void bridge.hideOverlay()
    void bridge.notifyCardDismissed(reason, token).catch(() => { /* 主窗不在也不该卡住关闭 */ })
  }

  const handleDismissCard = () => { dismissCard('user_closed') }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none flex h-full items-end justify-center pb-4"
    >
      {/* blank：一个子节点都不要（连胶囊底色都不画）。见 OverlayState 上的注释 ——
          它的整个用途就是让"隐藏前留在合成器里的那一帧"是空的。
          ⚠️ 别顺手给它补个占位元素，那就白做了。 */}
      {state === 'blank' ? null : state === 'fallback' ? (
        <div
          data-overlay-content
          className="pointer-events-auto flex w-full max-w-[520px] flex-col rounded-xl border px-4 py-4"
          style={{
            background: 'var(--overlay-bg)',
            color: 'var(--overlay-text)',
            borderColor: 'var(--overlay-border)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <span className="block text-xs font-medium tracking-[0.16em]" style={{ color: 'var(--overlay-text-muted)' }}>{t('overlay.recognizedText')}</span>
              {/* 卡片必须说清它为什么在这里。reason 以前只进日志，界面一律显示
                  「当前目标不支持直接写入」—— 而插入卡死那条路上，文字**可能已经
                  写进去了**，那句话是错的，会让用户再粘一遍。 */}
              <span className="block text-xs" style={{ color: copyError ? '#fca5a5' : 'var(--overlay-text-dim)' }}>
                {copyError
                  ? t('overlay.copyFailedHint')
                  : fallbackReason === 'insertion_timeout'
                    ? t('overlay.insertionTimeoutHint')
                    // mac 上卡片的复制键是 ⌘C（Rust 侧 keyboard/macos.rs 的 only_command_is_down）
                    : t(IS_MAC ? 'overlay.fallbackHintMac' : 'overlay.fallbackHint')}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => { void handleCopyFallback('button') }}
                // 悬浮窗的 bundle 里没有 Tooltip 组件，用原生 title 带出快捷键。
                title={copied ? t('overlay.copied') : t(IS_MAC ? 'overlay.copyTextWithHotkeyMac' : 'overlay.copyTextWithHotkey')}
                aria-keyshortcuts={IS_MAC ? 'Meta+C' : 'Control+C'}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${copied
                  ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-white/10 bg-white/10 text-white/90 hover:bg-white/20'
                  }`}
              >
                {copied ? <SuccessCheck className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={handleDismissCard}
                title={t('window.close')}
                aria-label={t('overlay.dismissAria')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-4 flex-1 overflow-hidden rounded-lg px-3 py-3" style={{ background: 'var(--overlay-surface)' }}>
            <p className="max-h-[108px] overflow-auto pr-1 text-sm leading-6 select-text">
              {fallbackText || t('overlay.noText')}
            </p>
          </div>
        </div>
      ) : state === 'failure' ? (
        /* 识别失败卡片。没有文本可交付，所以只有关闭按钮，也不注册 Ctrl+C。
         *
         * 两列网格：第 1 列只放图标，三段文字全部落在第 2 列。**别改回「图标 + 文字」
         * 嵌套 flex** —— 那份实现里恢复提示是卡片根节点的直接子元素，左边缘对齐的是
         * 卡片内边距，比标题和原因少缩进整整一个图标宽（24px），看着像掉出去了。
         * 对齐交给网格线，不要靠手写 padding 去凑。
         *
         * 关闭按钮刻意脱离网格流（absolute）：它 32px 高，留在流里会把第一行整体撑到
         * 32px，于是"标题↔原因 4px"这个紧凑间距实际变成 16px，分组节奏就没了。
         *
         * 尺寸与 window/mod.rs 的 OVERLAY_FAILURE_WIDTH / _HEIGHT 是一对，改一边就要改另一边：
         * 下面的 max-w 比窗口窄时，多出来的透明边照样吞掉下面程序的点击（这是 is_interactive
         * 布局）；比窗口宽则被 overflow:hidden 裁掉。高度上限另见那条布局自检单测。 */
        <div
          data-overlay-content
          className="pointer-events-auto relative grid w-full max-w-[480px] grid-cols-[auto_1fr] items-start gap-x-2 rounded-xl border px-4 py-4"
          style={{
            background: 'var(--overlay-bg)',
            color: 'var(--overlay-text)',
            borderColor: 'var(--overlay-border)',
          }}
        >
          {/* mt-0.5 是光学对齐，不是随手加的：图标 16px、标题行高 20px，(20-16)/2 = 2px。 */}
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden />
          {/* pr-9 给绝对定位的关闭按钮让位（32px 按钮 + 4px 间隙），否则长标题会压到它下面。 */}
          <span className="min-w-0 pr-9 text-sm font-medium leading-5">
            {failureTitle || t('overlay.genericError')}
          </span>
          <button
            type="button"
            onClick={handleDismissCard}
            title={t('window.close')}
            aria-label={t('overlay.dismissAria')}
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
          {/* 间距节奏是刻意的：原因紧跟标题（4px，同一件事），恢复提示隔开一档
              （8px，另一类信息）。两段都用 --overlay-text-muted 而不是 -dim ——
              #666 在 #0b0b0c 上只有 3.4:1，够不上正文 4.5:1 的无障碍底线；#999 是 6.9:1。
              层级交给顺序和间距表达，不靠把其中一段压暗。

              textWrap: 'pretty' 治孤字末行（只剩「试。」这种）。用内联 style 而不是
              Tailwind 的 text-pretty：那个类要扫源码才产出，跑旧 CSS 产物时这层保护会
              静默失效（见 pitfalls 11 同款教训）。它只调整断行，不增加行数，所以不会
              顶到高度上限。 */}
          {failureDetail && (
            <span
              className="col-start-2 mt-1 pr-9 text-xs leading-5 select-text"
              style={{ color: 'var(--overlay-text-muted)', textWrap: 'pretty' }}
            >
              {failureDetail}
            </span>
          )}
          {/* 只有确实存下来了才提恢复。'unknown' 什么都不说 —— 存档是异步的，
              与其在这里许一个可能作废的承诺，不如等结论到了再补上（见
              OverlayService.updateFailureRecovery）。 */}
          {failureRecovery !== 'unknown' && (
            <span
              className="col-start-2 mt-2 text-xs leading-5"
              style={{ color: 'var(--overlay-text-muted)', textWrap: 'pretty' }}
            >
              {failureRecovery === 'history'
                ? t('overlay.failureRecoverFromHistory')
                : t('overlay.failureNoRecording')}
            </span>
          )}
        </div>
      ) : (
        <div
          data-overlay-content
          className="flex flex-col items-center gap-2"
        >
          {showMicSourceHint && (
            <div
              className="pointer-events-none flex min-w-0 max-w-[calc(100vw-16px)] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-3 py-1.5 font-normal"
              style={{
                background: 'rgba(11, 11, 12, 0.94)',
                color: 'var(--overlay-text)',
                borderColor: 'var(--overlay-border)',
                boxShadow: '0 2px 10px rgba(0, 0, 0, 0.2)',
                backdropFilter: 'blur(8px)',
              }}
            >
              <MicVocal
                className="h-3.5 w-3.5 shrink-0"
                strokeWidth={1.8}
                style={{ color: '#ffffff' }}
                aria-hidden
              />
              <span className="min-w-0 truncate text-xs font-normal" style={{ color: '#ffffff' }}>
                {micSourceLabel}
              </span>
            </div>
          )}
          {showStreamingBubble && (
            <div
              className="pointer-events-none relative flex max-w-[440px] flex-col rounded-2xl border px-4 py-2.5"
              style={{
                background: 'var(--overlay-bg)',
                color: 'var(--overlay-text)',
                borderColor: 'var(--overlay-border)',
              }}
            >
              <span
                className="mb-1 text-[10px] font-medium tracking-[0.18em]"
                style={{ color: 'var(--overlay-text-muted)' }}
              >
                {t('overlay.liveCaption')}
              </span>
              {/* 内容驱动尺寸：小默认，随文字增行慢慢变大，超过 3 行才滚动，只显示最新内容 */}
              <div
                className="flex max-h-[72px] flex-col justify-end overflow-hidden text-left text-sm leading-6"
                style={{ color: hasStreamingText ? 'var(--overlay-text)' : 'var(--overlay-text-dim)' }}
              >
                <div>
                  {hasStreamingText ? streamingText : t('overlay.listening')}
                  {hasStreamingText && (
                    <span
                      className="ml-0.5 inline-block h-[1.05em] w-[2px] rounded-full align-middle"
                      style={{
                        backgroundColor: 'var(--overlay-text)',
                        animation: 'caret-blink 1.1s ease-in-out infinite',
                      }}
                    />
                  )}
                </div>
              </div>
              {/* 底部朝下尖角：提示文字来自下方的录音胶囊 */}
              <span
                className="absolute left-1/2 h-0 w-0 -translate-x-1/2"
                style={{
                  bottom: '-7px',
                  borderLeft: '7px solid transparent',
                  borderRight: '7px solid transparent',
                  borderTop: '7px solid var(--overlay-bg)',
                }}
              />
            </div>
          )}
          {/* 胶囊：窗口宽度按波形条数固定，所以这里必须禁止换行 —— 否则文字一多
              （如「剩余 28s」+「请靠近麦克风」同时出现）就会折成两行，把圆角撑破。
              超出时让**波形**让位（见下方 bars 容器的 min-w-0 + overflow-hidden），
              文字保持完整：文字是信息，波形只是陪衬。 */}
          {/* max-w 是配套的另一半：根容器是 justify-center，胶囊内容一宽就向两侧溢出、
              被窗口裁掉，看着像"两端被切平的圆角矩形"。给了宽度上限，压缩压力才会
              传到波形上（bars 的 min-w-0），胶囊本身始终保持完整的胶囊形状。
              用 100vw 而不是 max-w-full：父层宽度也是按内容算的，撑不出约束。 */}
          <div
            ref={pillRef}
            className={`relative flex max-w-[calc(100vw-8px)] items-center overflow-hidden whitespace-nowrap rounded-full px-4 py-2${recordingPhase && recordingVisualPhase === 'preparing' ? ' overlay-pill-recording-waiting' : ''}${recordingPhase && recordingVisualPhase === 'listening' ? ' overlay-pill-recording-listening' : ''}`}
            style={{ minHeight: '38px' }}
          >
            <span
              key={presentationId}
              aria-hidden
              className="overlay-pill-surface overlay-pill-surface-enter absolute inset-0 rounded-full border"
              style={{
                background: 'var(--overlay-bg)',
                borderColor: 'var(--overlay-border)',
              }}
            />
            {/* 最后一帧波形，压平并拢成进度条后淡出（index.css 的 overlay-wave-collapse）。
                放在处理中内容**外面**：那一层带着入场的透明度动画，放进去会一起被藏住。
                left 16px = 胶囊 px-4，与波形、进度条的起笔对齐；收完留在 DOM 里是透明的，不碍事。 */}
            {showWaveCollapse && waveSnapshot && (
              <div
                aria-hidden
                className="overlay-wave-collapse pointer-events-none absolute z-[1] flex items-center gap-[2px]"
                style={{
                  left: '16px',
                  top: '50%',
                  height: '20px',
                  marginTop: '-10px',
                  '--collapse-scale': String(waveCollapseScale),
                } as CSSProperties}
              >
                {waveSnapshot.heights.map((height, index) => {
                  const h = `${Math.min(18, Math.max(3, height))}px`
                  return (
                    <span
                      key={index}
                      className="overlay-wave-collapse-bar block w-[2.5px] rounded-full"
                      style={{ backgroundColor: waveSnapshot.colors[index], height: h, '--from-h': h } as CSSProperties}
                    />
                  )
                })}
              </div>
            )}
            {recordingPhase ? (
              <div
                className="overlay-recording-stage relative z-[1] min-w-0"
                style={{ color: 'var(--overlay-text)' }}
              >
                <div className="overlay-preparing-indicator" aria-hidden>
                  {[0, 1, 2].map((index) => (
                    <span
                      key={index}
                      className="overlay-preparing-dot rounded-full"
                      style={{ animationDelay: `${index * 110}ms` }}
                    />
                  ))}
                </div>
                <div
                  className="overlay-recording-content flex min-w-0 items-center"
                  aria-hidden={recordingVisualPhase !== 'listening'}
                >
                  {warning && warningTone === 'error' ? (
                    // 静音高警：波形此时是平的、无意义，直接在胶囊里居中显示红字，
                    // 既更醒目、也避免波形+长文字撑破固定宽度把胶囊圆角裁掉。
                    <div
                      key={warning}
                      className="overlay-attention flex items-center whitespace-nowrap px-1 text-xs font-semibold text-red-500"
                      style={{ height: '20px' }}
                    >
                      {warning}
                    </div>
                  ) : (
                    <>
                      {/* 有文字要占位时**少画几根**，而不是让 overflow 把波形裁一半 —— 裁出来的
                          半根条子看着像坏了。少画是"看起来就是这么设计的"。
                          min-w-0 仍然留着兜底：万一文字特别长，宁可裁波形也不折行。 */}
                      <div className="flex min-w-0 items-center gap-[2px] overflow-hidden" style={{ height: '20px' }}>
                        {visibleBars.map((height, index) => {
                          const color = palette[index]
                          return (
                            <div
                              key={index}
                              className="w-[2.5px] rounded-full"
                              style={{
                                backgroundColor: color,
                                boxShadow: 'none',
                                height: `${Math.min(18, Math.max(3, height))}px`,
                                opacity: 0.7 + (Math.min(18, height) / 18) * 0.3,
                                transition: 'height 50ms ease-out, opacity 50ms ease-out',
                              }}
                            />
                          )
                        })}
                      </div>
                      {/* 计时**不再**被警告顶掉：警告是一闪而过的提示，计时是持续状态。
                          以前条件里带 !warning，导致 4 分钟提示一出现，剩下一整分钟都看不到秒数。 */}
                      {showDuration && (
                        <span
                          className={`ml-1.5 shrink-0 whitespace-nowrap text-right font-mono tabular-nums text-xs${inCountdown ? ' font-semibold' : ''}${urgent ? ' overlay-breathe' : ''}`}
                          style={{ color: timerColor }}
                        >
                          {timerText}
                        </span>
                      )}
                      {warning && (
                        <span key={warning} className="overlay-attention ml-2 shrink-0 whitespace-nowrap text-xs text-amber-400">
                          {warning}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              // key 让每种内容各自挂载一次，入场动画才会在换内容时重新播放。
              // 波形在收的时候，处理中内容等它收到进度条那个位置（约 170ms）再出来。
              <div
                key={pillContentKey ?? pillMorphKey}
                className={`relative z-[1] flex min-w-0 items-center${animatePillContent ? ' overlay-pill-content-enter' : ''}`}
                style={{
                  color: 'var(--overlay-text)',
                  animationDelay: showWaveCollapse ? '170ms' : undefined,
                }}
              >
                {state === 'thinking' && (
                  <div className="flex items-center gap-2">
                    {/* 三段式进度（估计段 → 慢蹭段 → 流光），动画定义与原因见 index.css 的
                        overlay-progress-*。--estimate 是估计时长，后两段都以它为延迟起点。 */}
                    <div
                      className="relative h-1 w-12 overflow-hidden rounded-full bg-white/10"
                      style={{ '--estimate': `${thinkingDuration}s` } as CSSProperties}
                    >
                      <div className="overlay-progress-estimate absolute inset-0">
                        <div
                          className="overlay-progress-creep absolute inset-0 rounded-full"
                          style={{ backgroundColor: thinkingColor }}
                        />
                      </div>
                      <div className="overlay-progress-sheen absolute inset-y-0 left-0 rounded-full" aria-hidden />
                    </div>
                    {/* AI 整理时带一枚星芒。颜色跟处理中文字走（也就是用户的波形主题），
                        不另配彩虹渐变：胶囊配色是用户自己选的，叠一层流行色会撞。
                        「已超时仍在等」那句不带：那时要传达的是"慢了"，不是"在做 AI"。 */}
                    <span className="flex items-center gap-1 text-xs whitespace-nowrap" style={{ color: thinkingColor }}>
                      {thinkingAi && thinkingNote !== 'late' && (
                        <Sparkles aria-hidden className="overlay-ai-sparkle h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
                      )}
                      {thinkingNote === 'late'
                        ? t('overlay.awaitingLateResult')
                        : t(thinkingAi ? 'overlay.processingAi' : 'overlay.processing')}
                    </span>
                    {/* 这里**故意**不写「Esc 取消」。Esc 取消的能力照常生效（原生钩子 +
                        escape-action，与本组件无关），只是这行提示不该出现在悬浮窗上：
                        悬浮窗是贴在光标附近、每次口述都会闪一下的东西，越安静越好，而
                        「按 Esc 能取消」是知道一次就一直知道的事实，不需要每次复述。
                        这件事已在 设置 → 键盘快捷键 的说明里静态交代（见 GeneralSettingsPage）。
                        要加回来之前先想清楚：它每次处理都出现，收益只有第一次。 */}
                  </div>
                )}

                {state === 'error' && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-400">{errorMessage || t('overlay.genericError')}</span>
                  </div>
                )}

                {state === 'toast' && (
                  <div className="flex items-center gap-2">
                    {toastTone === 'warn' ? (
                      <span className="whitespace-nowrap text-xs text-amber-400">{toastText}</span>
                    ) : (
                      <span className="whitespace-nowrap text-xs" style={{ color: 'var(--overlay-text)' }}>
                        {toastText}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
