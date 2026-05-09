import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { PromptPreset } from '@/services/store'
import type { AppPromptRule } from '@/services/personalization/types'

function formatMatcher(rule: AppPromptRule) {
  const parts: string[] = []
  if (rule.matcher.processNames.length > 0) {
    parts.push(`进程: ${rule.matcher.processNames.join(', ')}`)
  }
  if (rule.matcher.windowTitleIncludes?.length) {
    parts.push(`窗口: ${rule.matcher.windowTitleIncludes.join(', ')}`)
  }
  if (rule.matcher.windowClasses?.length) {
    parts.push(`类名: ${rule.matcher.windowClasses.join(', ')}`)
  }
  if (rule.matcher.automationIds?.length) {
    parts.push(`控件: ${rule.matcher.automationIds.join(', ')}`)
  }
  return parts.join(' | ')
}

function isSameRule(left: AppPromptRule, right: AppPromptRule) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export default function AppPromptRulesSection({
  presets,
  rules,
  onSaveRule,
  onResetRule,
}: {
  presets: PromptPreset[]
  rules: AppPromptRule[]
  onSaveRule: (rule: AppPromptRule) => Promise<void> | void
  onResetRule: (ruleId: string) => Promise<void> | void
}) {
  const [drafts, setDrafts] = useState<Record<string, AppPromptRule>>({})
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set())
  const [savingId, setSavingId] = useState<string | null>(null)

  useEffect(() => {
    const nextDrafts: Record<string, AppPromptRule> = {}
    const expanded = new Set<string>()
    for (const rule of rules) {
      nextDrafts[rule.id] = { ...rule, matcher: { ...rule.matcher } }
      if (rule.enabled) {
        expanded.add(rule.id)
      }
    }
    setDrafts(nextDrafts)
    setExpandedRules(expanded)
  }, [rules])

  const presetOptions = useMemo(
    () => [{ id: '', name: '继承当前全局预设' }, ...presets.map((preset) => ({ id: preset.id, name: preset.name }))],
    [presets],
  )

  const updateDraft = (ruleId: string, patch: Partial<AppPromptRule>) => {
    setDrafts((current) => {
      const existing = current[ruleId]
      if (!existing) return current
      return {
        ...current,
        [ruleId]: {
          ...existing,
          ...patch,
        },
      }
    })
  }

  const toggleExpanded = (ruleId: string) => {
    setExpandedRules((current) => {
      const next = new Set(current)
      if (next.has(ruleId)) {
        next.delete(ruleId)
      } else {
        next.add(ruleId)
      }
      return next
    })
  }

  const handleSave = async (ruleId: string) => {
    const draft = drafts[ruleId]
    if (!draft) return
    setSavingId(ruleId)
    try {
      await onSaveRule(draft)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <h2 className="text-lg font-semibold">应用 Prompt 规则</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            根据当前输入应用自动切换或增强 Prompt。现阶段内置 Teams、Outlook、Kiro、VSCode、Cursor。
          </p>
        </div>

        <div className="space-y-2">
          {rules.map((rule) => {
            const draft = drafts[rule.id] || rule
            const dirty = !isSameRule(draft, rule)
            const isExpanded = expandedRules.has(rule.id)
            
            return (
              <div key={rule.id} className="rounded-lg border bg-card">
                {/* 标题栏 */}
                <div
                  className="flex cursor-pointer items-center justify-between gap-4 rounded-t-lg bg-muted/30 px-4 py-2.5"
                  onClick={() => toggleExpanded(rule.id)}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="shrink-0">
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                    
                    <p className="text-sm font-medium">{rule.name}</p>
                    <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground/50">内置</span>
                    <p className="ml-1 truncate text-xs text-muted-foreground/50">{formatMatcher(rule)}</p>
                  </div>

                  <div onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={draft.enabled}
                      onChange={() => updateDraft(rule.id, { enabled: !draft.enabled })}
                    />
                  </div>
                </div>

                {/* 展开内容 */}
                {isExpanded && (
                  <div className="border-t px-4 pb-3 pt-3">
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">基础预设</label>
                        <Select
                          value={draft.presetId || ''}
                          onChange={(value) => updateDraft(rule.id, { presetId: value || undefined })}
                          options={presetOptions.map((opt) => ({ value: opt.id, label: opt.name }))}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">附加提示词</label>
                        <textarea
                          value={draft.promptAppend}
                          onChange={(event) => updateDraft(rule.id, { promptAppend: event.target.value })}
                          rows={1}
                          className="w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
                          style={{ fieldSizing: 'content' as never, minHeight: '2.25rem', maxHeight: '7rem' }}
                          placeholder="补充当前应用的语言风格或格式要求"
                        />
                      </div>

                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => void onResetRule(rule.id)}
                          className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                        >
                          恢复默认
                        </button>
                        <button
                          disabled={!dirty || savingId === rule.id}
                          onClick={() => void handleSave(rule.id)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                        >
                          {savingId === rule.id ? '保存中...' : '保存规则'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
