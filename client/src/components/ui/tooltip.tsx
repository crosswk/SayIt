import { ReactNode, useState, useRef, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content: string
  children: ReactNode
  className?: string
  forceVisible?: boolean
}

export function Tooltip({ content, children, className, forceVisible }: TooltipProps) {
  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const show = hovered || forceVisible

  useLayoutEffect(() => {
    if (!show || !triggerRef.current || !tooltipRef.current) {
      setPos(null)
      return
    }
    const tr = triggerRef.current.getBoundingClientRect()
    const tt = tooltipRef.current.getBoundingClientRect()

    let top = tr.top - tt.height - 6
    let left = tr.left + (tr.width - tt.width) / 2

    if (top < 4) top = tr.bottom + 6
    if (left < 4) left = 4
    else if (left + tt.width > window.innerWidth - 4) left = window.innerWidth - tt.width - 4

    setPos({ top, left })
  }, [show])

  const onEnter = useCallback(() => setHovered(true), [])
  const onLeave = useCallback(() => setHovered(false), [])
  const onDown = useCallback(() => setHovered(false), [])

  // 安全兜底：如果鼠标已经离开但状态没更新，定时检查
  useLayoutEffect(() => {
    if (!hovered || !triggerRef.current) return
    const check = setInterval(() => {
      if (!triggerRef.current?.matches(':hover')) {
        setHovered(false)
      }
    }, 500)
    return () => clearInterval(check)
  }, [hovered])

  const tooltip = show
    ? createPortal(
        <div
          ref={tooltipRef}
          className="pointer-events-none fixed z-[9999] rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-lg"
          style={{
            top: pos ? `${pos.top}px` : '-9999px',
            left: pos ? `${pos.left}px` : '-9999px',
          }}
        >
          {content}
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onPointerDown={onDown}
        className={`inline-flex ${className || ''}`}
      >
        {children}
      </span>
      {tooltip}
    </>
  )
}
