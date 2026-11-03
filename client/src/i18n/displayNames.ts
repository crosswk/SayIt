import type { HistoryFailReasonCode, PromptPreset } from '@/services/store'
import type { AppPromptRule } from '@/services/personalization/types'
import { t, type TranslationKey } from '.'
import { IS_MAC } from '@/lib/platform'

const BUILTIN_PRESET_NAME_KEYS: Record<string, TranslationKey> = {
  intent: 'builtinPreset.intent',
  faithful: 'builtinPreset.faithful',
  zh2en: 'builtinPreset.zh2en',
  casual: 'builtinPreset.casual',
}

const BUILTIN_APP_NAME_KEYS: Record<string, TranslationKey> = {
  teams: 'builtinApp.teams',
  outlook: 'builtinApp.outlook',
  kiro: 'builtinApp.kiro',
  vscode: 'builtinApp.vscode',
  cursor: 'builtinApp.cursor',
  // mac 上这条规则对应系统自带的「文本编辑」（见 personalization/defaults.ts 的 MAC_RULE_OVERRIDES）
  notepad: IS_MAC ? 'builtinApp.notepadMac' : 'builtinApp.notepad',
  codex: 'builtinApp.codex',
  weixin: 'builtinApp.weixin',
  qq: 'builtinApp.qq',
}

const LOCAL_MODEL_KEYS: Record<string, {
  name: TranslationKey
  description: TranslationKey
  languages: TranslationKey
}> = {
  'parakeet-unified-en-0.6b-gguf': {
    name: 'localModel.parakeetEn.name',
    description: 'localModel.parakeetEn.description',
    languages: 'localModel.parakeetEn.languages',
  },
  'sensevoice-small-gguf': {
    name: 'localModel.sensevoice.name',
    description: 'localModel.sensevoice.description',
    languages: 'localModel.sensevoice.languages',
  },
  'nemotron-asr-streaming-0.6b-gguf': {
    name: 'localModel.nemotron.name',
    description: 'localModel.nemotron.description',
    languages: 'localModel.nemotron.languages',
  },
  'funasr-nano-2512-gguf': {
    name: 'localModel.funasr.name',
    description: 'localModel.funasr.description',
    languages: 'localModel.funasr.languages',
  },
  'qwen3-asr-0.6b-gguf': {
    name: 'localModel.qwen06.name',
    description: 'localModel.qwen06.description',
    languages: 'localModel.qwen06.languages',
  },
  'qwen3-asr-1.7b-q4-gguf': {
    name: 'localModel.qwen17Fast.name',
    description: 'localModel.qwen17Fast.description',
    languages: 'localModel.qwen17Fast.languages',
  },
  'qwen3-asr-1.7b-gguf': {
    name: 'localModel.qwen17Accurate.name',
    description: 'localModel.qwen17Accurate.description',
    languages: 'localModel.qwen17Accurate.languages',
  },
}

const HISTORY_FAILURE_KEYS: Record<HistoryFailReasonCode, TranslationKey> = {
  no_transcript: 'recorder.noTranscript',
  empty_after_processing: 'recorder.emptyAfterProcessing',
  provider_timeout: 'err.provider.timeout',
  provider_unreachable: 'err.provider.unreachable',
  provider_bad_key: 'err.provider.badKey',
  provider_forbidden: 'err.provider.forbidden',
  provider_rate_limit: 'err.provider.rateLimit',
  provider_no_model: 'err.provider.noModel',
  provider_failed: 'record.providerFailed',
  processing_timeout: 'recorder.processingTimeout',
  connection_lost: 'recorder.connectionLost',
}

/** 内置模式名由稳定 id 翻译；用户自建名称永远原样显示。 */
export function promptPresetDisplayName(preset: Pick<PromptPreset, 'id' | 'name' | 'builtin'>): string {
  const key = preset.builtin ? BUILTIN_PRESET_NAME_KEYS[preset.id] : undefined
  return key ? t(key) : preset.name
}

/** 内置应用规则名由稳定 id 翻译；用户自建名称永远原样显示。 */
export function appPromptRuleDisplayName(rule: Pick<AppPromptRule, 'id' | 'appId' | 'name' | 'builtin'>): string {
  const key = rule.builtin ? BUILTIN_APP_NAME_KEYS[rule.appId || rule.id] : undefined
  return key ? t(key) : rule.name
}

/** 历史统计只保存了 appId/appName，已知内置 appId 仍可按当前界面语言显示。 */
export function recordedAppDisplayName(appId: string | undefined, fallback: string): string {
  const key = appId ? BUILTIN_APP_NAME_KEYS[appId] : undefined
  return key ? t(key) : fallback
}

/** 历史记录同时保存 preset id/name；用 id 可让旧记录也跟随当前界面语言。 */
export function recordedPromptPresetDisplayName(presetId: string | undefined, fallback: string): string {
  const key = presetId ? BUILTIN_PRESET_NAME_KEYS[presetId] : undefined
  return key ? t(key) : fallback
}

interface LocalModelDisplaySource {
  id: string
  name: string
  description?: string
  languages_label?: string
}

/** Rust catalog 保留稳定 id；展示文案在渲染时取值，切换界面语言不会冻结。 */
export function localModelDisplayName(model: LocalModelDisplaySource): string {
  const key = LOCAL_MODEL_KEYS[model.id]?.name
  return key ? t(key) : model.name
}

export function localModelDisplayDescription(model: LocalModelDisplaySource): string {
  const key = LOCAL_MODEL_KEYS[model.id]?.description
  return key ? t(key) : model.description || ''
}

export function localModelDisplayLanguages(model: LocalModelDisplaySource): string {
  const key = LOCAL_MODEL_KEYS[model.id]?.languages
  return key ? t(key) : model.languages_label || ''
}

/** 新记录按稳定 code 翻译；老记录没有 code 时保留当时写入的原文。 */
export function historyFailureReasonDisplay(record: {
  failReasonCode?: HistoryFailReasonCode
  failReason?: string
}): string {
  const key = record.failReasonCode ? HISTORY_FAILURE_KEYS[record.failReasonCode] : undefined
  return key ? t(key) : record.failReason || ''
}
