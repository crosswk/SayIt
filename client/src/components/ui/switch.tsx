import { cn } from '@/lib/utils'

interface SwitchProps {
  checked: boolean
  onChange: () => void
  label?: string
  disabled?: boolean
  className?: string
  /** 'sm' 适合紧凑列表行 */
  size?: 'default' | 'sm'
}

/**
 * 统一 Switch 开关组件
 * default: h-6 w-11 / sm: h-4 w-7
 */
export function Switch({ checked, onChange, label, disabled, className, size = 'default' }: SwitchProps) {
  const sm = size === 'sm'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={cn('inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50', className)}
    >
      <span
        className={cn(
          'relative shrink-0 rounded-full transition-colors',
          sm ? 'h-4 w-7' : 'h-6 w-11',
          checked ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute left-0.5 top-0.5 rounded-full bg-card shadow transition-transform',
            sm ? 'h-3 w-3' : 'h-5 w-5',
            checked && (sm ? 'translate-x-3' : 'translate-x-5'),
          )}
        />
      </span>
      {label && <span className="text-sm">{label}</span>}
    </button>
  )
}
