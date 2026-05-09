import { useEffect, useRef, type RefObject } from 'react'
import { Loader2, Mic, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

type StudioState = 'idle' | 'connecting' | 'recording' | 'processing'

interface RecordingOrbProps {
  state: StudioState
  elapsed: number
  errorText: string
  bars: number[]
  onStart: () => void
  onStop: () => void
}

function formatElapsed(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 生成有机 blob 路径（类似图片中的不规则圆形） */
function blobPath(cx: number, cy: number, r: number, time: number, intensity: number): string {
  const points = 7
  const coords: [number, number][] = []
  for (let i = 0; i < points; i++) {
    const angle = (Math.PI * 2 * i) / points
    const noise = Math.sin(time * 1.2 + i * 2.1) * 0.08 +
                  Math.sin(time * 0.7 + i * 3.4) * 0.06 +
                  Math.sin(time * 2.0 + i * 1.3) * intensity * 0.05
    const radius = r * (1 + noise)
    coords.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
  }
  // 平滑闭合曲线
  let d = `M ${coords[0][0]} ${coords[0][1]}`
  for (let i = 0; i < coords.length; i++) {
    const curr = coords[i]
    const next = coords[(i + 1) % coords.length]
    const cpx = (curr[0] + next[0]) / 2
    const cpy = (curr[1] + next[1]) / 2
    d += ` Q ${curr[0]} ${curr[1]} ${cpx} ${cpy}`
  }
  d += ' Z'
  return d
}

export default function RecordingOrb({
  state,
  elapsed,
  errorText,
  bars,
  onStart,
  onStop,
}: RecordingOrbProps) {
  const isIdle = state === 'idle'
  const isRecording = state === 'recording'
  const isBusy = state === 'connecting' || state === 'processing'

  const blobRef = useRef<SVGPathElement>(null)
  const blobOuterRef = useRef<SVGPathElement>(null)
  const rafRef = useRef(0)
  const timeRef = useRef(0)

  const handleClick = () => {
    if (isBusy) return
    if (isRecording) onStop()
    else onStart()
  }

  // Blob 动画
  useEffect(() => {
    if (!isRecording) {
      cancelAnimationFrame(rafRef.current)
      return
    }
    let lastTs = 0
    const animate = (ts: number) => {
      if (lastTs) timeRef.current += (ts - lastTs) / 1000
      lastTs = ts
      // 根据音量计算强度
      const avgBar = bars.length > 0 ? bars.reduce((a, b) => a + b, 0) / bars.length : 3
      const intensity = Math.min(1, avgBar / 15)

      if (blobRef.current) {
        blobRef.current.setAttribute('d', blobPath(120, 120, 90, timeRef.current, intensity))
      }
      if (blobOuterRef.current) {
        blobOuterRef.current.setAttribute('d', blobPath(120, 120, 105, timeRef.current * 0.6, intensity * 0.7))
      }
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [isRecording, bars])

  // 柱状条参数
  const displayBars = isRecording && bars.length > 0 ? bars : []
  const barCount = Math.min(displayBars.length, 32)

  return (
    <div className="flex flex-col items-center">
      {/* 录音按钮区域 */}
      <button
        type="button"
        onClick={handleClick}
        disabled={isBusy}
        className={cn(
          'group relative h-48 w-48 outline-none transition-all duration-200',
          isBusy && 'cursor-not-allowed opacity-80',
          (isIdle || isRecording) && 'cursor-pointer',
        )}
        aria-label={isRecording ? '停止录音' : isBusy ? '处理中' : '开始录音'}
      >
        {/* Blob SVG 背景（录音中） */}
        {isRecording && (
          <svg
            viewBox="0 0 240 240"
            className="absolute inset-[-12px] h-[calc(100%+24px)] w-[calc(100%+24px)] overflow-visible"
          >
            <path
              ref={blobOuterRef}
              className="fill-primary/5 stroke-primary/10"
              strokeWidth="0.5"
            />
            <path
              ref={blobRef}
              className="fill-primary/10 stroke-primary/20"
              strokeWidth="0.8"
            />
          </svg>
        )}

        {/* 主圆形 */}
        <div className={cn(
          'absolute inset-0 rounded-full border-2 transition-all duration-300',
          isIdle && 'border-border bg-card shadow-sm group-hover:border-primary/40 group-hover:shadow-md',
          isRecording && 'border-primary/30 bg-card shadow-lg',
          isBusy && 'border-border/50 bg-card shadow-sm',
        )}>
          <div className="flex h-full flex-col items-center justify-center">
            {isIdle && (
              <>
                <Mic className="h-10 w-10 text-muted-foreground/50 transition-colors group-hover:text-primary/70" />
                <span className="mt-2.5 text-sm text-muted-foreground/60 transition-colors group-hover:text-muted-foreground">
                  点击录音
                </span>
              </>
            )}

            {isRecording && (
              <>
                {/* 音频柱状条 */}
                <div className="flex items-center justify-center gap-[2px]" style={{ height: 48 }}>
                  {Array.from({ length: barCount }, (_, i) => {
                    const h = Math.min(44, Math.max(3, displayBars[i] || 3))
                    return (
                      <div
                        key={i}
                        className="w-[3px] rounded-full bg-primary/70"
                        style={{
                          height: h,
                          opacity: 0.5 + (h / 44) * 0.5,
                          transition: 'height 60ms ease-out, opacity 60ms ease-out',
                        }}
                      />
                    )
                  })}
                </div>
                {/* 计时 */}
                <div className="mt-2 text-lg font-semibold tabular-nums tracking-wider text-foreground">
                  {formatElapsed(elapsed)}
                </div>
                {/* 停止提示 */}
                <div className="mt-1 flex items-center gap-1.5">
                  <Square className="h-2 w-2 fill-rose-500 text-rose-500 opacity-0 transition-opacity group-hover:opacity-100" />
                  <span className="text-xs text-muted-foreground group-hover:text-rose-500">
                    点击结束
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                </div>
              </>
            )}

            {isBusy && (
              <>
                <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
                <span className="mt-2 text-sm text-muted-foreground">
                  {state === 'connecting' ? '连接中...' : '转录中...'}
                </span>
              </>
            )}
          </div>
        </div>
      </button>

      {errorText && (
        <div className="mt-5 max-w-md rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-center text-sm text-destructive">
          {errorText}
        </div>
      )}
    </div>
  )
}
