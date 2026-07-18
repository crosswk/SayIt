import { useEffect, useState } from 'react'
import { BUILTIN_APP_RULES } from '@/services/personalization/defaults'
import {
  getAppPromptRules,
  saveAppPromptRules,
} from '@/services/personalization/store'
import type { AppPromptRule } from '@/services/personalization/types'
import { refreshPreset, refreshRecorderSettings, setActivePresetCache } from '@/services/recorder'
import * as bridge from '@/services/bridge'
import { useActivePreset } from '@/hooks/useActivePreset'
import { refreshActivePreset, setActivePresetKnown } from '@/stores/activePreset'
import {
  deletePromptPreset,
  getPromptPresets,
  getPresetShortcuts,
  savePromptPreset,
  setActivePresetId,
  setPresetShortcuts,
  type PromptPreset,
} from '@/services/store'
import AIProofreadToggle from './AIProofreadToggle'
import HotwordPromptInjectToggle from './HotwordPromptInjectToggle'
import AppPromptRulesSection from './AppPromptRulesSection'
import PromptPresetSection from './PromptPresetSection'

export default function AIInstructionsPage() {
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const activePreset = useActivePreset()
  const activePresetId = activePreset.id
  const [editingPreset, setEditingPreset] = useState<PromptPreset | null>(null)
  const [appPromptRules, setAppPromptRules] = useState<AppPromptRule[]>([])
  const [presetShortcuts, setPresetShortcutsState] = useState<Record<string, string>>({})

  useEffect(() => {
    getPromptPresets().then(setPresets)
    getAppPromptRules().then(setAppPromptRules)
    getPresetShortcuts().then(setPresetShortcutsState)
    void refreshActivePreset()
  }, [])

  const handleSetPresetShortcut = async (presetId: string, accel: string) => {
    const next: Record<string, string> = { ...presetShortcuts }
    if (!accel) {
      delete next[presetId]
    } else {
      // 保证组合键唯一：若其它预设已占用同一组合键，先清除，避免注册冲突
      for (const key of Object.keys(next)) {
        if (next[key] === accel) delete next[key]
      }
      next[presetId] = accel
    }
    setPresetShortcutsState(next)
    await setPresetShortcuts(next)
    bridge.notifyShortcutsChanged()
  }

  const handleSelectPreset = (id: string) => {
    // 立即更新 UI 与录音器缓存（无 IPC），持久化写入放到后台，避免快速切换时卡顿
    const target = presets.find((p) => p.id === id)
    setActivePresetKnown(id, target?.name || '')
    setActivePresetCache(id)
    void setActivePresetId(id)
  }

  const handleSavePreset = async (preset: PromptPreset) => {
    await savePromptPreset(preset)
    setPresets(await getPromptPresets())
    setEditingPreset(null)
    if (preset.id === activePresetId) {
      await refreshPreset()
    }
    // 名称可能已修改，刷新当前预设状态（标题栏/高亮）
    await refreshActivePreset()
  }

  const handleDeletePreset = async (id: string) => {
    await deletePromptPreset(id)
    setPresets(await getPromptPresets())
    // 清除该预设的快捷键映射，避免残留注册
    if (presetShortcuts[id]) {
      const next = { ...presetShortcuts }
      delete next[id]
      setPresetShortcutsState(next)
      await setPresetShortcuts(next)
      bridge.notifyShortcutsChanged()
    }
    if (id === activePresetId) {
      await setActivePresetId('intent')
      await refreshPreset()
      await refreshActivePreset()
    }
  }

  const handleNewPreset = () => {
    setEditingPreset({
      id: Date.now().toString(36),
      name: '',
      systemPrompt: '',
    })
  }

  const handleSaveAppRule = async (rule: AppPromptRule) => {
    const nextRules = appPromptRules
      .map((item) => (item.id === rule.id ? rule : item))
      .sort((left, right) => right.priority - left.priority)
    setAppPromptRules(nextRules)
    await saveAppPromptRules(nextRules)
    await refreshRecorderSettings()
  }

  const handleResetAppRule = async (ruleId: string) => {
    const fallback = BUILTIN_APP_RULES.find((rule) => rule.id === ruleId)
    if (!fallback) return
    const nextRules = appPromptRules
      .map((rule) => (rule.id === ruleId ? { ...fallback, matcher: { ...fallback.matcher } } : rule))
      .sort((left, right) => right.priority - left.priority)
    setAppPromptRules(nextRules)
    await saveAppPromptRules(nextRules)
    await refreshRecorderSettings()
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-2 text-2xl font-bold">AI 整理</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        配置 AI 如何整理识别出的文字（校对开关、提示词预设、按应用的规则）。选择使用哪家 AI，请前往「AI 供应商」。
      </p>

      <div className="space-y-6">
        <AIProofreadToggle />
        <HotwordPromptInjectToggle />

        <PromptPresetSection
          presets={presets}
          activePresetId={activePresetId}
          editingPreset={editingPreset}
          presetShortcuts={presetShortcuts}
          onSelectPreset={handleSelectPreset}
          onStartNewPreset={handleNewPreset}
          onStartEditing={setEditingPreset}
          onEditingPresetChange={setEditingPreset}
          onCancelEditing={() => setEditingPreset(null)}
          onSavePreset={handleSavePreset}
          onDeletePreset={handleDeletePreset}
          onSetPresetShortcut={handleSetPresetShortcut}
        />

        <AppPromptRulesSection
          presets={presets}
          rules={appPromptRules}
          onSaveRule={handleSaveAppRule}
          onResetRule={handleResetAppRule}
        />
      </div>
    </div>
  )
}
