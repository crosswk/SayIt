import { Check, type LucideProps } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * "已复制 / 已保存"那一下的对勾：描线画出来，轻轻弹一下（动画见 index.css 的 .success-check）。
 *
 * 只在**状态刚变成成功**时挂载它：动画跟着挂载播一次。所以调用处保持
 * `copied ? <SuccessCheck/> : <Copy/>` 这种二选一的写法就对了，别让它常驻再切 class。
 */
export function SuccessCheck({ className, ...props }: LucideProps) {
  return <Check aria-hidden {...props} className={cn('success-check', className)} />
}
