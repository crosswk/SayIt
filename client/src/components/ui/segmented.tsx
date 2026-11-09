// 单选胶囊组（识别语言 / 下载源 / 计算后端 / 模型驻留 …）
//
// 为什么抽出来：这个形态在设置页里被手抄了 5 遍，每一遍都是裸 <button>，选中态**只有颜色**
// （border-primary bg-primary），既没有 role="radio" 也没有 aria-checked。键盘用户 Tab 过
// 「自动 / 中文 / 英文」时拿不到"哪个是当前值"这条信息。收成一个组件后，语义只需修一次。
//
// 视觉与原来逐字一致（md 对应原 px-4 py-1.5 text-sm，sm 对应原 px-3 py-1 text-xs），
// 只额外给选中项加了 font-medium 作为非颜色标记。选中底色后来改成了滑块（换选项时滑过去）。

import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { useSlidingIndicator } from './useSlidingIndicator'

export interface SegmentedOption<T> {
  value: T
  label: string
  disabled?: boolean
}

interface SegmentedProps<T> {
  /** 无障碍名称。有可见标题时传 labelledBy 代替 */
  label?: string
  labelledBy?: string
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  /** xs：附在一行内容末尾的次要切换（如自定义波形的单色 / 渐变），比 sm 再小一号 */
  size?: 'xs' | 'sm' | 'md'
  /** 整组禁用（如切换计算后端时正在重载模型） */
  disabled?: boolean
  /** Whether option color changes should animate. */
  animated?: boolean
  className?: string
}

export function Segmented<T extends string | number>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  size = 'md',
  disabled,
  animated = true,
  className,
}: SegmentedProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null)
  // 选中底色是一块独立的滑块（见 useSlidingIndicator），选项自己不再画选中底色。
  // animated=false 的场合（设置值刚读回来）滑块也只能原地出现，否则又是一次"自己动了一下"。
  const indicatorRef = useSlidingIndicator(groupRef, value, { animated })
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn('relative flex flex-wrap items-center gap-1', className)}
    >
      <span
        ref={indicatorRef}
        aria-hidden
        className={cn('sliding-indicator bg-foreground/[0.08]', size === 'xs' ? 'rounded-md' : 'rounded-lg')}
      />
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex items-center justify-center rounded-lg font-medium outline-none disabled:pointer-events-none disabled:opacity-50',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              animated && 'transition-colors',
              size === 'xs' ? 'h-6 rounded-md px-2 text-xs' : size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              // 选中项的 hover 叠在滑块上：0.08 + 0.05 ≈ 原来的 0.13。
              isActive
                ? 'bg-transparent text-foreground hover:bg-foreground/[0.05]'
                : 'bg-transparent text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
