import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useSortable, DragHandle } from '@/components/ui/sortable'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { Segmented } from '@/components/ui/segmented'
import {
  getBuiltinPromptPresets,
  type BuiltinPromptLanguage,
  type PromptPreset,
} from '@/services/store'
import { ComboShortcutInput, type ShortcutValidate } from './ShortcutInputs'
import { displayAccelerator } from './utils'
import { useT } from '@/i18n/useT'
import { promptPresetDisplayName } from '@/i18n/displayNames'
import { IS_MAC } from '@/lib/platform'
import type { TranslationKey } from '@/i18n'
import { InfoTip } from '@/components/ui/info-tip'

/** 内置润色模式的一句话说明（按 id）。用户改过内置提示词也还是这个模式，说明不变。 */
const BUILTIN_PRESET_DESC: Record<string, TranslationKey> = {
  intent: 'promptPreset.builtinDesc.intent',
  faithful: 'promptPreset.builtinDesc.faithful',
  zh2en: 'promptPreset.builtinDesc.zh2en',
  casual: 'promptPreset.builtinDesc.casual',
}

export default function PromptPresetSection({
  presets,
  activePresetId,
  editingPreset,
  presetShortcuts,
  editingShortcut,
  promptLanguage,
  promptLanguageChanging,
  onSelectPreset,
  onPromptLanguageChange,
  onStartNewPreset,
  onStartEditing,
  onEditingPresetChange,
  onEditingShortcutChange,
  onCancelEditing,
  onSavePreset,
  onDeletePreset,
  onMovePreset,
  validateShortcut,
}: {
  presets: PromptPreset[]
  activePresetId: string
  editingPreset: PromptPreset | null
  presetShortcuts: Record<string, string>
  /** 编辑中的快捷键草稿。**不即时落库** —— 见下方 onEditingShortcutChange 的说明 */
  editingShortcut: string
  promptLanguage: BuiltinPromptLanguage
  promptLanguageChanging?: boolean
  onSelectPreset: (id: string) => void
  onPromptLanguageChange: (language: BuiltinPromptLanguage) => void
  onStartNewPreset: () => void
  onStartEditing: (preset: PromptPreset) => void
  onEditingPresetChange: (preset: PromptPreset) => void
  /**
   * 只改草稿，保存时才写库。
   * 以前这里是即时写库的，于是：给还没保存的新模式设了快捷键再点取消，会留下一条指向
   * 不存在模式的快捷键；而且写入时为保证组合键唯一会把占用同一组合键的旧模式清掉，
   * 取消后那个旧模式的快捷键也回不来了。
   */
  onEditingShortcutChange: (accelerator: string) => void
  onCancelEditing: () => void
  onSavePreset: (preset: PromptPreset) => void
  onDeletePreset: (id: string) => void
  /** 拖拽调整自定义模式的顺序（下标是在"自定义"这一段里的下标；内置顺序固定） */
  onMovePreset: (from: number, to: number) => void
  validateShortcut?: ShortcutValidate
}) {
  const t = useT()
  const presetSortable = useSortable({ onMove: onMovePreset })
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [templateId, setTemplateId] = useState('')
  const editingPresetName = editingPreset ? promptPresetDisplayName(editingPreset) : ''

  // 是否在"新建"（草稿的 id 还不在已有列表里）
  const isCreating = !!editingPreset && !presets.some((preset) => preset.id === editingPreset.id)

  // 打开表单时把焦点放到名称框。
  // 依赖**只能**是 id / builtin 这类原始值：editingPreset 每次输入都是新对象，
  // 把它列进依赖会导致每敲一个字都重新聚焦，光标从提示词框被拽回名称框。
  const editingId = editingPreset?.id ?? null
  const editingBuiltin = !!editingPreset?.builtin
  useEffect(() => {
    if (!editingId) {
      setTemplateId('')
      return
    }
    if (!editingBuiltin) nameInputRef.current?.focus()
  }, [editingId, editingBuiltin])

  const applyTemplate = (id: string) => {
    setTemplateId(id)
    if (!id || !editingPreset) return
    const source = presets.find((preset) => preset.id === id)
    if (source) onEditingPresetChange({ ...editingPreset, systemPrompt: source.systemPrompt })
  }

  const missingName = !!editingPreset && !editingPreset.name.trim()
  const missingPrompt = !!editingPreset && !editingPreset.systemPrompt.trim()

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-[18rem]">
            <div className="flex items-center gap-1.5">
              <h2 className="text-lg font-semibold">{t('promptPreset.title')}</h2>
              <InfoTip content={t('promptPreset.desc')} label={t('promptPreset.title')} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Segmented
              label={t('promptPreset.promptLanguage')}
              value={promptLanguage}
              options={[
                { value: 'zh-CN', label: t('promptPreset.languageZh') },
                { value: 'en', label: t('promptPreset.languageEn') },
              ]}
              onChange={onPromptLanguageChange}
              size="sm"
              disabled={promptLanguageChanging}
              className="gap-1"
            />
            <button
              onClick={onStartNewPreset}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
            >
              <Plus className="h-3 w-3" /> {t('promptPreset.new')}
            </button>
          </div>
        </div>

        {/* 编辑/新建表单放在列表**上方**：以前在整个列表下面，列表一长就在屏幕外，
            点了「新建」看着像没反应。 */}
        {editingPreset && (
          <div className="mb-4 space-y-3 rounded-lg border border-primary/30 bg-muted p-4">
            <p className="text-sm font-medium">{isCreating ? t('promptPreset.createTitle') : t('promptPreset.editTitle', { name: editingPresetName })}</p>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">{t('promptPreset.name')}</label>
              <input
                ref={nameInputRef}
                value={editingPreset.builtin ? editingPresetName : editingPreset.name}
                onChange={(event) => onEditingPresetChange({ ...editingPreset, name: event.target.value })}
                placeholder={t('promptPreset.namePlaceholder')}
                className="h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm"
                disabled={editingPreset.builtin}
              />
            </div>

            {/* 新建时给个起点：从零写 System Prompt 门槛太高，内置模式本身就是好模板 */}
            {isCreating && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">{t('promptPreset.template')}</label>
                <Select
                  value={templateId}
                  onChange={applyTemplate}
                  options={[
                    { value: '', label: t('promptPreset.noTemplate') },
                    ...presets.map((preset) => ({
                      value: preset.id,
                      label: preset.builtin
                        ? t('promptPreset.builtinSuffix', { name: promptPresetDisplayName(preset) })
                        : preset.name,
                    })),
                  ]}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t('promptPreset.templateHint')}
                </p>
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">{t('promptPreset.systemPrompt')}</label>
              <p className="mb-2 text-xs text-muted-foreground">
                {t('promptPreset.systemPromptHint')}
              </p>
              <textarea
                value={editingPreset.systemPrompt}
                onChange={(event) => onEditingPresetChange({ ...editingPreset, systemPrompt: event.target.value })}
                placeholder={t('promptPreset.systemPromptPlaceholder')}
                rows={8}
                className="w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
              />
            </div>

            <div className="border-t border-border/60 pt-3">
              <ComboShortcutInput
                value={editingShortcut}
                onChange={onEditingShortcutChange}
                validate={validateShortcut}
                label={t('promptPreset.shortcut')}
                description={t(IS_MAC ? 'promptPreset.shortcutHintMac' : 'promptPreset.shortcutHint')}
                comboOnly
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              {/* 保存不可点时说明原因，而不是干灰着 */}
              {(missingName || missingPrompt) && (
                <span className="mr-auto text-xs text-muted-foreground">
                  {missingName && missingPrompt
                    ? t('promptPreset.missingBoth')
                    : missingName ? t('promptPreset.missingName') : t('promptPreset.missingPrompt')}
                </span>
              )}

              {editingPreset.builtin && (
                <button
                  onClick={() => {
                    const language = editingPreset.builtinPromptLanguage ?? promptLanguage
                    const original = getBuiltinPromptPresets(language)
                      .find((builtin) => builtin.id === editingPreset.id)
                    if (original) onEditingPresetChange({ ...original })
                  }}
                  className="px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t('promptPreset.restoreDefault')}
                </button>
              )}

              <button
                onClick={onCancelEditing}
                className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-accent"
              >
                {t('promptPreset.cancel')}
              </button>
              <button
                disabled={missingName || missingPrompt}
                onClick={() => onSavePreset(editingPreset)}
                className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {t('promptPreset.save')}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {presets.map((preset) => {
            const customPresets = presets.filter((item) => !item.builtin)
            const customIndex = customPresets.findIndex((item) => item.id === preset.id)
            const canMove = !preset.builtin && customPresets.length > 1
            const presetName = promptPresetDisplayName(preset)
            return (
              <div
                key={preset.id}
                {...(canMove ? presetSortable.rowProps(customIndex) : {})}
                className={`group cursor-pointer rounded-lg border p-3 transition-colors ${activePresetId === preset.id
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border hover:bg-accent/50'
                  } ${canMove ? presetSortable.rowClassName(customIndex) : ''}`}
                onClick={() => onSelectPreset(preset.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    {canMove && (
                      <DragHandle
                        {...presetSortable.handleProps(customIndex, t('promptPreset.drag', { name: presetName }))}
                        onClick={(event) => event.stopPropagation()}
                      />
                    )}
                    <div
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${activePresetId === preset.id ? 'border-primary' : 'border-muted-foreground/40'
                        }`}
                    >
                      {activePresetId === preset.id && <div className="h-2 w-2 rounded-full bg-primary" />}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{presetName}</p>
                        {preset.builtin && (
                          <span className="rounded border px-1 text-xs text-muted-foreground">{t('promptPreset.builtin')}</span>
                        )}
                        {preset.builtinPromptModified && (
                          <span className="rounded border border-warning/40 bg-warning/10 px-1 text-xs text-warning-strong">
                            {preset.builtinPromptUpdateAvailable
                              ? t('promptPreset.updateAvailable')
                              : t('promptPreset.modified')}
                          </span>
                        )}
                        {presetShortcuts[preset.id] && (
                          <span className="rounded border border-primary/30 bg-primary/5 px-1.5 text-xs text-muted-foreground">
                            {displayAccelerator(presetShortcuts[preset.id]).join('+')}
                          </span>
                        )}
                      </div>
                      {/* 原来显示提示词原文的前 60 个字（「你是语音文本精炼助手。输入是 ASR……」），
                          看不出几个模式的区别。内置模式改成一句说明；自建模式没有说明，只显示名字。 */}
                      {BUILTIN_PRESET_DESC[preset.id] && (
                        <p className="truncate text-xs text-muted-foreground">{t(BUILTIN_PRESET_DESC[preset.id])}</p>
                      )}
                    </div>
                  </div>

                  <div className="ml-2 flex shrink-0 items-center gap-1">
                    <button
                      onClick={(event) => {
                        event.stopPropagation()
                        onStartEditing({ ...preset })
                      }}
                      className="rounded p-1.5 hover:bg-accent"
                      aria-label={t('promptPreset.edit')}
                    >
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>

                    {!preset.builtin && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation()
                          onDeletePreset(preset.id)
                        }}
                        className="rounded p-1.5 hover:bg-accent"
                        aria-label={t('promptPreset.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
