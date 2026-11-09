import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * 一块"选中底色"在选项之间滑动，而不是旧格褪色、新格变色（单选胶囊 / 历史页筛选 / 侧栏）。
 *
 * 用法：容器 `position: relative`，里面放一个 `<span ref={indicatorRef} className="sliding-indicator ..." />`
 * （`space-y-*` 容器里要放最后，否则它会给第一个真选项加 margin-top），
 * 选项本身不画选中底色、`position: relative` 盖在它上面。选中项靠 `activeSelector` 找
 * （默认 `[aria-checked="true"]`，侧栏用 NavLink 自带的 `[aria-current="page"]`）。
 *
 * 位置是**直接写 DOM**、不走 state：写 state 会多一次渲染，而且量尺寸必须在布局之后，
 * 绕一圈 setState 只会让第一帧画在错的地方。
 *
 * 三种情况**不能滑**，只能原地出现：
 *  1. 首次定位（挂载时从 0,0 滑过来，看着像设置被改了一次 —— pitfalls 11 同一类问题）；
 *  2. 上一次没有可见的选中项（容器 display:none、或侧栏选中项跑到了另一组）；
 *  3. 调用方说现在不许动画（设置值刚异步读回来、`animated=false`）。
 * 窗口缩放 / 字体加载导致的位移也不滑，跟着 ResizeObserver 直接贴过去。
 */
/**
 * 选中项相对容器内边距框的位置。用 offset* 逐级累加而不是 getBoundingClientRect：
 * 弹窗入场时整块面板带着 scale，rect 量出来是缩小后的值，滑块会差几个像素停在那里
 * （transform 不触发 ResizeObserver，事后也不会被纠正）。offset* 不受 transform 影响。
 * 选项外面包了一层定位元素（如 Tooltip 的包裹）时，offsetParent 是那一层，所以要一路加上去。
 */
function offsetWithin(el: HTMLElement, container: HTMLElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let node: HTMLElement | null = el
  while (node && node !== container) {
    x += node.offsetLeft
    y += node.offsetTop
    const parent = node.offsetParent as HTMLElement | null
    if (parent && parent !== container) {
      x += parent.clientLeft
      y += parent.clientTop
    }
    node = parent
  }
  if (node === container) return { x, y }
  // 容器不是 offsetParent 链上的一环（忘了给它 position: relative）：退回按视口坐标算。
  const er = el.getBoundingClientRect()
  const cr = container.getBoundingClientRect()
  return { x: er.left - cr.left - container.clientLeft, y: er.top - cr.top - container.clientTop }
}

export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: unknown,
  options: { animated?: boolean; activeSelector?: string } = {},
): RefObject<HTMLSpanElement> {
  const { animated = true, activeSelector = '[aria-checked="true"]' } = options
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const placedRef = useRef(false)
  const fadedOutRef = useRef(false)
  const geomRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const animatedRef = useRef(animated)
  animatedRef.current = animated

  useLayoutEffect(() => {
    const container = containerRef.current
    const indicator = indicatorRef.current
    if (!container || !indicator) return

    const place = (allowSlide: boolean) => {
      // 多个匹配时取最后一个：NavLink 的 "/" 在某些路由版本下会对所有路径都算 active，
      // 真正的当前页总在它后面。
      const matches = container.querySelectorAll<HTMLElement>(activeSelector)
      const target = matches.length > 0 ? matches[matches.length - 1] : null
      if (!target || target.offsetWidth === 0) {
        if (placedRef.current) fadedOutRef.current = true
        indicator.style.opacity = '0'
        placedRef.current = false
        geomRef.current = null
        return
      }
      const { x, y } = offsetWithin(target, container)
      const geom = { x, y, w: target.offsetWidth, h: target.offsetHeight }
      const last = geomRef.current
      // ResizeObserver 在 observe() 时**一定**先回调一次，哪怕什么都没变。那一次如果也按
      // "尺寸变了、直接贴过去"处理，会把刚开始的滑动当场掐掉（实测：滑块一格都不动）。
      // 所以只有几何真的变了才动它。
      if (!allowSlide && last && last.x === geom.x && last.y === geom.y && last.w === geom.w && last.h === geom.h) return
      geomRef.current = geom

      const slide = allowSlide && placedRef.current && animatedRef.current
      // 从"本组没有选中项"回来（侧栏在两组之间切换）：不滑，但淡入，否则像凭空闪出来。
      const fadeIn = !placedRef.current && fadedOutRef.current && animatedRef.current
      indicator.style.transition = slide ? '' : 'none'
      indicator.style.width = `${geom.w}px`
      indicator.style.height = `${geom.h}px`
      indicator.style.transform = `translate(${geom.x}px, ${geom.y}px)`
      if (!fadeIn) indicator.style.opacity = '1'
      if (!slide) {
        // 先让"无过渡"的位置生效，再把过渡还回去；不读一次布局，浏览器会把两次写合并成一次滑动。
        void indicator.offsetWidth
        indicator.style.transition = ''
        if (fadeIn) indicator.style.opacity = '1'
      }
      placedRef.current = true
      fadedOutRef.current = false
    }

    place(true)

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => place(false))
    // 子元素也要盯：切界面语言时选项文字变宽，而撑满一行的容器自己的尺寸可能纹丝不动。
    observer.observe(container)
    for (const child of Array.from(container.children)) {
      if (child !== indicator) observer.observe(child)
    }
    return () => observer.disconnect()
  }, [containerRef, activeKey, activeSelector])

  return indicatorRef
}
