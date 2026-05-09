import { useCallback, useEffect, useMemo, useReducer } from 'react'
import { getSetting, setSetting } from '@/services/store'
import {
  BUILTIN_SETS,
  BUILTIN_SET_ACTIVE_KEY,
  BUILTIN_SET_WORDS_KEY,
  BUILTIN_WORD_SET,
  CUSTOM_THEME_ACTIVE_KEY,
  CUSTOM_THEMES_KEY,
  LEGACY_MANUAL_WORDS_KEY,
  type CustomTheme,
  collectAllSourceWords,
  composeHotwords,
  createThemeId,
  normalizeBuiltinSetActive,
  normalizeBuiltinSetWords,
  normalizeCustomThemeActive,
  normalizeCustomThemes,
  parseWordsInput,
  uniqueWords,
} from './model'
import { hotwordsReducer, initialHotwordsState } from './stateMachine'

export function useHotwordsManager() {
  const [state, dispatch] = useReducer(hotwordsReducer, initialHotwordsState)
  const {
    hotwords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    themeInputs,
    newThemeName,
    search,
    loading,
    showUnknown,
  } = state

  const setSnapshot = useCallback((payload: Partial<typeof state>) => {
    dispatch({ type: 'set_snapshot', payload })
  }, [])

  const persistBuiltinStates = useCallback(async (
    wordsMap: Record<string, string[]>,
    activeMap: Record<string, boolean>,
  ) => {
    await Promise.all([
      setSetting(BUILTIN_SET_WORDS_KEY, wordsMap),
      setSetting(BUILTIN_SET_ACTIVE_KEY, activeMap),
    ])
  }, [])

  const persistCustomThemeStates = useCallback(async (
    themes: CustomTheme[],
    activeMap: Record<string, boolean>,
  ) => {
    await Promise.all([
      setSetting(CUSTOM_THEMES_KEY, themes),
      setSetting(CUSTOM_THEME_ACTIVE_KEY, activeMap),
    ])
  }, [])

  const syncToBackend = useCallback(async (_words: string[]) => {
    // 热词不再同步到后端全局文件，改为通过 WebSocket start 消息按会话传递
  }, [])

  const loadHotwords = useCallback(async () => {
    try {
      const [
        rawSetWords,
        rawSetActive,
        rawCustomThemes,
        rawCustomThemeActive,
        legacyManualWords,
      ] = await Promise.all([
        getSetting<Record<string, unknown>>(BUILTIN_SET_WORDS_KEY, {}),
        getSetting<Record<string, unknown>>(BUILTIN_SET_ACTIVE_KEY, {}),
        getSetting<unknown>(CUSTOM_THEMES_KEY, []),
        getSetting<Record<string, unknown>>(CUSTOM_THEME_ACTIVE_KEY, {}),
        getSetting<string[]>(LEGACY_MANUAL_WORDS_KEY, []),
      ])

      // 热词全部从本地 store 加载，不依赖远程服务器
      const savedSetWords = normalizeBuiltinSetWords(rawSetWords)
      const savedSetActive = normalizeBuiltinSetActive(rawSetActive)

      const nextSetWords: Record<string, string[]> = {}
      const nextSetActive: Record<string, boolean> = {}

      for (const [key, setDef] of Object.entries(BUILTIN_SETS)) {
        const defaults = uniqueWords(setDef.words)
        nextSetWords[key] = savedSetWords[key] ?? defaults
        nextSetActive[key] = typeof savedSetActive[key] === 'boolean'
          ? savedSetActive[key]
          : key === 'ai'
      }

      let nextCustomThemes = normalizeCustomThemes(rawCustomThemes)
      const migratedManualWords = uniqueWords(legacyManualWords).filter((w) => !BUILTIN_WORD_SET.has(w))

      if (nextCustomThemes.length === 0 && migratedManualWords.length > 0) {
        nextCustomThemes = [
          {
            id: createThemeId(),
            name: '我的主题',
            words: migratedManualWords,
          },
        ]
      }

      const savedCustomThemeActive = normalizeCustomThemeActive(rawCustomThemeActive, nextCustomThemes)
      const nextCustomThemeActive: Record<string, boolean> = {}

      for (const theme of nextCustomThemes) {
        nextCustomThemeActive[theme.id] = typeof savedCustomThemeActive[theme.id] === 'boolean'
          ? savedCustomThemeActive[theme.id]
          : false
      }

      // 从本地状态组合出当前生效的热词列表
      const composed = composeHotwords(
        [],
        nextSetWords,
        nextSetActive,
        nextCustomThemes,
        nextCustomThemeActive,
      )

      setSnapshot({
        hotwords: composed,
        builtinSetWords: nextSetWords,
        builtinSetActive: nextSetActive,
        customThemes: nextCustomThemes,
        customThemeActive: nextCustomThemeActive,
      })

      const needPersistBuiltin = Object.keys(savedSetWords).length === 0 || Object.keys(savedSetActive).length === 0
      const needPersistCustom = normalizeCustomThemes(rawCustomThemes).length === 0
        || Object.keys(savedCustomThemeActive).length === 0
        || (nextCustomThemes.length > 0 && migratedManualWords.length > 0)

      if (needPersistBuiltin) {
        void persistBuiltinStates(nextSetWords, nextSetActive)
      }
      if (needPersistCustom) {
        void persistCustomThemeStates(nextCustomThemes, nextCustomThemeActive)
      }
      if (migratedManualWords.length > 0) {
        void setSetting(LEGACY_MANUAL_WORDS_KEY, [])
      }
    } catch {
      // backend unreachable
    } finally {
      dispatch({ type: 'set_loading', value: false })
    }
  }, [persistBuiltinStates, persistCustomThemeStates, setSnapshot])

  useEffect(() => {
    void loadHotwords()
  }, [loadHotwords])

  const addTheme = useCallback(async () => {
    const name = newThemeName.trim()
    if (!name) return

    const exists = customThemes.some((theme) => theme.name.toLowerCase() === name.toLowerCase())
    if (exists) {
      dispatch({ type: 'set_new_theme_name', value: '' })
      return
    }

    const nextTheme: CustomTheme = { id: createThemeId(), name, words: [] }
    const nextThemes = [nextTheme, ...customThemes]
    const nextActiveMap = { ...customThemeActive, [nextTheme.id]: true }

    setSnapshot({
      customThemes: nextThemes,
      customThemeActive: nextActiveMap,
      newThemeName: '',
      themeInputs: { ...themeInputs, [nextTheme.id]: '' },
    })

    await persistCustomThemeStates(nextThemes, nextActiveMap)
  }, [customThemeActive, customThemes, newThemeName, persistCustomThemeStates, setSnapshot, themeInputs])

  const addWordsToTheme = useCallback(async (themeId: string) => {
    const raw = (themeInputs[themeId] || '').trim()
    if (!raw) return

    const theme = customThemes.find((item) => item.id === themeId)
    if (!theme) return

    const parsedWords = parseWordsInput(raw)
    if (parsedWords.length === 0) {
      dispatch({ type: 'set_theme_input', themeId, value: '' })
      return
    }

    const toAdd = parsedWords.filter((w) => !theme.words.includes(w))
    if (toAdd.length === 0) {
      dispatch({ type: 'set_theme_input', themeId, value: '' })
      return
    }

    const nextThemes = customThemes.map((item) => {
      if (item.id !== themeId) return item
      return { ...item, words: uniqueWords([...item.words, ...toAdd]) }
    })

    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      builtinSetActive,
      nextThemes,
      customThemeActive,
    )

    setSnapshot({
      customThemes: nextThemes,
      hotwords: updated,
      themeInputs: { ...themeInputs, [themeId]: '' },
    })

    await Promise.all([
      persistCustomThemeStates(nextThemes, customThemeActive),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    persistCustomThemeStates,
    setSnapshot,
    syncToBackend,
    themeInputs,
  ])

  const removeTheme = useCallback(async (themeId: string) => {
    const nextThemes = customThemes.filter((item) => item.id !== themeId)
    const nextActiveMap = { ...customThemeActive }
    delete nextActiveMap[themeId]

    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      builtinSetActive,
      nextThemes,
      nextActiveMap,
    )

    const nextInputs = { ...themeInputs }
    delete nextInputs[themeId]

    setSnapshot({
      customThemes: nextThemes,
      customThemeActive: nextActiveMap,
      hotwords: updated,
      themeInputs: nextInputs,
    })

    await Promise.all([
      persistCustomThemeStates(nextThemes, nextActiveMap),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    persistCustomThemeStates,
    setSnapshot,
    syncToBackend,
    themeInputs,
  ])

  const toggleCustomTheme = useCallback(async (themeId: string) => {
    const nextActiveMap = {
      ...customThemeActive,
      [themeId]: !customThemeActive[themeId],
    }

    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      builtinSetActive,
      customThemes,
      nextActiveMap,
    )

    setSnapshot({
      customThemeActive: nextActiveMap,
      hotwords: updated,
    })

    await Promise.all([
      setSetting(CUSTOM_THEME_ACTIVE_KEY, nextActiveMap),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    setSnapshot,
    syncToBackend,
  ])

  const removeWord = useCallback(async (word: string) => {
    const updated = hotwords.filter((w) => w !== word)
    let nextSetWords = builtinSetWords
    let setWordsChanged = false

    for (const key of Object.keys(BUILTIN_SETS)) {
      const setWords = nextSetWords[key] || []
      if (!setWords.includes(word)) continue
      if (!setWordsChanged) {
        nextSetWords = { ...nextSetWords }
        setWordsChanged = true
      }
      nextSetWords[key] = setWords.filter((w) => w !== word)
    }

    let nextThemes = customThemes
    let customThemesChanged = false
    if (customThemes.some((theme) => theme.words.includes(word))) {
      customThemesChanged = true
      nextThemes = customThemes.map((theme) => ({
        ...theme,
        words: theme.words.filter((w) => w !== word),
      }))
    }

    setSnapshot({
      hotwords: updated,
      ...(setWordsChanged ? { builtinSetWords: nextSetWords } : {}),
      ...(customThemesChanged ? { customThemes: nextThemes } : {}),
    })

    const tasks: Promise<unknown>[] = [syncToBackend(updated)]
    if (setWordsChanged) tasks.push(setSetting(BUILTIN_SET_WORDS_KEY, nextSetWords))
    if (customThemesChanged) tasks.push(setSetting(CUSTOM_THEMES_KEY, nextThemes))
    await Promise.all(tasks)
  }, [builtinSetWords, customThemes, hotwords, setSnapshot, syncToBackend])

  const toggleBuiltinSet = useCallback(async (key: string) => {
    const nextActiveMap = { ...builtinSetActive, [key]: !builtinSetActive[key] }
    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      nextActiveMap,
      customThemes,
      customThemeActive,
    )

    setSnapshot({
      builtinSetActive: nextActiveMap,
      hotwords: updated,
    })

    await Promise.all([
      setSetting(BUILTIN_SET_ACTIVE_KEY, nextActiveMap),
      syncToBackend(updated),
    ])
  }, [builtinSetActive, builtinSetWords, customThemeActive, customThemes, hotwords, setSnapshot, syncToBackend])

  const resetBuiltinSet = useCallback(async (key: string) => {
    const setDef = BUILTIN_SETS[key]
    if (!setDef) return

    const defaults = uniqueWords(setDef.words)
    const nextWordsMap = { ...builtinSetWords, [key]: defaults }
    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      nextWordsMap,
      builtinSetActive,
      customThemes,
      customThemeActive,
    )

    setSnapshot({
      builtinSetWords: nextWordsMap,
      hotwords: updated,
    })

    await Promise.all([
      setSetting(BUILTIN_SET_WORDS_KEY, nextWordsMap),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    setSnapshot,
    syncToBackend,
  ])

  const hotwordSet = useMemo(() => new Set(hotwords), [hotwords])
  const allKnownWords = useMemo(() => collectAllSourceWords(builtinSetWords, customThemes), [builtinSetWords, customThemes])
  const unknownWords = useMemo(
    () => hotwords.filter((word) => !allKnownWords.has(word)),
    [allKnownWords, hotwords],
  )

  const filtered = search
    ? hotwords.filter((w) => w.toLowerCase().includes(search.toLowerCase()))
    : hotwords

  const filteredUnknown = search
    ? unknownWords.filter((w) => w.toLowerCase().includes(search.toLowerCase()))
    : unknownWords

  const getSetWordsInHotwords = useCallback((key: string) => {
    const setWords = builtinSetWords[key] || []
    const activeWords = setWords.filter((w) => hotwordSet.has(w))
    if (!search) return activeWords
    return activeWords.filter((w) => w.toLowerCase().includes(search.toLowerCase()))
  }, [builtinSetWords, hotwordSet, search])

  const getThemeWordsInHotwords = useCallback((theme: CustomTheme) => {
    const activeWords = theme.words.filter((w) => hotwordSet.has(w))
    if (!search) return activeWords
    return activeWords.filter((w) => w.toLowerCase().includes(search.toLowerCase()))
  }, [hotwordSet, search])

  const visibleCustomThemes = customThemes.filter((theme) => {
    if (!search) return true
    const activeWords = getThemeWordsInHotwords(theme)
    return activeWords.length > 0 || theme.name.toLowerCase().includes(search.toLowerCase())
  })

  return {
    hotwords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    themeInputs,
    newThemeName,
    search,
    loading,
    showUnknown,
    filtered,
    filteredUnknown,
    visibleCustomThemes,
    getSetWordsInHotwords,
    getThemeWordsInHotwords,
    setNewThemeName: (value: string) => dispatch({ type: 'set_new_theme_name', value }),
    setSearch: (value: string) => dispatch({ type: 'set_search', value }),
    setShowUnknown: (value: boolean) => dispatch({ type: 'set_show_unknown', value }),
    setThemeInput: (themeId: string, value: string) => dispatch({ type: 'set_theme_input', themeId, value }),
    addTheme,
    addWordsToTheme,
    removeTheme,
    toggleCustomTheme,
    removeWord,
    toggleBuiltinSet,
    resetBuiltinSet,
  }
}
