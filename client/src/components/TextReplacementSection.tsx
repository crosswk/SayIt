// 文本替换规则管理组件

import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  getTextReplacements,
  saveTextReplacements,
  type TextReplacementRule,
} from '@/services/textReplacement'

function createId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export default function TextReplacementSection() {
  const [rules, setRules] = useState<TextReplacementRule[]>([])
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')

  useEffect(() => {
    getTextReplacements().then((loaded) => {
      // 兼容旧数据：确保每条规则都有唯一 id 和 enabled 字段
      const migrated = loaded.map((r) => ({
        ...r,
        id: r.id || createId(),
        enabled: r.enabled !== false,
      }))
      setRules(migrated)
    })
  }, [])

  const addRule = useCallback(() => {
    const from = fromInput.trim()
    const to = toInput.trim()
    if (!from) return
    setRules((prev) => {
      if (prev.some((r) => r.from === from)) return prev
      return [...prev, { id: createId(), from, to, enabled: true }]
    })
    setFromInput('')
    setToInput('')
  }, [fromInput, toInput])

  const removeRule = useCallback((id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const toggleRule = useCallback((id: string) => {
    setRules((prev) => {
      const next = prev.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r)
      return next
    })
  }, [])

  // 每次 rules 变化后持久化
  const initialized = useRef(false)
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      return
    }
    void saveTextReplacements(rules)
  }, [rules])

  const enabledCount = rules.filter((r) => r.enabled).length

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">
        识别后自动替换指定文本，例如「安卓说话 → 按住说话」。
        {rules.length > 0 && (
          <span className="ml-2">{enabledCount} 条启用 · 共 {rules.length} 条规则</span>
        )}
      </p>

      {/* 添加新规则 — 两列对齐 */}
      <div className="flex items-center gap-2">
        <input
          value={fromInput}
          onChange={(e) => setFromInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void addRule()
            }
          }}
          placeholder="原文"
          className="w-0 flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
        />
        <input
          value={toInput}
          onChange={(e) => setToInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void addRule()
            }
          }}
          placeholder="替换为（留空则删除）"
          className="w-0 flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
        />
        <Button
          onClick={() => void addRule()}
          size="sm"
          variant="outline"
          disabled={!fromInput.trim()}
          className="shrink-0 gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>

      {/* 规则列表 — 两列布局 */}
      {rules.length > 0 && (
        <div className="mt-4 rounded-lg border border-border overflow-hidden">
          {/* 列头 */}
          <div className="flex items-center border-b border-border bg-muted/30 px-3 py-1.5">
            <span className="w-7 shrink-0" />
            <span className="flex-1 pl-3 text-xs text-muted-foreground">原文</span>
            <span className="mx-3 h-3 w-px shrink-0 bg-border" />
            <span className="flex-1 text-xs text-muted-foreground">替换为</span>
            <span className="w-8 shrink-0" />
          </div>
          {rules.map((rule) => (
            <div
              key={rule.id}
              className={`group flex items-center border-t border-border/60 px-3 py-2 transition-colors hover:bg-accent/40 first:border-t-0 ${
                !rule.enabled ? 'opacity-50' : ''
              }`}
            >
              <Switch
                checked={rule.enabled}
                onChange={() => void toggleRule(rule.id)}
                size="sm"
                className="shrink-0"
              />
              <span className={`flex-1 truncate pl-3 text-sm ${!rule.enabled ? 'line-through text-muted-foreground' : ''}`}>
                {rule.from}
              </span>
              <span className="mx-3 h-4 w-px shrink-0 bg-border/50" />
              <span className="flex-1 truncate text-sm text-muted-foreground">
                {rule.to || <span className="italic text-muted-foreground/50">删除</span>}
              </span>
              <button
                onClick={() => void removeRule(rule.id)}
                className="w-8 shrink-0 flex justify-center rounded-full p-1 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label={`删除 ${rule.from}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {rules.length === 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-border py-8 text-center">
          <p className="text-sm text-muted-foreground">还没有替换规则，在上方添加第一条吧</p>
        </div>
      )}
    </div>
  )
}
