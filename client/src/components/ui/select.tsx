import { forwardRef, useState, useRef, useEffect } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options?: SelectOption[]
  children?: React.ReactNode
  className?: string
  placeholder?: string
  disabled?: boolean
}

const Select = forwardRef<HTMLDivElement, SelectProps>(
  ({ value, onChange, options, children, className, placeholder = '请选择', disabled = false }, ref) => {
    const [isOpen, setIsOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    // 如果传入了 children（原生 option），则解析它们
    const parsedOptions: SelectOption[] = options || []
    
    if (!options && children) {
      const childArray = Array.isArray(children) ? children : [children]
      childArray.forEach((child: any) => {
        if (child?.type === 'option') {
          parsedOptions.push({
            value: child.props.value || '',
            label: child.props.children || '',
          })
        }
      })
    }

    const selectedOption = parsedOptions.find((opt) => opt.value === value)

    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
          setIsOpen(false)
        }
      }

      if (isOpen) {
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
      }
    }, [isOpen])

    const handleSelect = (optionValue: string) => {
      onChange(optionValue)
      setIsOpen(false)
    }

    return (
      <div ref={containerRef} className={cn('relative', className)}>
        <button
          ref={ref as any}
          type="button"
          onClick={() => !disabled && setIsOpen(!isOpen)}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between rounded-md border border-input-border bg-input-bg px-3 text-sm text-foreground transition-colors',
            'hover:border-muted-foreground/40 focus:border-input-focus-border focus:outline-none focus:ring-2 focus:ring-input-focus-ring/20',
            'disabled:cursor-not-allowed disabled:opacity-50',
            isOpen && 'border-input-focus-border ring-2 ring-input-focus-ring/20',
          )}
        >
          <span className={cn('truncate', !selectedOption && 'text-input-placeholder')}>
            {selectedOption?.label || placeholder}
          </span>
          <ChevronDown
            className={cn(
              'ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              isOpen && 'rotate-180',
            )}
          />
        </button>

        {isOpen && (
          <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
            <div className="custom-scrollbar max-h-60 overflow-y-auto py-1">
              {parsedOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors',
                    option.value === value
                      ? 'bg-primary/5 text-primary font-medium'
                      : 'text-foreground hover:bg-accent',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {option.value === value && <Check className="ml-2 h-4 w-4 shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  },
)

Select.displayName = 'Select'

export { Select }
