import * as bridge from '@/services/bridge'
import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import {
  displayAccelerator,
  eventToAccelerator,
  getSingleKeyDisplay,
  resolveSingleKeyShortcut,
} from './utils'

export function PTTShortcutInput({
  value,
  onChange,
  label,
  description,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  description: string
}) {
  const [recording, setRecording] = useState(false)

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const mapped = resolveSingleKeyShortcut(event.code)
    if (mapped) {
      onChange(mapped)
      setRecording(false)
    }
  }, [onChange])

  useEffect(() => {
    if (!recording) return
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [recording, handleKeyDown])

  const displayName = value ? getSingleKeyDisplay(value) : '未设置'

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setRecording(!recording)}
          className={`flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm transition-colors ${
            recording
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
              : 'border-input bg-muted hover:bg-accent'
          }`}
        >
          {recording ? (
            <span className="animate-pulse text-muted-foreground">按下按键...</span>
          ) : (
            <span className={`rounded border bg-card px-2 py-0.5 text-xs shadow-sm ${!value ? 'text-muted-foreground' : ''}`}>{displayName}</span>
          )}
        </button>

        {!recording && value && (
          <button
            onClick={() => onChange('')}
            className="rounded p-1 hover:bg-accent"
            title="清空快捷键"
            aria-label="清空快捷键"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>
    </div>
  )
}

export function ComboShortcutInput({
  value,
  onChange,
  label,
  description,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  description: string
}) {
  const [recording, setRecording] = useState(false)
  const [tempValue, setTempValue] = useState('')

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()

    // 优先检查是否为单键（和 PTT 一样的单键列表）
    const singleKey = resolveSingleKeyShortcut(event.code)
    if (singleKey) {
      setTempValue(singleKey)
      return
    }

    // 否则尝试组合键
    const accelerator = eventToAccelerator(event)
    if (accelerator) setTempValue(accelerator)
  }, [])

  const handleKeyUp = useCallback(() => {
    if (!tempValue) return

    // 如果是单键，直接保存
    const isSingle = resolveSingleKeyShortcut(tempValue) !== undefined
    if (isSingle) {
      onChange(tempValue)
      setRecording(false)
      setTempValue('')
      return
    }

    // 组合键需要验证
    bridge.testShortcut(tempValue).then((valid) => {
      if (valid) onChange(tempValue)
      setRecording(false)
      setTempValue('')
    })
  }, [tempValue, onChange])

  useEffect(() => {
    if (!recording) return

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [recording, handleKeyDown, handleKeyUp])

  // 显示：单键用 getSingleKeyDisplay，组合键用 displayAccelerator
  const isSingleKey = resolveSingleKeyShortcut(tempValue || value) !== undefined
  const displayValue = tempValue || value || ''
  const keys = isSingleKey
    ? [getSingleKeyDisplay(displayValue)]
    : displayAccelerator(displayValue)

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setRecording(!recording)
            setTempValue('')
          }}
          className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm transition-colors ${
            recording
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
              : 'border-input bg-muted hover:bg-accent'
          }`}
        >
          {recording && !tempValue ? (
            <span className="animate-pulse text-muted-foreground">按下按键...</span>
          ) : (
            keys.map((key, index) => (
              <span key={index}>
                {index > 0 && <span className="mx-0.5 text-muted-foreground">+</span>}
                <span className="rounded border bg-card px-1.5 py-0.5 text-xs shadow-sm">{key}</span>
              </span>
            ))
          )}
        </button>

        {!recording && (
          <button
            onClick={() => onChange('')}
            className="rounded p-1 hover:bg-accent"
            aria-label="清空快捷键"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>
    </div>
  )
}
