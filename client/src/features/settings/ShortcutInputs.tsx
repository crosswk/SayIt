import * as bridge from '@/services/bridge'
import { useCallback, useEffect, useRef, useState } from 'react'
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

  const handleMouseDown = useCallback((event: MouseEvent) => {
    // button 3 = XButton1 (back), button 4 = XButton2 (forward)
    if (event.button === 3) {
      event.preventDefault()
      event.stopPropagation()
      onChange('MouseBack')
      setRecording(false)
    } else if (event.button === 4) {
      event.preventDefault()
      event.stopPropagation()
      onChange('MouseForward')
      setRecording(false)
    }
  }, [onChange])

  useEffect(() => {
    if (!recording) return
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('mousedown', handleMouseDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('mousedown', handleMouseDown)
    }
  }, [recording, handleKeyDown, handleMouseDown])

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
  comboOnly = false,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  description: string
  /** 仅接受"修饰键+主键"的组合键，拒绝单键/单修饰键（用于预设切换快捷键）。 */
  comboOnly?: boolean
}) {
  const [recording, setRecording] = useState(false)
  const [tempValue, setTempValue] = useState('')
  const [conflict, setConflict] = useState(false)
  // 一次录制只提交/探测一次：松开组合键会产生多个 keyup，
  // 若不加守卫会对同一组合键重复调用 test_shortcut，第二次因“自己刚注册”而误报冲突。
  const committingRef = useRef(false)

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()

    // 非 comboOnly：优先接受单键（如免提用右 Alt）
    if (!comboOnly) {
      const singleKey = resolveSingleKeyShortcut(event.code)
      if (singleKey) {
        setTempValue(singleKey)
        return
      }
    }

    // 组合键：仅当"修饰键 + 主键"时 eventToAccelerator 才返回值；
    // 单独按修饰键（Ctrl/Alt/Shift）返回 null，不会被误提交。
    const accelerator = eventToAccelerator(event)
    if (accelerator) setTempValue(accelerator)
  }, [comboOnly])

  const handleKeyUp = useCallback(() => {
    if (!tempValue || committingRef.current) return

    // 如果是单键：comboOnly 模式拒绝，非 comboOnly 直接保存
    const isSingle = resolveSingleKeyShortcut(tempValue) !== undefined
    if (isSingle) {
      if (comboOnly) return
      committingRef.current = true
      onChange(tempValue)
      setRecording(false)
      setTempValue('')
      return
    }

    // 组合键需要验证（探测是否被其他程序占用）。加守卫避免多次 keyup 重复探测。
    committingRef.current = true
    bridge.testShortcut(tempValue).then((valid) => {
      if (valid) {
        onChange(tempValue)
        setConflict(false)
      } else {
        setConflict(true)
      }
      setRecording(false)
      setTempValue('')
    })
  }, [tempValue, onChange, comboOnly])

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
    <div>
      <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            committingRef.current = false
            setRecording(!recording)
            setTempValue('')
            setConflict(false)
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
      {conflict && (
        <p className="mt-1.5 text-xs text-destructive">该组合键可能已被其他程序占用，请更换后重试</p>
      )}
    </div>
  )
}
