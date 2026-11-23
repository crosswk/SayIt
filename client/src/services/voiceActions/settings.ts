// 语音翻译 / 随便问的设置键与读取。
//
// 快捷键默认留空 = 两个功能默认都关：开着却没人知道的全局组合键会抢走别的程序的快捷键。
// 快捷键键名必须与 Rust 的 commands/shortcuts.rs（VOICE_ACTION_SHORTCUTS）一致。

import { parseProfiles } from '@/features/settings/aiProviderCatalog'
import { getSetting } from '../store'
import type { ClientAiConfig } from '../transcription/selectionAi'
import { normalizeTranslateLanguage, type TranslateLanguageCode } from './languages'
import {
  builtinAskPrompt,
  builtinTranslatePrompt,
  normalizePromptLanguage,
} from './prompts'

// 没有单独的「开启」开关：设了快捷键就是开启，清空就是关闭（用户要求）。
// Rust 那边同样只看快捷键有没有设。
export const VOICE_ACTION_KEYS = {
  translateShortcut: 'shortcutTranslate',
  translateTarget: 'translate.targetLanguage',
  /** 用户改过的翻译提示词；空串 = 用内置的 */
  translatePrompt: 'translate.prompt',
  /** 翻译用哪个 AI 服务；空串 = 跟随当前启用的那个 */
  translateProfile: 'translate.aiProfileId',
  askShortcut: 'shortcutAsk',
  askPrompt: 'ask.prompt',
  askProfile: 'ask.aiProfileId',
  askSearchMode: 'ask.searchMode',
  /** DeepSeek 搜索接口的密钥；空串 = 当前模型是 DeepSeek 时借用它的密钥 */
  askSearchKey: 'ask.searchApiKey',
  /** 提问时把选中的文字一起交给 AI */
  askUseSelection: 'ask.useSelection',
} as const

/** 这次录音要做什么。dictate = 原来的口述输入。 */
export type VoiceIntent = 'dictate' | 'translate' | 'ask'

/** auto = 模型自带搜索优先，不支持时用 DeepSeek 搜索接口；external = 只用搜索接口；off = 不联网 */
export type AskSearchMode = 'auto' | 'external' | 'off'

export function normalizeAskSearchMode(value: unknown): AskSearchMode {
  return value === 'external' || value === 'off' ? value : 'auto'
}

export interface VoiceActionSettings {
  translate: {
    /** = 设了快捷键 */
    enabled: boolean
    targetLanguage: TranslateLanguageCode
    /** 已经解析好的模板（用户版或内置版），目标语言还没填进去 */
    promptTemplate: string
    profileId: string
  }
  ask: {
    enabled: boolean
    prompt: string
    profileId: string
    searchMode: AskSearchMode
    searchApiKey: string
    useSelection: boolean
  }
}

export function defaultVoiceActionSettings(): VoiceActionSettings {
  return {
    translate: {
      enabled: false,
      targetLanguage: normalizeTranslateLanguage(undefined),
      promptTemplate: builtinTranslatePrompt('zh-CN'),
      profileId: '',
    },
    ask: {
      enabled: false,
      prompt: builtinAskPrompt('zh-CN'),
      profileId: '',
      searchMode: 'auto',
      searchApiKey: '',
      useSelection: true,
    },
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

export async function loadVoiceActionSettings(): Promise<VoiceActionSettings> {
  const [
    promptLanguage,
    translateShortcut,
    translateTarget,
    translatePrompt,
    translateProfile,
    askShortcut,
    askPrompt,
    askProfile,
    askSearchMode,
    askSearchKey,
    askUseSelection,
  ] = await Promise.all([
    getSetting('ai.builtinPromptLanguage', 'zh-CN'),
    getSetting(VOICE_ACTION_KEYS.translateShortcut, ''),
    getSetting(VOICE_ACTION_KEYS.translateTarget, 'en'),
    getSetting(VOICE_ACTION_KEYS.translatePrompt, ''),
    getSetting(VOICE_ACTION_KEYS.translateProfile, ''),
    getSetting(VOICE_ACTION_KEYS.askShortcut, ''),
    getSetting(VOICE_ACTION_KEYS.askPrompt, ''),
    getSetting(VOICE_ACTION_KEYS.askProfile, ''),
    getSetting(VOICE_ACTION_KEYS.askSearchMode, 'auto'),
    getSetting(VOICE_ACTION_KEYS.askSearchKey, ''),
    getSetting(VOICE_ACTION_KEYS.askUseSelection, true),
  ])
  const language = normalizePromptLanguage(promptLanguage)
  return {
    translate: {
      enabled: text(translateShortcut).trim() !== '',
      targetLanguage: normalizeTranslateLanguage(translateTarget),
      promptTemplate: text(translatePrompt).trim() || builtinTranslatePrompt(language),
      profileId: text(translateProfile),
    },
    ask: {
      enabled: text(askShortcut).trim() !== '',
      prompt: text(askPrompt).trim() || builtinAskPrompt(language),
      profileId: text(askProfile),
      searchMode: normalizeAskSearchMode(askSearchMode),
      searchApiKey: text(askSearchKey).trim(),
      useSelection: askUseSelection !== false,
    },
  }
}

/** 当前启用的 AI 服务（运行时那四个扁平键，见 aiProfileStore）。 */
export async function loadCurrentAiConfig(): Promise<ClientAiConfig> {
  const [provider, apiUrl, apiKey, model] = await Promise.all([
    getSetting('cloudAi.provider', 'openai_compat'),
    getSetting('cloudAi.apiUrl', ''),
    getSetting('cloudAi.apiKey', ''),
    getSetting('cloudAi.model', ''),
  ])
  return { provider: text(provider), apiUrl: text(apiUrl), apiKey: text(apiKey), model: text(model) }
}

/**
 * 按 id 取一份已保存的 AI 服务。空 id 或找不到时返回 null，调用方回落到当前启用的那份。
 *
 * 找不到不报错：用户可能删掉了那条服务，这时跟随当前 AI 比整个功能用不了更合理
 * （设置页会单独提示「选的服务已不存在」）。
 */
export async function loadAiProfileConfig(profileId: string): Promise<ClientAiConfig | null> {
  if (!profileId) return null
  const profiles = parseProfiles(await getSetting<unknown>('cloudAi.profiles', []))
  const profile = profiles.find((item) => item.id === profileId)
  if (!profile) return null
  const { provider, apiUrl, apiKey, model } = profile
  return { provider, apiUrl, apiKey, model }
}

/** DeepSeek 自带联网搜索只在这个模型上可用（api-docs.deepseek.com/guides/web_tools）。 */
export const DEEPSEEK_SEARCH_MODEL = 'deepseek-flash'

/**
 * 随便问没单独选 AI 服务时用哪一份：已保存的服务里有能联网的 DeepSeek（官方地址 + deepseek-flash
 * + 填了密钥）就用它，当前启用的那份正好是它时优先；没有就返回 null，回落到当前 AI 服务。
 *
 * 为什么默认偏向 DeepSeek：随便问最有用的场景是查最新信息，而 DeepSeek 是唯一实测过
 * 「自带搜索真的会搜、还带来源」的一家（见 providers/ai_ask.rs）。用户平时润色用的
 * 往往是更快更便宜的模型，没必要逼他为了提问去切换。
 */
export function pickAskAutoProfile<T extends ClientAiConfig & { id: string }>(profiles: T[], activeId: string): T | null {
  const searchable = profiles.filter((profile) => (
    isDeepSeekConfig(profile)
    && profile.model.trim() === DEEPSEEK_SEARCH_MODEL
    && profile.apiKey.trim() !== ''
    && profile.apiUrl.trim() !== ''
  ))
  return searchable.find((profile) => profile.id === activeId) ?? searchable[0] ?? null
}

/** 随便问「自动」那一档实际会用的服务；没有能联网的 DeepSeek 时返回 null。 */
export async function loadAskAutoProfileConfig(): Promise<ClientAiConfig | null> {
  const [rawProfiles, activeId] = await Promise.all([
    getSetting<unknown>('cloudAi.profiles', []),
    getSetting('cloudAi.activeProfileId', ''),
  ])
  const picked = pickAskAutoProfile(parseProfiles(rawProfiles), text(activeId))
  if (!picked) return null
  const { provider, apiUrl, apiKey, model } = picked
  return { provider, apiUrl, apiKey, model }
}

function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host.toLowerCase()
  } catch {
    return ''
  }
}

/** 是不是 DeepSeek 官方的服务（内置卡，或「OpenAI 兼容」卡填了官方地址）。 */
export function isDeepSeekConfig(config: Pick<ClientAiConfig, 'provider' | 'apiUrl'>): boolean {
  return config.provider === 'deepseek' || hostOf(config.apiUrl) === 'api.deepseek.com'
}

/**
 * 这次搜索用哪把密钥。用户单独填了就用它；没填而回答用的模型就是 DeepSeek 时借用那把，
 * 两个接口是同一个账号、同一种 Bearer 鉴权。
 */
export function resolveSearchApiKey(explicitKey: string, config: ClientAiConfig): string {
  const own = explicitKey.trim()
  if (own) return own
  return isDeepSeekConfig(config) ? config.apiKey.trim() : ''
}
