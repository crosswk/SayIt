// 「上下文感知」卡片：读光标附近的文字让 AI 衔接语气，选中文字时按口述要求改写选区。
// 原来在设置弹窗的通用页里；它只在 AI 整理开着时生效，所以放在 AI 整理页、跟着那个开关变灰。

import { useEffect, useState } from 'react'
import { Info, Pencil, RotateCcw } from 'lucide-react'
import { IS_MAC } from '@/lib/platform'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { useAiEnabled } from '@/hooks/useAiEnabled'
import { refreshRecorderSettings } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import {
  CONTEXT_SELECTION_EDIT_PROMPT,
  CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY,
  normalizeContextSelectionEditPrompt,
} from '@/services/contextAware'
import { useT } from '@/i18n/useT'
import ContextSelectionModelSetting from './ContextSelectionModelSetting'

export default function ContextAwareSection() {
  const t = useT()
  const aiEnabled = useAiEnabled()
  const [enabled, setEnabled] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [savedPrompt, setSavedPrompt] = useState(CONTEXT_SELECTION_EDIT_PROMPT)
  const [promptDraft, setPromptDraft] = useState(CONTEXT_SELECTION_EDIT_PROMPT)
  const [promptSaving, setPromptSaving] = useState(false)
  // 读回已保存值前先隐藏开关、不放动画，避免「默认值→已保存值」闪一下（pitfalls 11）
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    let cancelled = false
    getSetting('contextAwareWritingEnabled', false)
      .then((value) => { if (!cancelled) setEnabled(Boolean(value)) })
      .catch(() => { })
      .finally(() => {
        if (cancelled) return
        setReady(true)
        requestAnimationFrame(() => requestAnimationFrame(() => { if (!cancelled) setAnimate(true) }))
      })
    getSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, CONTEXT_SELECTION_EDIT_PROMPT)
      .then((value) => {
        if (cancelled) return
        const prompt = normalizeContextSelectionEditPrompt(value)
        setSavedPrompt(prompt)
        setPromptDraft(prompt)
      })
      .catch(() => { })
    return () => { cancelled = true }
  }, [])

  const toggle = async () => {
    const next = !enabled
    setEnabled(next)
    await setSetting('contextAwareWritingEnabled', next)
    await refreshRecorderSettings()
  }
  const openPrompt = () => {
    setPromptDraft(savedPrompt)
    setPromptOpen(true)
  }
  const savePrompt = async () => {
    const prompt = promptDraft.trim()
    if (!prompt || promptSaving) return
    setPromptSaving(true)
    try {
      await setSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, prompt)
      setSavedPrompt(prompt)
      await refreshRecorderSettings()
      setPromptOpen(false)
    } finally {
      setPromptSaving(false)
    }
  }
  const resetPrompt = async () => {
    if (promptSaving) return
    setPromptSaving(true)
    try {
      await setSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, CONTEXT_SELECTION_EDIT_PROMPT)
      setSavedPrompt(CONTEXT_SELECTION_EDIT_PROMPT)
      setPromptDraft(CONTEXT_SELECTION_EDIT_PROMPT)
      await refreshRecorderSettings()
    } finally {
      setPromptSaving(false)
    }
  }

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 id="context-aware-title" className={`text-lg font-semibold ${aiEnabled ? '' : 'text-muted-foreground'}`}>{t('settings.contextAware.title')}</h2>
                <Tooltip
                  variant="light"
                  content={(
                    <div className="w-[32rem] max-w-[calc(100vw-3rem)] space-y-2">
                      <p>{t(IS_MAC ? 'settings.contextAware.infoFunctionMac' : 'settings.contextAware.infoFunction')}</p>
                      <p>{t('settings.contextAware.infoUsage')}</p>
                      <p>{t('settings.contextAware.infoPrinciple')}</p>
                    </div>
                  )}
                >
                  <Info
                    aria-label={t('settings.contextAware.infoAria')}
                    className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                  />
                </Tooltip>
              </div>
              <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted-foreground">
                {aiEnabled ? (
                  <>
                    <p>{t('settings.contextAware.descContinue')}</p>
                    <p>{t('settings.contextAware.descSelection')}</p>
                  </>
                ) : (
                  <p>{t('aiInstructions.requiresAiCleanup')}</p>
                )}
              </div>
              <button
                type="button"
                onClick={openPrompt}
                className="mt-2 inline-flex items-center gap-1.5 py-1 text-xs font-medium text-primary transition-colors hover:text-primary/75 hover:underline hover:underline-offset-4"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                {t('settings.contextAware.editPrompt')}
              </button>
            </div>
            {/* AI 整理关着时录音器根本不读文本框（见 RecorderOrchestrator 的 includeTextContext），
                所以开关画成关闭 + 禁用，不显示一个"开着却不生效"的状态；保存的值不动，AI 整理打开后照旧。 */}
            <Switch
              checked={enabled && aiEnabled}
              labelledBy="context-aware-title"
              onChange={() => void toggle()}
              disabled={!aiEnabled}
              noAnimation={!animate}
              hidden={!ready}
            />
          </div>
          {/* 只有开关真正生效时才给选模型：关着时录音器不读选区，这个选择不会被用到。
              ready 之前也不渲染，免得读回已保存值前先闪出一行再消失。 */}
          {ready && enabled && aiEnabled && <ContextSelectionModelSetting />}
        </CardContent>
      </Card>

      {promptOpen && (
        <Modal
          title={t('settings.contextAware.promptTitle')}
          onClose={() => setPromptOpen(false)}
          locked={promptSaving}
          showCloseButton
          panelClassName="w-[720px]"
        >
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t('settings.contextAware.promptDesc')}
          </p>
          <textarea
            value={promptDraft}
            onChange={(event) => setPromptDraft(event.target.value)}
            aria-label={t('settings.contextAware.promptEditorAria')}
            spellCheck={false}
            rows={14}
            className="mt-4 w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
          />
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => void resetPrompt()}
              disabled={promptSaving || promptDraft === CONTEXT_SELECTION_EDIT_PROMPT}
              className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {t('settings.contextAware.resetPrompt')}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPromptOpen(false)}
                disabled={promptSaving}
                className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void savePrompt()}
                disabled={promptSaving || !promptDraft.trim()}
                className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {promptSaving ? t('settings.contextAware.savingPrompt') : t('common.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
