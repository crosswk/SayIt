import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn(), invoke: vi.fn(), log: vi.fn() }))
vi.mock('../../store', () => ({
  getSetting: (...args: unknown[]) => mocks.get(...args),
  getPresetShortcuts: async () => ({ email: 'Control+Shift+E' }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('../../debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => mocks.log(...args),
  AI_LOG_SOURCE: 'ai',
  AI_EVENT_REQUEST: 'ai.request',
  AI_EVENT_OUTCOME: 'ai.outcome',
  AI_EVENT_ASK_REQUEST: 'ai.ask.request',
  AI_EVENT_ASK_OUTCOME: 'ai.ask.outcome',
}))
vi.mock('@/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/i18n')>()),
  t: (key: string) => key,
}))

import { askQuestion, describeAskSearchNote, localDateString } from '../ask'
import {
  languageNameForPrompt,
  normalizeTranslateLanguage,
  TRANSLATE_LANGUAGE_CODES,
} from '../languages'
import {
  builtinAskPrompt,
  builtinTranslatePrompt,
  LANGUAGE_PLACEHOLDER,
  renderTranslatePrompt,
} from '../prompts'
import {
  isDeepSeekConfig,
  loadVoiceActionSettings,
  resolveSearchApiKey,
  VOICE_ACTION_KEYS,
  type VoiceActionSettings,
} from '../settings'
import { checkVoiceActionShortcut, voiceActionShortcutConflict } from '../shortcutConflicts'

const deepseek = { provider: 'deepseek', apiUrl: 'https://api.deepseek.com', apiKey: 'sk-deepseek-secret', model: 'deepseek-flash' }
const groq = { provider: 'groq', apiUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-secret', model: 'llama' }

function settingsWith(values: Record<string, unknown>) {
  mocks.get.mockImplementation(async (key: string, fallback: unknown) => (key in values ? values[key] : fallback))
}

const askSettings = (patch: Partial<VoiceActionSettings['ask']> = {}): VoiceActionSettings['ask'] => ({
  enabled: true,
  prompt: 'You answer questions.',
  profileId: '',
  searchMode: 'auto',
  searchApiKey: '',
  useSelection: true,
  ...patch,
})

beforeEach(() => {
  vi.clearAllMocks()
  settingsWith({})
})

describe('translate prompt', () => {
  it('fills every placeholder with the English and native language names', () => {
    const rendered = renderTranslatePrompt(builtinTranslatePrompt('zh-CN'), 'ja')
    expect(rendered).not.toContain(LANGUAGE_PLACEHOLDER)
    expect(rendered).toContain('Japanese (日本語)')
  })

  it('still tells the model the target language when the user deleted the placeholder', () => {
    expect(renderTranslatePrompt('Translate this.', 'de')).toBe('Translate this.\n\nTarget language: German (Deutsch)')
  })

  it('keeps Chinese scripts and Portuguese variants apart', () => {
    expect(languageNameForPrompt('zh-Hant')).not.toBe(languageNameForPrompt('zh-Hans'))
    expect(languageNameForPrompt('pt-BR')).not.toBe(languageNameForPrompt('pt-PT'))
  })

  it('offers a few dozen unique target languages and falls back to English', () => {
    expect(TRANSLATE_LANGUAGE_CODES.length).toBeGreaterThanOrEqual(40)
    expect(new Set(TRANSLATE_LANGUAGE_CODES).size).toBe(TRANSLATE_LANGUAGE_CODES.length)
    expect(normalizeTranslateLanguage('klingon')).toBe('en')
    expect(normalizeTranslateLanguage('ko')).toBe('ko')
  })
})

describe('voice action settings', () => {
  it('keeps both features off and uses the built-in prompts by default', async () => {
    const settings = await loadVoiceActionSettings()
    expect(settings.translate.enabled).toBe(false)
    expect(settings.ask.enabled).toBe(false)
    // 没有单独的开关：设了快捷键就是开启
    settingsWith({ [VOICE_ACTION_KEYS.askShortcut]: 'Control+Alt+Q' })
    expect((await loadVoiceActionSettings()).ask.enabled).toBe(true)
    settingsWith({})
    expect(settings.translate.promptTemplate).toBe(builtinTranslatePrompt('zh-CN'))
    expect(settings.ask.prompt).toBe(builtinAskPrompt('zh-CN'))
    expect(settings.ask.searchMode).toBe('auto')
  })

  it('follows the built-in prompt language and treats a blank custom prompt as unset', async () => {
    settingsWith({ 'ai.builtinPromptLanguage': 'en', [VOICE_ACTION_KEYS.translatePrompt]: '   ' })
    const settings = await loadVoiceActionSettings()
    expect(settings.translate.promptTemplate).toBe(builtinTranslatePrompt('en'))
    expect(settings.ask.prompt).toBe(builtinAskPrompt('en'))
  })

  it('borrows the DeepSeek model key for search only when the user did not set one', () => {
    expect(resolveSearchApiKey('', deepseek)).toBe(deepseek.apiKey)
    expect(resolveSearchApiKey(' own-key ', deepseek)).toBe('own-key')
    expect(resolveSearchApiKey('', groq)).toBe('')
    // 「OpenAI 兼容」卡填官方地址也算 DeepSeek
    expect(isDeepSeekConfig({ provider: 'openai_compat', apiUrl: 'https://api.deepseek.com/v1' })).toBe(true)
    expect(isDeepSeekConfig({ provider: 'openai_compat', apiUrl: 'https://relay.example/v1' })).toBe(false)
  })
})

describe('ask', () => {
  function useCurrentAi(config: typeof deepseek) {
    settingsWith({
      'cloudAi.provider': config.provider,
      'cloudAi.apiUrl': config.apiUrl,
      'cloudAi.apiKey': config.apiKey,
      'cloudAi.model': config.model,
    })
  }

  it('sends the question, selection and borrowed search key, and never logs secrets or text', async () => {
    useCurrentAi(deepseek)
    mocks.invoke.mockResolvedValue({ text: 'Answer', sources: [{ title: 'A', url: 'https://a.example' }], search: 'builtin', search_issue: '', elapsed_ms: 12 })
    const outcome = await askQuestion({
      question: 'What happened today?',
      selectedText: 'Selected secret paragraph',
      settings: askSettings(),
      isCurrent: () => true,
    })
    expect(outcome).toMatchObject({ kind: 'answer', answer: { text: 'Answer', search: 'builtin' } })
    expect(mocks.invoke).toHaveBeenCalledWith('ai_ask', {
      request: expect.objectContaining({
        question: 'What happened today?',
        selected_text: 'Selected secret paragraph',
        search_mode: 'auto',
        search_api_key: deepseek.apiKey,
        today: localDateString(),
      }),
    })
    const logged = JSON.stringify(mocks.log.mock.calls)
    expect(logged).not.toContain(deepseek.apiKey)
    expect(logged).not.toContain('What happened today?')
    expect(logged).not.toContain('Selected secret paragraph')
  })

  it('does not send a search key when web search is off', async () => {
    useCurrentAi(deepseek)
    mocks.invoke.mockResolvedValue({ text: 'Answer', sources: [], search: 'none', search_issue: '', elapsed_ms: 1 })
    await askQuestion({ question: 'q', selectedText: '', settings: askSettings({ searchMode: 'off' }), isCurrent: () => true })
    expect(mocks.invoke.mock.calls[0][1].request.search_api_key).toBe('')
  })

  it('reports a missing AI service without calling anything', async () => {
    useCurrentAi({ ...groq, apiKey: '' })
    expect(await askQuestion({ question: 'q', selectedText: '', settings: askSettings(), isCurrent: () => true }))
      .toEqual({ kind: 'config_incomplete' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('uses the chosen profile instead of the current AI service', async () => {
    useCurrentAi(groq)
    const profile = { id: 'p1', ...deepseek }
    mocks.get.mockImplementation(async (key: string, fallback: unknown) => (key === 'cloudAi.profiles' ? [profile] : fallback))
    mocks.invoke.mockResolvedValue({ text: 'ok', sources: [], search: 'none', search_issue: '', elapsed_ms: 1 })
    await askQuestion({ question: 'q', selectedText: '', settings: askSettings({ profileId: 'p1' }), isCurrent: () => true })
    expect(mocks.invoke.mock.calls[0][1].request.ai_config.model).toBe('deepseek-flash')
  })

  it('answers with a saved DeepSeek service that can search when no service was chosen', async () => {
    const searchable = { id: 'ds', ...deepseek }
    const otherModel = { id: 'ds-pro', ...deepseek, model: 'deepseek-v4-pro' }
    mocks.get.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'cloudAi.profiles') return [{ id: 'g', ...groq }, otherModel, searchable]
      if (key === 'cloudAi.activeProfileId') return 'g'
      if (key === 'cloudAi.provider') return groq.provider
      if (key === 'cloudAi.apiUrl') return groq.apiUrl
      if (key === 'cloudAi.apiKey') return groq.apiKey
      if (key === 'cloudAi.model') return groq.model
      return fallback
    })
    mocks.invoke.mockResolvedValue({ text: 'ok', sources: [], search: 'builtin', search_issue: '', elapsed_ms: 1 })
    await askQuestion({ question: 'q', selectedText: '', settings: askSettings(), isCurrent: () => true })
    const request = mocks.invoke.mock.calls[0][1].request
    expect(request.ai_config).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash' })
    expect(request.search_api_key).toBe(deepseek.apiKey)
  })

  it('drops the result of a canceled recording and surfaces failures', async () => {
    useCurrentAi(deepseek)
    mocks.invoke.mockResolvedValue({ text: 'late', sources: [], search: 'none', search_issue: '', elapsed_ms: 1 })
    expect(await askQuestion({ question: 'q', selectedText: '', settings: askSettings(), isCurrent: () => false })).toBeNull()
    mocks.invoke.mockRejectedValue(new Error('sayit_error:provider_bad_key:401'))
    expect(await askQuestion({ question: 'q', selectedText: '', settings: askSettings(), isCurrent: () => true }))
      .toMatchObject({ kind: 'failed' })
  })

  it('explains a missing web search only when the user wanted one', () => {
    expect(describeAskSearchNote({ search: 'none', searchIssue: 'no_search_available' }, 'off')).toBe('')
    expect(describeAskSearchNote({ search: 'builtin', searchIssue: '' }, 'auto')).toBe('')
    expect(describeAskSearchNote({ search: 'none', searchIssue: 'no_search_available' }, 'auto')).toBe('overlay.answerNoteNoBuiltin')
    expect(describeAskSearchNote({ search: 'none', searchIssue: 'builtin_rejected' }, 'auto')).toBe('overlay.answerNoteNoBuiltin')
    expect(describeAskSearchNote({ search: 'none', searchIssue: 'no_search_key' }, 'external')).toBe('overlay.answerNoteNoKey')
    expect(describeAskSearchNote({ search: 'none', searchIssue: 'search_failed' }, 'auto')).toBe('overlay.answerNoteSearchFailed')
  })

  it('formats the local date instead of the UTC date', () => {
    expect(localDateString(new Date(2026, 0, 5, 0, 30))).toBe('2026-01-05')
  })
})

describe('shortcut conflicts', () => {
  it('rejects a key used by any other shortcut, including the other voice action', async () => {
    settingsWith({
      shortcutPTT: 'ControlRight',
      shortcutHandsFree: 'Control+Alt+H',
      shortcutToggleAi: 'Control+Alt+A',
      [VOICE_ACTION_KEYS.translateShortcut]: 'Control+Alt+T',
      [VOICE_ACTION_KEYS.askShortcut]: 'Control+Alt+Q',
    })
    expect(await checkVoiceActionShortcut('Control+Alt+H', 'ask')).toBe('settings.shortcuts.conflictHandsFree')
    expect(await checkVoiceActionShortcut('Control+Alt+A', 'ask')).toBe('settings.shortcuts.conflictAiToggle')
    expect(await checkVoiceActionShortcut('Control+Shift+E', 'ask')).toBe('settings.shortcuts.conflictPreset')
    expect(await checkVoiceActionShortcut('Control+Alt+T', 'ask')).toBe('settings.shortcuts.conflictTranslate')
    // 自己原来的键不算冲突
    expect(await checkVoiceActionShortcut('Control+Alt+Q', 'ask')).toBeNull()
    expect(await checkVoiceActionShortcut('Control+Alt+Z', 'translate')).toBeNull()
  })

  it('lets other shortcut settings see the voice action keys', async () => {
    settingsWith({ [VOICE_ACTION_KEYS.askShortcut]: 'Control+Alt+Q' })
    expect(await voiceActionShortcutConflict((existing) => existing === 'Control+Alt+Q')).toBe('settings.shortcuts.conflictAsk')
    expect(await voiceActionShortcutConflict((existing) => existing === 'Control+Alt+X')).toBeNull()
  })
})
