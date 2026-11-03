import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2, Crosshair } from 'lucide-react'
import * as bridge from '@/services/bridge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useSortable, DragHandle } from '@/components/ui/sortable'
import { cn } from '@/lib/utils'
import type { PromptPreset } from '@/services/store'
import type { AppPromptRule } from '@/services/personalization/types'
import { useT } from '@/i18n/useT'
import { appPromptRuleDisplayName, promptPresetDisplayName } from '@/i18n/displayNames'
import { InfoTip } from '@/components/ui/info-tip'
import { IS_MAC } from '@/lib/platform'

/**
 * 「检测当前应用」的倒计时秒数。
 *
 * 这段时间是留给用户切窗口的：点完按钮得 Alt+Tab 或用鼠标找到目标程序并点进去，
 * 3 秒对着一堆窗口翻找根本不够，超时后读到的还是 SayIt 自己，白跑一轮。
 * 界面上的按钮文字与提示都从这个值推导，改这里一处即可。
 */
const DETECT_COUNTDOWN_SEC = 5

/**
 * 只展示"真正决定命中"的条件。
 * 写了进程名的规则一律只按进程名判定（见 promptRouter.matchesAppPromptRule），
 * 此时再把窗口标题/类名列出来会让人误以为它们也会触发。
 */
function formatMatcher(rule: AppPromptRule, t: ReturnType<typeof useT>) {
  if (rule.matcher.processNames.length > 0) {
    return t(IS_MAC ? 'appPrompt.matcherProcessMac' : 'appPrompt.matcherProcess', { value: rule.matcher.processNames.join(', ') })
  }
  const parts: string[] = []
  if (rule.matcher.windowTitleIncludes?.length) {
    parts.push(t('appPrompt.matcherWindow', { value: rule.matcher.windowTitleIncludes.join(', ') }))
  }
  if (rule.matcher.windowClasses?.length) {
    parts.push(t('appPrompt.matcherClass', { value: rule.matcher.windowClasses.join(', ') }))
  }
  if (rule.matcher.automationIds?.length) {
    parts.push(t('appPrompt.matcherControl', { value: rule.matcher.automationIds.join(', ') }))
  }
  return parts.join(' | ')
}

function isSameRule(left: AppPromptRule, right: AppPromptRule) {
  return JSON.stringify(left) === JSON.stringify(right)
}

type DetectHint =
  | { kind: 'missing' | 'sayit' | 'failed' }
  | { kind: 'found'; process: string; title: string }
  | null

export default function AppPromptRulesSection({
  presets,
  rules,
  onSaveRule,
  onToggleRule,
  onMoveRule,
  onResetRule,
  onCreateRule,
  onDeleteRule,
}: {
  presets: PromptPreset[]
  rules: AppPromptRule[]
  onSaveRule: (rule: AppPromptRule) => Promise<void> | void
  /** 开关不走草稿，按下即落库（并把启用的规则置顶），见 AIInstructionsPage.handleToggleAppRule */
  onToggleRule: (ruleId: string, enabled: boolean) => Promise<void> | void
  onMoveRule: (from: number, to: number) => Promise<void> | void
  onResetRule: (ruleId: string) => Promise<void> | void
  onCreateRule: (draft: { name: string; processNames: string[]; presetId?: string; promptAppend: string }) => Promise<void> | void
  onDeleteRule: (ruleId: string) => Promise<void> | void
}) {
  const t = useT()
  const [drafts, setDrafts] = useState<Record<string, AppPromptRule>>({})
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set())
  const [savingId, setSavingId] = useState<string | null>(null)
  // 新建规则表单（null = 未展开）
  const [newRule, setNewRule] = useState<{ name: string; processName: string; presetId: string; promptAppend: string } | null>(null)
  // 「检测当前应用」倒计时：给用户时间切到目标程序，否则测到的就是 SayIt 自己
  const [countdown, setCountdown] = useState(0)
  const [detectHint, setDetectHint] = useState<DetectHint>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  /** 上一轮的已存值，用来分辨"外部真改了内容"和"只是开关或顺序变了" */
  const savedSnapshot = useRef<Record<string, AppPromptRule>>({})

  const canSort = rules.length > 1
  const ruleSortable = useSortable({ onMove: (from, to) => void onMoveRule(from, to) })

  useEffect(() => {
    setDrafts((current) => {
      const nextDrafts: Record<string, AppPromptRule> = {}
      for (const rule of rules) {
        const previous = savedSnapshot.current[rule.id]
        const draft = current[rule.id]
        // 开关和拖拽都是即时落库的，一动就会走到这里。此时若把草稿整个重置，
        // 用户正在编辑、还没点"保存规则"的附加提示词就被静默冲掉了。
        // 所以只在「除 enabled 之外确实变了」（保存过、恢复默认）时才用已存值覆盖草稿。
        const contentChanged = !previous || !isSameRule({ ...previous, enabled: rule.enabled }, rule)
        nextDrafts[rule.id] = draft && !contentChanged
          ? { ...draft, enabled: rule.enabled }
          : { ...rule, matcher: { ...rule.matcher } }
      }
      return nextDrafts
    })
    savedSnapshot.current = Object.fromEntries(rules.map((rule) => [rule.id, rule]))
  }, [rules])

  const presetOptions = [
    { id: '', name: t('appPrompt.inheritGlobal') },
    ...presets.map((preset) => ({ id: preset.id, name: promptPresetDisplayName(preset) })),
  ]

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

  /**
   * 启用/停用即时落库（不需要再点"保存规则"）—— 开关是个状态类控件，
   * 按下去却要另外点保存才算数，用户会以为已经生效了。
   *
   * 展开状态只由用户点标题行决定：载入时一律折叠，启用/停用也不碰它。
   * 以前「已启用就展开、刚启用就展开」，规则一多，页面一进来就是一长串展开的配置，
   * 用户明确要求改掉（2026-10）。别加回去。
   */
  const handleToggle = (rule: AppPromptRule) => {
    void onToggleRule(rule.id, !rule.enabled)
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

  /**
   * 检测当前应用：先倒计时，让用户切到目标程序，再读前台窗口的进程名。
   * 直接读的话只会读到 SayIt 自己（用户正在点这个按钮）。
   */
  const detectCurrentApp = async () => {
    setDetectHint(null)
    for (let s = DETECT_COUNTDOWN_SEC; s > 0; s -= 1) {
      setCountdown(s)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    setCountdown(0)
    try {
      const ctx = await bridge.getActiveAppContext()
      // mac 上可执行文件名不可靠（VS Code 叫 Electron），优先用 Bundle ID
      const raw = String(((IS_MAC ? ctx?.bundleId || ctx?.processName : ctx?.processName) as string) || '').trim()
      if (!raw) {
        setDetectHint({ kind: 'missing' })
        return
      }
      if (raw.toLowerCase() === 'sayit.exe' || raw.toLowerCase() === 'com.sayit.app') {
        setDetectHint({ kind: 'sayit' })
        return
      }
      setNewRule((current) => (current ? { ...current, processName: raw } : current))
      const title = String((ctx?.windowTitle as string) || '').trim()
      setDetectHint({ kind: 'found', process: raw, title })
    } catch {
      setDetectHint({ kind: 'failed' })
    }
  }

  const handleCreate = async () => {
    if (!newRule) return
    const name = newRule.name.trim()
    const processNames = newRule.processName
      .split(/[,\uFF0C\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (!name || processNames.length === 0) return
    await onCreateRule({
      name,
      processNames,
      presetId: newRule.presetId || undefined,
      promptAppend: newRule.promptAppend.trim(),
    })
    setNewRule(null)
    setDetectHint(null)
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
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-lg font-semibold">{t('appPrompt.title')}</h2>
              {/* 完整说明（内置了哪些应用、匹配顺序）收进 ⓘ：应用清单就在下面，正文再列一遍是重复 */}
              <InfoTip
                content={(
                  <div className="space-y-2">
                    <p>{t(IS_MAC ? 'appPrompt.descMac' : 'appPrompt.desc')}</p>
                    <p>{t('appPrompt.orderHint')}</p>
                  </div>
                )}
                label={t('appPrompt.title')}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('appPrompt.shortDesc')}
            </p>
          </div>
          {!newRule && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => { setNewRule({ name: '', processName: '', presetId: '', promptAppend: '' }); setDetectHint(null) }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('appPrompt.newRule')}
            </Button>
          )}
        </div>

        {/* 新建规则表单 */}
        {newRule && (
          <div className="rounded-lg border border-dashed p-4">
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t('appPrompt.appName')}</label>
                  <input
                    value={newRule.name}
                    onChange={(event) => setNewRule({ ...newRule, name: event.target.value })}
                    placeholder={t('appPrompt.appNamePlaceholder')}
                    className="w-full rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t(IS_MAC ? 'appPrompt.processNameMac' : 'appPrompt.processName')}</label>
                  <div className="flex gap-2">
                    <input
                      value={newRule.processName}
                      onChange={(event) => setNewRule({ ...newRule, processName: event.target.value })}
                      placeholder={t(IS_MAC ? 'appPrompt.processPlaceholderMac' : 'appPrompt.processPlaceholder')}
                      className="w-0 flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 gap-1.5"
                      disabled={countdown > 0}
                      onClick={() => void detectCurrentApp()}
                    >
                      <Crosshair className="h-3.5 w-3.5" />
                      {countdown > 0 ? t('appPrompt.detectCountdown', { seconds: countdown }) : t('appPrompt.detectCurrent')}
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {countdown > 0
                  ? t('appPrompt.switchHint')
                  : detectHint?.kind === 'found'
                    ? t('appPrompt.detectFound', {
                      process: detectHint.process,
                      title: detectHint.title ? t('appPrompt.detectTitle', { title: detectHint.title }) : '',
                    })
                    : detectHint
                      ? t(detectHint.kind === 'sayit'
                        ? 'appPrompt.detectSayIt'
                        : detectHint.kind === 'missing'
                          ? (IS_MAC ? 'appPrompt.detectMissingMac' : 'appPrompt.detectMissing')
                          : (IS_MAC ? 'appPrompt.detectFailedMac' : 'appPrompt.detectFailed'))
                      : t(IS_MAC ? 'appPrompt.detectHintMac' : 'appPrompt.detectHint', { seconds: DETECT_COUNTDOWN_SEC })}
              </p>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{t('appPrompt.basePreset')}</label>
                <Select
                  value={newRule.presetId}
                  onChange={(value) => setNewRule({ ...newRule, presetId: value })}
                  options={presetOptions.map((opt) => ({ value: opt.id, label: opt.name }))}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">{t('appPrompt.appendPrompt')}</label>
                <textarea
                  value={newRule.promptAppend}
                  onChange={(event) => setNewRule({ ...newRule, promptAppend: event.target.value })}
                  rows={2}
                  className="w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
                  placeholder={t('appPrompt.appendPlaceholderNew')}
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { setNewRule(null); setDetectHint(null) }}
                  className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                >
                  {t('appPrompt.cancel')}
                </button>
                <button
                  disabled={!newRule.name.trim() || !newRule.processName.trim()}
                  onClick={() => void handleCreate()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {t('appPrompt.add')}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {rules.map((rule, index) => {
            const draft = drafts[rule.id] || rule
            const dirty = !isSameRule(draft, rule)
            const isExpanded = expandedRules.has(rule.id)

            return (
              <div
                key={rule.id}
                {...(canSort ? ruleSortable.rowProps(index) : {})}
                className={cn('group rounded-lg border bg-card', canSort && ruleSortable.rowClassName(index))}
              >
                {/* 标题栏 */}
                <div
                  className="flex cursor-pointer items-center justify-between gap-4 rounded-t-lg bg-muted/30 px-4 py-2.5"
                  onClick={() => toggleExpanded(rule.id)}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {canSort && (
                      <DragHandle
                        {...ruleSortable.handleProps(index, t('appPrompt.drag', { name: appPromptRuleDisplayName(rule) }))}
                        onClick={(event) => event.stopPropagation()}
                      />
                    )}
                    <div className="shrink-0">
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>

                    <p className="text-sm font-medium">{appPromptRuleDisplayName(rule)}</p>
                    <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground/50">{rule.builtin ? t('appPrompt.builtin') : t('appPrompt.custom')}</span>
                    <p className="ml-1 truncate text-xs text-muted-foreground/50">{formatMatcher(rule, t)}</p>
                  </div>

                  <div onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule)}
                    />
                  </div>
                </div>

                {/* 展开内容 */}
                {isExpanded && (
                  <div className="border-t px-4 pb-3 pt-3">
                    <div className="space-y-3">
                      {!rule.builtin && (
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-foreground">{t(IS_MAC ? 'appPrompt.processNameMac' : 'appPrompt.processName')}</label>
                          <input
                            value={(draft.matcher.processNames || []).join(', ')}
                            onChange={(event) => updateDraft(rule.id, {
                              matcher: {
                                ...draft.matcher,
                                processNames: event.target.value.split(/[,\uFF0C\s]+/).map((s) => s.trim()).filter(Boolean),
                              },
                            })}
                            placeholder={t(IS_MAC ? 'appPrompt.processPlaceholderMac' : 'appPrompt.processPlaceholder')}
                            className="w-full rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                          />
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">{t('appPrompt.basePreset')}</label>
                        <Select
                          value={draft.presetId || ''}
                          onChange={(value) => updateDraft(rule.id, { presetId: value || undefined })}
                          options={presetOptions.map((opt) => ({ value: opt.id, label: opt.name }))}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-foreground">{t('appPrompt.appendPrompt')}</label>
                        <textarea
                          value={draft.promptAppend}
                          onChange={(event) => updateDraft(rule.id, { promptAppend: event.target.value })}
                          rows={1}
                          className="w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
                          style={{ fieldSizing: 'content' as never, minHeight: '2.25rem', maxHeight: '7rem' }}
                          placeholder={t('appPrompt.appendPlaceholder')}
                        />
                      </div>

                      <div className="flex justify-end gap-2">
                        {rule.builtin ? (
                          <button
                            onClick={() => void onResetRule(rule.id)}
                            className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                          >
                            {t('appPrompt.restoreDefault')}
                          </button>
                        ) : deletingId === rule.id ? (
                          <>
                            <button
                              onClick={() => setDeletingId(null)}
                              className="rounded-md border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                            >
                              {t('appPrompt.cancel')}
                            </button>
                            <button
                              onClick={() => { setDeletingId(null); void onDeleteRule(rule.id) }}
                              className="rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground transition-colors hover:bg-destructive/90"
                            >
                              {t('appPrompt.confirmDelete')}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeletingId(rule.id)}
                            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t('appPrompt.delete')}
                          </button>
                        )}
                        <button
                          disabled={!dirty || savingId === rule.id}
                          onClick={() => void handleSave(rule.id)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                        >
                          {savingId === rule.id ? t('appPrompt.saving') : t('appPrompt.saveRule')}
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
