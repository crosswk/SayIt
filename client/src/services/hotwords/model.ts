import { t } from '@/i18n'

export const MAX_HOTWORDS = 1000
export const BUILTIN_SET_WORDS_KEY = 'builtinSetWords'
export const BUILTIN_SET_ACTIVE_KEY = 'builtinSetActive'
/**
 * 用户自己往内置分类里加的词，按分类 key 存。
 *
 * 为什么不直接写进 builtinSetWords：读那份时会按内置词表过滤（normalizeBuiltinSetWords），
 * 新版本从默认词表里删掉的词靠这一步从老用户那里清掉。用户加的词同样不在内置词表里，
 * 混在一起就分不清「该清掉的旧默认词」和「用户自己加的词」，要么清不掉、要么把用户的词吞掉。
 */
export const BUILTIN_SET_EXTRA_WORDS_KEY = 'builtinSetExtraWords'
export const CUSTOM_THEMES_KEY = 'customHotwordThemes'
export const CUSTOM_THEME_ACTIVE_KEY = 'customThemeActive'
export const LEGACY_MANUAL_WORDS_KEY = 'manualHotwords'

export interface CustomTheme {
  id: string
  name: string
  words: string[]
}

export const BUILTIN_SETS: Record<string, { label: string; description: string; words: string[] }> = {
  ai: {
    get label() { return t('dict.aiSet') },
    get description() { return t('dict.aiSetDesc') },
    // i18n-allow-start: 内置中文热词数据，不是界面文案
    words: [
      'ChatGPT', 'GPT', 'OpenAI', 'Claude', 'DeepSeek', '豆包', 'Gemini',
      'LLM', 'Token', 'Prompt', 'Agent', 'Ollama', '千问', '大模型',
      'OpenClaw', 'ASR', 'Codex', 'Claude Code', 'SayIt', 'Hermes',
      'Vibe Coding', 'Typeless', 'Vibe',
    ],
    // i18n-allow-end
  },
}

export const BUILTIN_WORD_SET = new Set(Object.values(BUILTIN_SETS).flatMap((set) => set.words))

export function uniqueWords(words: string[]) {
  return Array.from(new Set(words.map((w) => w.trim()).filter(Boolean)))
}

export function parseWordsInput(raw: string) {
  return uniqueWords(raw.split(/[,\uFF0C\n]+/).map((w) => w.trim()))
}

export function collectAllSourceWords(
  builtinWordsMap: Record<string, string[]>,
  customThemes: CustomTheme[],
): Set<string> {
  const set = new Set<string>()
  for (const words of Object.values(builtinWordsMap)) {
    for (const word of words) set.add(word)
  }
  for (const theme of customThemes) {
    for (const word of theme.words) set.add(word)
  }
  return set
}

export function collectActiveSourceWords(
  builtinWordsMap: Record<string, string[]>,
  builtinActiveMap: Record<string, boolean>,
  customThemes: CustomTheme[],
  customThemeActiveMap: Record<string, boolean>,
): string[] {
  const activeWords: string[] = []

  for (const [key, words] of Object.entries(builtinWordsMap)) {
    if (!builtinActiveMap[key]) continue
    activeWords.push(...words)
  }

  for (const theme of customThemes) {
    if (!customThemeActiveMap[theme.id]) continue
    activeWords.push(...theme.words)
  }

  return uniqueWords(activeWords)
}

export function composeHotwords(
  preservedWords: string[],
  builtinWordsMap: Record<string, string[]>,
  builtinActiveMap: Record<string, boolean>,
  customThemes: CustomTheme[],
  customThemeActiveMap: Record<string, boolean>,
): string[] {
  const activeWords = collectActiveSourceWords(
    builtinWordsMap,
    builtinActiveMap,
    customThemes,
    customThemeActiveMap,
  )

  return uniqueWords([...preservedWords, ...activeWords]).slice(0, MAX_HOTWORDS)
}

/**
 * 读内置分类的词。`extraValue` 是 BUILTIN_SET_EXTRA_WORDS_KEY 里存的用户自加词，
 * **凡是要拿内置分类实际词表的地方都要把它一起传进来**，否则用户加的词在那条路径上不生效。
 */
export function normalizeBuiltinSetWords(value: unknown, extraValue?: unknown): Record<string, string[]> {
  const obj = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const extras = normalizeBuiltinSetExtraWords(extraValue)
  const result: Record<string, string[]> = {}

  for (const [key, setDef] of Object.entries(BUILTIN_SETS)) {
    const raw = obj[key]
    const extra = extras[key] ?? []
    if (!Array.isArray(raw) && extra.length === 0) continue

    const allow = new Set(setDef.words)
    // 没存过默认词时按全部默认词算（与热词页首次加载的兜底一致），不能只剩用户加的那几个
    const base = Array.isArray(raw)
      ? uniqueWords(raw.map((v) => String(v))).filter((w) => allow.has(w))
      : uniqueWords(setDef.words)
    result[key] = uniqueWords([...base, ...extra])
  }

  return result
}

export function normalizeBuiltinSetExtraWords(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, string[]> = {}
  for (const [key, setDef] of Object.entries(BUILTIN_SETS)) {
    const raw = obj[key]
    if (!Array.isArray(raw)) continue
    const builtin = new Set(setDef.words)
    const words = uniqueWords(raw.map((v) => String(v))).filter((w) => !builtin.has(w))
    if (words.length > 0) result[key] = words
  }
  return result
}

/** 从内置分类的完整词表里拆出用户自加的词（不在内置词表里的就是），用于写回 BUILTIN_SET_EXTRA_WORDS_KEY。 */
export function extractBuiltinSetExtraWords(wordsMap: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [key, setDef] of Object.entries(BUILTIN_SETS)) {
    const builtin = new Set(setDef.words)
    const words = (wordsMap[key] ?? []).filter((w) => !builtin.has(w))
    if (words.length > 0) result[key] = words
  }
  return result
}

export function normalizeBuiltinSetActive(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, boolean> = {}

  for (const key of Object.keys(BUILTIN_SETS)) {
    if (typeof obj[key] === 'boolean') {
      result[key] = obj[key] as boolean
    }
  }

  return result
}

export function normalizeCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return []

  const usedIds = new Set<string>()
  const themes: CustomTheme[] = []

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const name = String(obj.name || '').trim()
    if (!name) continue

    const words = Array.isArray(obj.words) ? uniqueWords(obj.words.map((w) => String(w))) : []
    let id = String(obj.id || '').trim()
    if (!id || usedIds.has(id)) {
      id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    }

    usedIds.add(id)
    themes.push({ id, name, words })
  }

  return themes
}

export function normalizeCustomThemeActive(value: unknown, themes: CustomTheme[]): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, boolean> = {}

  for (const theme of themes) {
    if (typeof obj[theme.id] === 'boolean') {
      result[theme.id] = obj[theme.id] as boolean
    }
  }

  return result
}

export function createThemeId() {
  return `theme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}
