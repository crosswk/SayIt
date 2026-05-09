export const MAX_HOTWORDS = 1000
export const BUILTIN_SET_WORDS_KEY = 'builtinSetWords'
export const BUILTIN_SET_ACTIVE_KEY = 'builtinSetActive'
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
    label: 'AI 热词',
    description: '常见 AI 模型与术语',
    words: [
      'ChatGPT', 'GPT', 'OpenAI', 'Claude', 'DeepSeek', '豆包', 'Gemini',
      'LLM', 'Token', 'Prompt', 'Agent', 'Ollama', '千问', '大模型',
      'OpenClaw', 'ASR', 'Codex', 'Claude Code', 'SayIt', 'Hermes',
    ],
  },
}

export const BUILTIN_WORD_SET = new Set(Object.values(BUILTIN_SETS).flatMap((set) => set.words))

export function uniqueWords(words: string[]) {
  return Array.from(new Set(words.map((w) => w.trim()).filter(Boolean)))
}

export function parseWordsInput(raw: string) {
  return uniqueWords(raw.split(/[,，\n]+/).map((w) => w.trim()))
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

export function normalizeBuiltinSetWords(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, string[]> = {}

  for (const [key, setDef] of Object.entries(BUILTIN_SETS)) {
    const raw = obj[key]
    if (!Array.isArray(raw)) continue

    const allow = new Set(setDef.words)
    result[key] = uniqueWords(raw.map((v) => String(v))).filter((w) => allow.has(w))
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
