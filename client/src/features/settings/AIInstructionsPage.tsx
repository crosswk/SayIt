import { useEffect, useState } from 'react'
import { BUILTIN_APP_RULES } from '@/services/personalization/defaults'
import {
  getAppPromptRules,
  saveAppPromptRules,
} from '@/services/personalization/store'
import type { AppPromptRule } from '@/services/personalization/types'
import { refreshPreset, refreshRecorderSettings } from '@/services/recorder'
import {
  deletePromptPreset,
  getActivePresetId,
  getPromptPresets,
  savePromptPreset,
  setActivePresetId,
  type PromptPreset,
} from '@/services/store'
import AIProofreadToggle from './AIProofreadToggle'
import AppPromptRulesSection from './AppPromptRulesSection'
import PromptPresetSection from './PromptPresetSection'

export default function AIInstructionsPage() {
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [activePresetId, setActiveId] = useState('intent')
  const [editingPreset, setEditingPreset] = useState<PromptPreset | null>(null)
  const [appPromptRules, setAppPromptRules] = useState<AppPromptRule[]>([])

  useEffect(() => {
    getPromptPresets().then(setPresets)
    getActivePresetId().then(setActiveId)
    getAppPromptRules().then(setAppPromptRules)
  }, [])

  const handleSelectPreset = async (id: string) => {
    setActiveId(id)
    await setActivePresetId(id)
    await refreshPreset()
  }

  const handleSavePreset = async (preset: PromptPreset) => {
    await savePromptPreset(preset)
    setPresets(await getPromptPresets())
    setEditingPreset(null)
    if (preset.id === activePresetId) {
      await refreshPreset()
    }
  }

  const handleDeletePreset = async (id: string) => {
    await deletePromptPreset(id)
    setPresets(await getPromptPresets())
    if (id === activePresetId) {
      setActiveId('intent')
      await refreshPreset()
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
      <h1 className="mb-6 text-2xl font-bold">{'AI \u6307\u4ee4'}</h1>

      <div className="space-y-6">
        <AIProofreadToggle />

        <PromptPresetSection
          presets={presets}
          activePresetId={activePresetId}
          editingPreset={editingPreset}
          onSelectPreset={handleSelectPreset}
          onStartNewPreset={handleNewPreset}
          onStartEditing={setEditingPreset}
          onEditingPresetChange={setEditingPreset}
          onCancelEditing={() => setEditingPreset(null)}
          onSavePreset={handleSavePreset}
          onDeletePreset={handleDeletePreset}
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
