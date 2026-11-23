// 设置 → 键盘快捷键里的「语音翻译」「随便问」：开关、快捷键、模型和提示词。
// 功能没打开时只露出标题、说明和开关，其余设置都收着。
//
// 两个功能默认都关。功能开关和快捷键改完都要通知 Rust 重新注册（notifyShortcutsChanged）：
// Rust 只在开关打开时注册快捷键，关掉功能而不注销的话，那个组合键会一直被占着。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { ChevronRight } from 'lucide-react'
import { Feedback } from '@/components/ui/feedback'
import { InfoTip } from '@/components/ui/info-tip'
import { PasswordInput } from '@/components/ui/password-input'
import { Segmented } from '@/components/ui/segmented'
import { Select, type SelectOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { getLocale, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import * as bridge from '@/services/bridge'
import { refreshRecorderSettings } from '@/services/recorder'
import { getBuiltinPromptLanguage, getSetting, setSetting } from '@/services/store'
import { resolveAskAiConfig } from '@/services/voiceActions/ask'
import {
  languageName,
  nativeLanguageName,
  normalizeTranslateLanguage,
  TRANSLATE_LANGUAGE_CODES,
} from '@/services/voiceActions/languages'
import {
  builtinAskPrompt,
  builtinTranslatePrompt,
  LANGUAGE_PLACEHOLDER,
  normalizePromptLanguage,
  type BuiltinPromptLanguage,
} from '@/services/voiceActions/prompts'
import {
  normalizeAskSearchMode,
  resolveSearchApiKey,
  VOICE_ACTION_KEYS,
  type AskSearchMode,
} from '@/services/voiceActions/settings'
import { checkVoiceActionShortcut } from '@/services/voiceActions/shortcutConflicts'
import { describeProviderError } from '@/lib/errorMessages'
import { loadAiProfiles } from './aiProfileStore'
import { isProfileComplete, profileSubtitle, profileTitle, type AiProfile } from './aiProviderCatalog'
import { ComboShortcutInput } from './ShortcutInputs'

const inputClass = 'h-8 w-full rounded-md border border-input-border bg-input-bg px-2.5 text-xs'
const textareaClass = 'w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal'

/** 设置变了就让录音器重读（下一次录音生效）；开关和快捷键还要让 Rust 重新注册。 */
async function persist(key: string, value: unknown, options: { shortcuts?: boolean } = {}) {
  await setSetting(key, value)
  if (options.shortcuts) bridge.notifyShortcutsChanged()
  await refreshRecorderSettings()
}

/** 所有已保存的 AI 服务，「AI 供应商」页一改就跟着刷新。 */
function useAiProfiles() {
  const [profiles, setProfiles] = useState<AiProfile[]>([])
  const [activeId, setActiveId] = useState('')
  useEffect(() => {
    let disposed = false
    const load = () => {
      void loadAiProfiles().then((state) => {
        if (disposed) return
        setProfiles(state.profiles)
        setActiveId(state.activeId)
      }).catch(() => { })
    }
    load()
    window.addEventListener('ai-profiles-changed', load)
    window.addEventListener('focus', load)
    return () => {
      disposed = true
      window.removeEventListener('ai-profiles-changed', load)
      window.removeEventListener('focus', load)
    }
  }, [])
  return { profiles, activeId }
}

/** 「用哪个 AI 服务」那一行。空值 = 跟随当前启用的服务。 */
function ProfilePicker({
  id,
  value,
  profiles,
  onChange,
  defaultLabel,
  description,
}: {
  id: string
  value: string
  profiles: AiProfile[]
  onChange: (next: string) => void
  /** 空值那一项叫什么（翻译 = 跟随当前；随便问 = 自动，优先 DeepSeek） */
  defaultLabel: string
  description: string
}) {
  const t = useT()
  const selected = profiles.find((profile) => profile.id === value)
  const missing = Boolean(value && !selected)
  // 和「上下文感知」那里的选择器同一个口径：没填齐的服务不列，已选中的那条例外
  const options: SelectOption[] = [
    { value: '', label: defaultLabel },
    ...(missing ? [{ value, label: t('settings.contextAware.modelMissingOption') }] : []),
    ...profiles
      .filter((profile) => isProfileComplete(profile) || profile.id === value)
      .map((profile) => {
        const hint = `${profileSubtitle(profile)}${isProfileComplete(profile) ? '' : ` · ${t('ai.status.incomplete')}`}`
        return { value: profile.id, label: profileTitle(profile), hint, title: `${profileTitle(profile)} · ${hint}` }
      }),
  ]
  return (
    <div>
      <SettingRow labelId={id} label={t('voiceActions.model.label')} description={description}>
        <Select size="sm" menuAlign="end" labelledBy={id} value={value} onChange={onChange} options={options} className="w-56 shrink-0" />
      </SettingRow>
      {missing && <Feedback className="mt-3" tone="warning" message={t('voiceActions.model.missing')} />}
    </div>
  )
}

function SettingRow({
  labelId,
  label,
  description,
  children,
}: {
  labelId: string
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="min-w-0 flex-[1_1_16rem]">
        <p id={labelId} className="text-sm font-medium">{label}</p>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}

/**
 * 提示词编辑框。存的是「用户改过的版本」，空串 = 用内置的。
 *
 * 失焦才保存：每敲一个字都写一次库、重读一次录音器设置没有必要。改回和内置一模一样时
 * 存空串，这样以后内置提示词升级了，没真正改过的用户能自动用上新的。
 */
function PromptEditor({
  id,
  settingKey,
  builtin,
  stored,
  hint,
}: {
  id: string
  settingKey: string
  builtin: string
  stored: string
  hint: string
}) {
  const t = useT()
  const [draft, setDraft] = useState(stored.trim() ? stored : builtin)
  const [saved, setSaved] = useState(stored)
  useEffect(() => {
    setDraft(stored.trim() ? stored : builtin)
    setSaved(stored)
  }, [stored, builtin])

  const save = async (next: string) => {
    const value = next.trim() === builtin.trim() ? '' : next
    if (value === saved) return
    setSaved(value)
    await persist(settingKey, value)
  }
  const customized = saved.trim() !== ''
  // 默认收起：内置提示词已经能用，绝大多数人不需要看它。改过的也一样收起，
  // 标题旁的「已修改」足够提醒他这里和默认不同。
  const [open, setOpen] = useState(false)

  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={id}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
          {t('voiceActions.prompt.label')}
          {customized && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {t('voiceActions.prompt.customized')}
            </span>
          )}
        </button>
        {open && customized && (
          <button
            type="button"
            onClick={() => { setDraft(builtin); void save(builtin) }}
            className="px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('promptPreset.restoreDefault')}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2">
          <p className="mb-2 text-xs text-muted-foreground">{hint}</p>
          <textarea
            id={id}
            aria-label={t('voiceActions.prompt.label')}
            value={draft}
            rows={8}
            onChange={(event) => setDraft(event.target.value)}
            // 清空等于「用内置的」：别让一个空框存进去，那样模型收不到任何指令
            onBlur={() => { if (!draft.trim()) setDraft(builtin); void save(draft.trim() ? draft : builtin) }}
            className={textareaClass}
          />
        </div>
      )}
    </div>
  )
}

interface LoadedSettings {
  promptLanguage: BuiltinPromptLanguage
  translateShortcut: string
  translateTarget: string
  translatePrompt: string
  translateProfile: string
  askShortcut: string
  askPrompt: string
  askProfile: string
  askSearchMode: AskSearchMode
  askSearchKey: string
  askUseSelection: boolean
}

async function loadAll(): Promise<LoadedSettings> {
  const k = VOICE_ACTION_KEYS
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const [
    promptLanguage, translateShortcut, translateTarget, translatePrompt, translateProfile,
    askShortcut, askPrompt, askProfile, askSearchMode, askSearchKey, askUseSelection,
  ] = await Promise.all([
    getBuiltinPromptLanguage(),
    getSetting(k.translateShortcut, ''),
    getSetting(k.translateTarget, 'en'),
    getSetting(k.translatePrompt, ''),
    getSetting(k.translateProfile, ''),
    getSetting(k.askShortcut, ''),
    getSetting(k.askPrompt, ''),
    getSetting(k.askProfile, ''),
    getSetting(k.askSearchMode, 'auto'),
    getSetting(k.askSearchKey, ''),
    getSetting(k.askUseSelection, true),
  ])
  return {
    promptLanguage: normalizePromptLanguage(promptLanguage),
    translateShortcut: text(translateShortcut),
    translateTarget: normalizeTranslateLanguage(translateTarget),
    translatePrompt: text(translatePrompt),
    translateProfile: text(translateProfile),
    askShortcut: text(askShortcut),
    askPrompt: text(askPrompt),
    askProfile: text(askProfile),
    askSearchMode: normalizeAskSearchMode(askSearchMode),
    askSearchKey: text(askSearchKey),
    askUseSelection: askUseSelection !== false,
  }
}

/** 随便问这次会怎么联网，用当前选的模型现算，让用户在设置页就看到结果。 */
function useSearchPreview(profileId: string, searchMode: AskSearchMode, searchKey: string, profilesRevision: string) {
  const [preview, setPreview] = useState<{ tone: 'info' | 'warning'; key: TranslationKey; model: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const config = await resolveAskAiConfig(profileId)
        const builtin = searchMode === 'auto' && config.provider && config.apiUrl
          ? await bridge.aiBuiltinSearchSupport(config).catch(() => '')
          : ''
        const hasKey = Boolean(resolveSearchApiKey(searchKey, config))
        if (cancelled) return
        const model = config.model || config.provider
        if (searchMode === 'off') setPreview({ tone: 'info', key: 'voiceActions.search.previewOff', model })
        else if (searchMode === 'auto' && builtin) setPreview({ tone: 'info', key: 'voiceActions.search.previewBuiltin', model })
        else if (hasKey) setPreview({ tone: 'info', key: searchMode === 'auto' ? 'voiceActions.search.previewAutoExternal' : 'voiceActions.search.previewExternal', model })
        else setPreview({ tone: 'warning', key: searchMode === 'auto' ? 'voiceActions.search.previewNone' : 'voiceActions.search.previewNeedKey', model })
      } catch {
        if (!cancelled) setPreview(null)
      }
    })()
    return () => { cancelled = true }
  }, [profileId, searchMode, searchKey, profilesRevision])
  return preview
}

export default function VoiceActionsSection() {
  const t = useT()
  const [settings, setSettings] = useState<LoadedSettings | null>(null)
  // 读回之前开关不显示、不带过渡，免得「默认值 → 已保存值」动一下（pitfalls 11）
  const [animate, setAnimate] = useState(false)
  const { profiles, activeId } = useAiProfiles()
  const [searchKeyDraft, setSearchKeyDraft] = useState('')
  const [searchTest, setSearchTest] = useState<{ state: 'running' } | { state: 'ok'; count: number } | { state: 'error'; message: string } | null>(null)
  const searchTestRun = useRef(0)

  const reload = useCallback(async () => {
    const next = await loadAll()
    setSettings(next)
    setSearchKeyDraft(next.askSearchKey)
  }, [])

  useEffect(() => {
    let cancelled = false
    void reload().then(() => {
      if (cancelled) return
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!cancelled) setAnimate(true) }))
    })
    return () => { cancelled = true }
  }, [reload])

  const profilesRevision = useMemo(
    () => `${activeId}|${profiles.map((p) => `${p.id}:${p.provider}:${p.apiUrl}:${p.model}:${p.apiKey ? 1 : 0}`).join(',')}`,
    [profiles, activeId],
  )
  const searchPreview = useSearchPreview(
    settings?.askProfile ?? '',
    settings?.askSearchMode ?? 'auto',
    settings?.askSearchKey ?? '',
    profilesRevision,
  )

  const locale = getLocale()
  const languageOptions: SelectOption[] = useMemo(() => TRANSLATE_LANGUAGE_CODES.map((code) => {
    const localized = languageName(code, locale)
    const native = nativeLanguageName(code)
    return { value: code, label: localized, ...(native !== localized && { hint: native }) }
  }), [locale])

  // 读回之前什么都不画：先画默认值再跳成已保存值反而会闪（pitfalls 11）
  if (!settings) return null

  const update = (patch: Partial<LoadedSettings>) => setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
  const k = VOICE_ACTION_KEYS
  const noUsableAi = !profiles.some(isProfileComplete)

  const saveSearchKey = async () => {
    const value = searchKeyDraft.trim()
    if (value === settings.askSearchKey) return
    update({ askSearchKey: value })
    setSearchTest(null)
    await persist(k.askSearchKey, value)
  }

  const testSearchKey = async () => {
    const run = ++searchTestRun.current
    setSearchTest({ state: 'running' })
    try {
      const config = await resolveAskAiConfig(settings.askProfile)
      const key = resolveSearchApiKey(searchKeyDraft, config)
      if (!key) {
        if (run === searchTestRun.current) setSearchTest({ state: 'error', message: t('voiceActions.search.testNoKey') })
        return
      }
      const count = await bridge.testAskSearch(key)
      if (run === searchTestRun.current) setSearchTest({ state: 'ok', count })
    } catch (error) {
      if (run === searchTestRun.current) setSearchTest({ state: 'error', message: describeProviderError(error).message })
    }
  }

  return (
    // 放在「键盘快捷键」卡片里，和上面的快捷键行排成同一列
    <>
      {/* ── 语音翻译 ──
          和上面两行同一个形态（左边名称和说明，右边快捷键），右边对齐。没有单独的开关：
          设了快捷键就是开启，下面的设置跟着展开；清空快捷键就关闭、收起。 */}
      <div>
        <ComboShortcutInput
          value={settings.translateShortcut}
          comboOnly
          validate={(value) => checkVoiceActionShortcut(value, 'translate')}
          onChange={(value) => {
            update({ translateShortcut: value })
            void persist(k.translateShortcut, value, { shortcuts: true })
          }}
          label={t('voiceActions.translate.title')}
          description={t('voiceActions.translate.desc')}
        />
            {settings.translateShortcut && (
              // 只往左缩进：右边的控件和上面的快捷键按钮贴着同一条边
              <div className="mt-3 space-y-4 border-l-2 border-border pl-4">
                {noUsableAi && <Feedback tone="warning" message={t('voiceActions.noAi')} />}
                <SettingRow labelId="voice-translate-target" label={t('voiceActions.translate.target')} description={t('voiceActions.translate.targetDesc')}>
                  <Select
                    size="sm"
                    menuAlign="end"
                    labelledBy="voice-translate-target"
                    value={settings.translateTarget}
                    options={languageOptions}
                    onChange={(value) => {
                      update({ translateTarget: value })
                      void persist(k.translateTarget, value)
                    }}
                    className="w-56 shrink-0"
                  />
                </SettingRow>
                <ProfilePicker
                  id="voice-translate-model"
                  value={settings.translateProfile}
                  profiles={profiles}
                  defaultLabel={t('voiceActions.model.followCurrent')}
                  description={t('voiceActions.model.desc')}
                  onChange={(value) => {
                    update({ translateProfile: value })
                    void persist(k.translateProfile, value)
                  }}
                />
                <PromptEditor
                  id="voice-translate-prompt"
                  settingKey={k.translatePrompt}
                  builtin={builtinTranslatePrompt(settings.promptLanguage)}
                  stored={settings.translatePrompt}
                  hint={t('voiceActions.translate.promptHint', { placeholder: LANGUAGE_PLACEHOLDER })}
                />
              </div>
            )}
      </div>

      {/* ── 随便问 ──
          和上面两行同一个形态（左边名称和说明，右边快捷键），右边对齐。没有单独的开关：
          设了快捷键就是开启，下面的设置跟着展开；清空快捷键就关闭、收起。 */}
      <div>
        <ComboShortcutInput
          value={settings.askShortcut}
          comboOnly
          validate={(value) => checkVoiceActionShortcut(value, 'ask')}
          onChange={(value) => {
            update({ askShortcut: value })
            void persist(k.askShortcut, value, { shortcuts: true })
          }}
          label={t('voiceActions.ask.title')}
          description={t('voiceActions.ask.desc')}
        />
            {settings.askShortcut && (
              // 只往左缩进：右边的控件和上面的快捷键按钮贴着同一条边
              <div className="mt-3 space-y-4 border-l-2 border-border pl-4">
                {noUsableAi && <Feedback tone="warning" message={t('voiceActions.noAi')} />}
                <ProfilePicker
                  id="voice-ask-model"
                  value={settings.askProfile}
                  profiles={profiles}
                  defaultLabel={t('voiceActions.model.askAuto')}
                  description={t('voiceActions.model.askDesc')}
                  onChange={(value) => {
                    update({ askProfile: value })
                    setSearchTest(null)
                    void persist(k.askProfile, value)
                  }}
                />

                <div className="space-y-3">
                  <SettingRow labelId="voice-ask-search" label={t('voiceActions.search.label')}>
                    <div className="flex shrink-0 items-center gap-2">
                      <InfoTip content={t('voiceActions.search.help')} label={t('voiceActions.search.label')} />
                      <Segmented
                        labelledBy="voice-ask-search"
                        size="sm"
                        value={settings.askSearchMode}
                        animated={animate}
                        options={[
                          { value: 'auto', label: t('voiceActions.search.auto') },
                          { value: 'external', label: t('voiceActions.search.external') },
                          { value: 'off', label: t('voiceActions.search.off') },
                        ]}
                        onChange={(value: AskSearchMode) => {
                          update({ askSearchMode: value })
                          void persist(k.askSearchMode, value)
                        }}
                      />
                    </div>
                  </SettingRow>
                  {searchPreview && (
                    <Feedback tone={searchPreview.tone} message={t(searchPreview.key, { model: searchPreview.model })} />
                  )}
                  {settings.askSearchMode !== 'off' && (
                    <div>
                      <label htmlFor="voice-ask-search-key" className="mb-1.5 block text-xs font-medium">
                        {t('voiceActions.search.keyLabel')}
                      </label>
                      <div className="flex items-center gap-2">
                        {/* 失焦保存。PasswordInput 不带 onBlur，React 的 onBlur 会从里面的 input 冒泡上来 */}
                        <div className="min-w-0 flex-1" onBlur={() => { void saveSearchKey() }}>
                          <PasswordInput
                            id="voice-ask-search-key"
                            label={t('voiceActions.search.keyLabel')}
                            value={searchKeyDraft}
                            onChange={setSearchKeyDraft}
                            onSubmit={() => { void saveSearchKey() }}
                            placeholder={t('voiceActions.search.keyPlaceholder')}
                            className={inputClass}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => { void saveSearchKey().then(testSearchKey) }}
                          disabled={searchTest?.state === 'running'}
                          className="h-8 shrink-0 rounded-md border border-input bg-muted px-3 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                        >
                          {searchTest?.state === 'running' ? t('voiceActions.search.testing') : t('voiceActions.search.test')}
                        </button>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                        {t('voiceActions.search.keyHint')}{' '}
                        <button
                          type="button"
                          onClick={() => { void shellOpen('https://platform.deepseek.com/api_keys') }}
                          className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
                        >
                          {t('voiceActions.search.keyLink')}
                        </button>
                      </p>
                      {searchTest?.state === 'ok' && (
                        <Feedback className="mt-2" tone="success" message={t('voiceActions.search.testOk', { count: searchTest.count })} />
                      )}
                      {searchTest?.state === 'error' && (
                        <Feedback className="mt-2" tone="error" message={searchTest.message} />
                      )}
                    </div>
                  )}
                </div>

                <SettingRow labelId="voice-ask-selection" label={t('voiceActions.ask.useSelection')} description={t('voiceActions.ask.useSelectionDesc')}>
                  <Switch
                    checked={settings.askUseSelection}
                    labelledBy="voice-ask-selection"
                    noAnimation={!animate}
                    onChange={() => {
                      const next = !settings.askUseSelection
                      update({ askUseSelection: next })
                      void persist(k.askUseSelection, next)
                    }}
                    className="shrink-0"
                  />
                </SettingRow>

                <PromptEditor
                  id="voice-ask-prompt"
                  settingKey={k.askPrompt}
                  builtin={builtinAskPrompt(settings.promptLanguage)}
                  stored={settings.askPrompt}
                  hint={t('voiceActions.ask.promptHint')}
                />
              </div>
            )}
      </div>
    </>
  )
}
