import * as bridge from './bridge'
import { invoke } from '@tauri-apps/api/core'
import { getHotwords } from './api'
import {
  BUILTIN_SET_ACTIVE_KEY,
  BUILTIN_SET_WORDS_KEY,
  CUSTOM_THEME_ACTIVE_KEY,
  CUSTOM_THEMES_KEY,
  LEGACY_MANUAL_WORDS_KEY,
} from './hotwords/model'
import { getAppPromptRules, getUserStats } from './personalization/store'
import {
  countHistory,
  getPromptPresets,
  getSetting,
  listHistory,
  type HistoryListQuery,
  type HistoryRecord,
} from './store'

type ExportFormat = 'json' | 'csv'

const SETTINGS_EXPORT_KEYS = [
  'activePresetId',
  'aiEnabled',
  'hotwordLearning',
  'overlayShowDuration',
  'overlayWaveTheme',
  'selectedMic',
  'shortcutHandsFree',
  'shortcutKey',
  'shortcutPTT',
  'shortcutPTTCombo',
  'styleProfile',
] as const

interface SaveResult {
  canceled: boolean
  filePath: string | null
}

function slugTimestamp(ts = new Date()) {
  return ts.toISOString().replace(/[:.]/g, '-')
}

function escapeCsv(value: unknown) {
  const text = String(value ?? '')
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function historyToCsv(records: HistoryRecord[]) {
  const headers = [
    'id',
    'timestamp',
    'favorite',
    'appName',
    'durationSec',
    'charCount',
    'asrText',
    'llmText',
    'promptPresetName',
    'promptSummary',
    'styleSummary',
  ]

  const lines = records.map((record) => [
    record.id,
    record.timestamp,
    record.favorite ? 'true' : 'false',
    record.appName || '',
    record.durationSec,
    record.charCount,
    record.asrText || '',
    record.llmText || '',
    record.promptPresetName || '',
    record.promptSummary || '',
    record.styleSummary || '',
  ].map(escapeCsv).join(','))

  return [headers.join(','), ...lines].join('\n')
}

async function saveTextFile(defaultPath: string, content: string, filters: Array<{ name: string; extensions: string[] }>): Promise<SaveResult> {
  const filePath = await bridge.saveTextExport({
    defaultPath,
    content,
    filters,
  })

  return {
    canceled: !filePath,
    filePath: filePath || null,
  }
}

async function saveBundle(defaultPath: string, files: Array<{ name: string; content: string }>): Promise<SaveResult> {
  const filePath = await bridge.saveExportBundle({
    defaultPath,
    files,
  })

  return {
    canceled: !filePath,
    filePath: filePath || null,
  }
}

async function buildHistoryPayload(query: HistoryListQuery = {}) {
  const [records, total] = await Promise.all([
    listHistory(query),
    countHistory({
      keyword: query.keyword,
      favoriteOnly: query.favoriteOnly,
    }),
  ])

  return {
    exportedAt: new Date().toISOString(),
    filters: {
      keyword: query.keyword || '',
      favoriteOnly: !!query.favoriteOnly,
    },
    total,
    records,
  }
}

async function buildSettingsPayload() {
  const settingsEntries = await Promise.all(
    SETTINGS_EXPORT_KEYS.map(async (key) => [key, await getSetting(key, null)] as const),
  )

  const [autoLaunch, promptPresets, appPromptRules, userStats] = await Promise.all([
    bridge.getAutoLaunch() ?? false,
    getPromptPresets(),
    getAppPromptRules(),
    getUserStats(),
  ])

  return {
    exportedAt: new Date().toISOString(),
    appSettings: {
      ...Object.fromEntries(settingsEntries),
      autoLaunch,
    },
    promptPresets,
    appPromptRules,
    userStats,
  }
}

async function buildHotwordsPayload() {
  const [
    activeWords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    manualHotwords,
    builtinHotwordSets,
    hotwordLearning,
  ] = await Promise.all([
    getHotwords().catch(() => [] as string[]),
    getSetting<Record<string, string[]>>(BUILTIN_SET_WORDS_KEY, {}),
    getSetting<Record<string, boolean>>(BUILTIN_SET_ACTIVE_KEY, {}),
    getSetting(CUSTOM_THEMES_KEY, [] as unknown[]),
    getSetting<Record<string, boolean>>(CUSTOM_THEME_ACTIVE_KEY, {}),
    getSetting<string[]>(LEGACY_MANUAL_WORDS_KEY, []),
    getSetting<Record<string, unknown>>('builtinHotwordSets', {}),
    getSetting('hotwordLearning', null),
  ])

  return {
    exportedAt: new Date().toISOString(),
    activeWords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    manualHotwords,
    builtinHotwordSets,
    hotwordLearning,
  }
}

export async function exportHistory(query: HistoryListQuery = {}, format: ExportFormat = 'json') {
  const payload = await buildHistoryPayload(query)
  const stamp = slugTimestamp()

  if (format === 'csv') {
    return saveTextFile(
      `sayit-history-${stamp}.csv`,
      historyToCsv(payload.records),
      [{ name: 'CSV Files', extensions: ['csv'] }],
    )
  }

  return saveTextFile(
    `sayit-history-${stamp}.json`,
    JSON.stringify(payload, null, 2),
    [{ name: 'JSON Files', extensions: ['json'] }],
  )
}

export async function exportFavorites(format: ExportFormat = 'json') {
  const payload = await buildHistoryPayload({ favoriteOnly: true })
  const stamp = slugTimestamp()

  if (format === 'csv') {
    return saveTextFile(
      `sayit-favorites-${stamp}.csv`,
      historyToCsv(payload.records),
      [{ name: 'CSV Files', extensions: ['csv'] }],
    )
  }

  return saveTextFile(
    `sayit-favorites-${stamp}.json`,
    JSON.stringify(payload, null, 2),
    [{ name: 'JSON Files', extensions: ['json'] }],
  )
}

export async function exportSettings() {
  const payload = await buildSettingsPayload()
  return saveTextFile(
    `sayit-settings-${slugTimestamp()}.json`,
    JSON.stringify(payload, null, 2),
    [{ name: 'JSON Files', extensions: ['json'] }],
  )
}

export async function exportHotwords() {
  const payload = await buildHotwordsPayload()
  return saveTextFile(
    `sayit-hotwords-${slugTimestamp()}.json`,
    JSON.stringify(payload, null, 2),
    [{ name: 'JSON Files', extensions: ['json'] }],
  )
}

export async function exportAllDataBundle() {
  const [history, favorites, settings, hotwords] = await Promise.all([
    buildHistoryPayload(),
    buildHistoryPayload({ favoriteOnly: true }),
    buildSettingsPayload(),
    buildHotwordsPayload(),
  ])

  const exportedAt = new Date().toISOString()
  const files = [
    {
      name: 'manifest.json',
      content: JSON.stringify({
        exportedAt,
        files: ['history.json', 'favorites.json', 'settings.json', 'hotwords.json'],
        includesAudio: true,
        counts: {
          history: history.total,
          favorites: favorites.total,
          activeHotwords: Array.isArray(hotwords.activeWords) ? hotwords.activeWords.length : 0,
        },
      }, null, 2),
    },
    { name: 'history.json', content: JSON.stringify(history, null, 2) },
    { name: 'favorites.json', content: JSON.stringify(favorites, null, 2) },
    { name: 'settings.json', content: JSON.stringify(settings, null, 2) },
    { name: 'hotwords.json', content: JSON.stringify(hotwords, null, 2) },
  ]

  const defaultPath = `sayit-export-${slugTimestamp()}.zip`
  const filePath = await invoke<string | null>('save_full_export', {
    payload: { defaultPath, files },
  })

  return {
    canceled: !filePath,
    filePath: filePath || null,
  }
}
