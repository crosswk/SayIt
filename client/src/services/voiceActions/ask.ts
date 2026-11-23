// 「随便问」的一次调用：识别出的问题 → （可选联网）→ 模型回答。
//
// 只负责执行和收集结论，不碰悬浮窗和录音状态 —— 那些归录音器管。
// 日志只记长度、模型和联网方式，不记问题、选区和回答正文（与 providers/diag.rs 同一口径）。

import { invoke } from '@tauri-apps/api/core'
import { addRuntimeEvent, AI_EVENT_ASK_OUTCOME, AI_EVENT_ASK_REQUEST, AI_LOG_SOURCE } from '../debugLog'
import { isClientAiConfigComplete } from '../transcription/clientAiPolish'
import type { ClientAiConfig } from '../transcription/selectionAi'
import { t } from '@/i18n'
import {
  loadAiProfileConfig,
  loadAskAutoProfileConfig,
  loadCurrentAiConfig,
  resolveSearchApiKey,
  type AskSearchMode,
  type VoiceActionSettings,
} from './settings'

/** 模型 + 搜索最长各 60s / 15s，再给自带搜索被拒后的重试留一轮。 */
const ASK_TIMEOUT_MS = 100_000

export interface AskSource {
  title: string
  url: string
}

export interface AskAnswer {
  text: string
  sources: AskSource[]
  /** 实际走的联网方式 */
  search: 'builtin' | 'external' | 'none'
  /** 想联网但没联上的原因码（见 providers/ai_ask.rs 的 AskResult），正常为空串 */
  searchIssue: string
  elapsedMs: number
  provider: string
  model: string
}

export type AskOutcome =
  | { kind: 'answer'; answer: AskAnswer }
  | { kind: 'config_incomplete' }
  | { kind: 'failed'; error: string }

interface RustAskResult {
  text: string
  sources: AskSource[]
  search: string
  search_issue: string
  elapsed_ms: number
}

/**
 * 答案卡底部那句「这次没联网」的说明。
 *
 * 用户自己把联网关了就什么都不说；想联网却没联上时必须说：同一个时效性问题，
 * 联网和不联网的答案可能完全不同，不说的话用户会把模型的旧知识当成刚查到的。
 */
export function describeAskSearchNote(
  answer: Pick<AskAnswer, 'search' | 'searchIssue'>,
  mode: AskSearchMode,
): string {
  if (mode === 'off' || answer.search !== 'none') return ''
  switch (answer.searchIssue) {
    case 'no_search_available':
    case 'builtin_rejected':
      return t('overlay.answerNoteNoBuiltin')
    case 'no_search_key':
      return t('overlay.answerNoteNoKey')
    case 'search_failed':
      return t('overlay.answerNoteSearchFailed')
    case 'search_empty':
      return t('overlay.answerNoteSearchEmpty')
    default:
      return ''
  }
}

/** 本机日期 YYYY-MM-DD。不用 toISOString：那是 UTC，东八区早上 8 点前会差一天。 */
export function localDateString(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 这次回答用哪个 AI 服务：设置里单独选了就用那个；没选（「自动」）时有能联网的 DeepSeek
 * 就用它，否则跟随当前启用的那份。
 */
export async function resolveAskAiConfig(profileId: string): Promise<ClientAiConfig> {
  const chosen = await loadAiProfileConfig(profileId)
  if (chosen) return chosen
  return (await loadAskAutoProfileConfig()) ?? loadCurrentAiConfig()
}

export async function askQuestion(params: {
  question: string
  /** 提问时选中的文字；没有或用户关掉了「带上选中的文字」时为空串 */
  selectedText: string
  settings: VoiceActionSettings['ask']
  /** 返回 false 表示这次录音已经被取消/替换，结果直接丢弃 */
  isCurrent: () => boolean
}): Promise<AskOutcome | null> {
  const { question, selectedText, settings, isCurrent } = params
  const config = await resolveAskAiConfig(settings.profileId)
  if (!isCurrent()) return null
  if (!isClientAiConfigComplete(config)) {
    addRuntimeEvent('warn', 'ai', 'Ask skipped: no usable AI service', {
      provider: config.provider || undefined,
      model: config.model || undefined,
    })
    return { kind: 'config_incomplete' }
  }

  const searchApiKey = settings.searchMode === 'off' ? '' : resolveSearchApiKey(settings.searchApiKey, config)
  addRuntimeEvent('info', AI_LOG_SOURCE, AI_EVENT_ASK_REQUEST, {
    provider: config.provider,
    model: config.model,
    searchMode: settings.searchMode,
    hasSearchKey: Boolean(searchApiKey),
    questionChars: question.length,
    selectedChars: selectedText.length,
  })

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const request = invoke<RustAskResult>('ai_ask', {
      request: {
        question,
        ai_config: {
          provider: config.provider,
          api_url: config.apiUrl,
          api_key: config.apiKey,
          model: config.model,
        },
        system_prompt: settings.prompt,
        selected_text: selectedText,
        search_mode: settings.searchMode,
        search_api_key: searchApiKey,
        today: localDateString(),
      },
    })
    const result = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Ask timed out after ${ASK_TIMEOUT_MS}ms`)), ASK_TIMEOUT_MS)
      }),
    ])
    if (!isCurrent()) return null
    const search = result.search === 'builtin' || result.search === 'external' ? result.search : 'none'
    addRuntimeEvent('info', AI_LOG_SOURCE, AI_EVENT_ASK_OUTCOME, {
      provider: config.provider,
      model: config.model,
      elapsedMs: result.elapsed_ms,
      answerChars: result.text.length,
      search,
      searchIssue: result.search_issue || undefined,
      sources: result.sources.length,
    })
    return {
      kind: 'answer',
      answer: {
        text: result.text,
        sources: Array.isArray(result.sources) ? result.sources : [],
        search,
        searchIssue: result.search_issue || '',
        elapsedMs: result.elapsed_ms,
        provider: config.provider,
        model: config.model,
      },
    }
  } catch (error) {
    if (!isCurrent()) return null
    const message = String(error)
    addRuntimeEvent('warn', 'ai', 'Ask failed', {
      error: message,
      provider: config.provider,
      model: config.model,
    })
    return { kind: 'failed', error: message }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
