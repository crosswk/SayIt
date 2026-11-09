import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * 胶囊在状态之间"变形"而不是硬切（录音 → 处理中 → 提示）。
 *
 * 以前胶囊宽度跟着内容瞬间跳变：波形条一收、换成"处理中"，整颗胶囊一帧之内
 * 缩掉三分之一，看着像换了个窗口。现在做两件事：
 *   1. 宽度从旧值弹簧过渡到新值（WAAPI 动 width）；
 *   2. 新内容从轻微模糊里浮出来（CSS 类 overlay-pill-content-enter）。
 *
 * 为什么直接动 width 而不是 transform/clip-path：胶囊是 overflow:hidden 的圆角
 * 容器，scaleX 会把圆角和文字一起压扁；clip-path 方案要让底色比胶囊更宽，就得把
 * overflow:hidden 挪走，而它正是"文字再长也不撑破圆角"的那道保护。这个元素只有
 * 几十个节点、独占一个窗口，逐帧布局的代价可以忽略。
 *
 * 只在**同一次显示**之内变形：换了 presentationId 说明窗口刚被重新弹出，
 * 那时胶囊有自己的入场动画（overlay-pill-surface-enter），再叠一层宽度动画就乱了。
 * 录音的 waiting → listening 共用一个 key，它们之间的展开由 clip-path 负责
 * （见 index.css 的 overlay-pill-recording-*），这里不插手。
 */

// 阻尼比 0.76 的弹簧采样（约 2.5% 过冲，500ms 内收敛）。生成方式：
// x(t) = 1 - e^(-ζωt)(cos(ω_d t) + ζω/ω_d · sin(ω_d t))，ω = 6/(ζ·0.5s)，取 31 个点。
const SPRING_EASING =
  'linear(0, 0.03, 0.106, 0.207, 0.32, 0.434, 0.543, 0.642, 0.728, 0.802, 0.862, 0.91, 0.948, 0.976, 0.996, 1.01, 1.019, 1.023, 1.025, 1.025, 1.024, 1.021, 1.018, 1.015, 1.013, 1.01, 1.008, 1.006, 1.004, 1.003, 1)'
const SPRING_DURATION_MS = 500
// 不认识 linear() 的旧内核（WebView2 < 113、Safari < 17.2）退回同样快收敛、无过冲的曲线。
const FALLBACK_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
const FALLBACK_DURATION_MS = 360

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function isAnimating(animation: Animation): boolean {
  return animation.playState === 'running' || animation.playState === 'paused'
}

function animateWidth(el: HTMLElement, from: number, to: number): Animation | null {
  if (typeof el.animate !== 'function') return null
  const keyframes = [{ width: `${from}px` }, { width: `${to}px` }]
  try {
    return el.animate(keyframes, { duration: SPRING_DURATION_MS, easing: SPRING_EASING })
  } catch {
    // linear() 不被支持时 animate 会直接抛 TypeError，而不是静默忽略。
    return el.animate(keyframes, { duration: FALLBACK_DURATION_MS, easing: FALLBACK_EASING })
  }
}

/**
 * @param morphKey 宽度该不该变形的标识：变了才弹。同一状态里的逐帧刷新（波形、计时）必须产出同一个 key。
 * @param contentKey 内容该不该重新入场的标识，默认等于 morphKey。两者分开是因为有的变化只该动宽度、
 *   不该把内容重挂一遍：「处理中」→「仍在等待结果」时进度条必须接着走，重挂会让它从零开始。
 * @returns animateContent —— 当前这份内容是否是变形换上来的（是则应播放内容入场）；
 *   enteredFrom —— 换上来时被替换掉的那份内容的 contentKey（用来决定要不要播"波形收成进度条"）。
 */
export function usePillMorph(
  ref: RefObject<HTMLElement | null>,
  morphKey: string,
  presentationId: number,
  contentKey: string = morphKey,
): { animateContent: boolean; enteredFrom: string | null } {
  const committedRef = useRef<{ key: string | null; contentKey: string | null; presentationId: number }>({
    key: null,
    contentKey: null,
    presentationId,
  })
  // 没在动画时的自然宽度。变形开始那一刻 DOM 已经换成新内容，旧宽度只能从这里拿。
  const settledWidthRef = useRef<number | null>(null)
  const animationRef = useRef<Animation | null>(null)
  const enteredRef = useRef<{ contentKey: string; from: string } | null>(null)

  // 渲染期判定（refs 还是上一次提交的值）：contentKey 变了、且仍是同一次显示 → 这份新内容要入场。
  // 结论按 key 记住，同一状态里后续的重渲染不会把入场类摘掉（摘掉会让动画中途跳到终点）。
  const committed = committedRef.current
  if (committed.presentationId !== presentationId) {
    enteredRef.current = null
  } else if (committed.contentKey !== null && committed.contentKey !== contentKey) {
    enteredRef.current = { contentKey, from: committed.contentKey }
  }

  useLayoutEffect(() => {
    const el = ref.current
    const prev = committedRef.current
    committedRef.current = {
      key: el ? morphKey : null,
      contentKey: el ? contentKey : null,
      presentationId,
    }

    // 打断：上一段还没弹完就又换了内容，从**当前画面上的宽度**接着弹，不跳回起点。
    // 已经 finished 的不算在弹：onfinish 是异步派发的，ref 可能还没清，这时量到的
    // 是新内容的自然宽度，会把这次变形误判成"宽度没变"。
    let fromWidth = settledWidthRef.current
    if (animationRef.current) {
      if (el && isAnimating(animationRef.current)) fromWidth = el.getBoundingClientRect().width
      animationRef.current.cancel()
      animationRef.current = null
    }

    if (!el) {
      settledWidthRef.current = null
      return
    }
    const toWidth = el.getBoundingClientRect().width
    settledWidthRef.current = toWidth
    el.style.removeProperty('--pill-content-delay')

    const shouldMorph = prev.key !== null
      && prev.key !== morphKey
      && prev.presentationId === presentationId
      && fromWidth !== null
      && Math.abs(fromWidth - toWidth) >= 1
      && !prefersReducedMotion()
    if (!shouldMorph || fromWidth === null) return

    // 变宽时新内容比当前胶囊宽，早早显形会被 overflow:hidden 切掉两头（实测 120ms 时
    // 「网络连接已断开」左右各缺半个字）。所以变宽让字等形状先走到九成多再出来；
    // 变窄时字本来就装得下，跟默认的 50ms 走。改动画属性会实时作用到已开始的 CSS 动画上。
    if (toWidth > fromWidth) el.style.setProperty('--pill-content-delay', '150ms')
    const animation = animateWidth(el, fromWidth, toWidth)
    if (!animation) return
    animationRef.current = animation
    const clear = () => {
      if (animationRef.current === animation) animationRef.current = null
    }
    animation.onfinish = clear
    animation.oncancel = clear
  }, [ref, morphKey, contentKey, presentationId])

  // 同一状态里宽度也会变（低音量警告挤掉几根波形条、倒计时出现），所以每次提交都记一下
  // 自然宽度。必须声明在上面那个 effect 之后：同一次提交里它后跑，不会先把旧宽度覆盖掉。
  useLayoutEffect(() => {
    if (animationRef.current && isAnimating(animationRef.current)) return
    const el = ref.current
    settledWidthRef.current = el ? el.getBoundingClientRect().width : null
  })

  const entered = enteredRef.current
  const animateContent = entered !== null && entered.contentKey === contentKey
  return { animateContent, enteredFrom: animateContent && entered ? entered.from : null }
}
