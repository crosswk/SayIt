import type { UserStats } from './types'

interface DomainSceneRule {
  id: string
  label: string
  matchers: string[]
  promptSnippet?: string
}

export interface DomainSceneSummary {
  id: string
  label: string
  words: number
  ratio: number
}

const DOMAIN_SCENE_RULES: DomainSceneRule[] = [
  {
    id: 'development',
    label: '开发场景',
    matchers: [
      'code',
      'cursor',
      'devenv',
      'idea',
      'webstorm',
      'pycharm',
      'goland',
      'clion',
      'studio64',
      'kiro',
    ],
    promptSnippet: '该用户具有深厚的软件开发背景，遇到发音模糊的词汇请优先推测为 IT 术语、API 名称、命令行参数或英文变量。',
  },
  {
    id: 'communication',
    label: '通讯沟通',
    matchers: ['wechat', 'wecom', 'qq', 'teams', 'slack', 'discord', 'telegram', 'dingtalk'],
    promptSnippet: '该用户长期处于即时沟通场景，遇到模糊表达时优先整理成简洁、可直接发送的消息。',
  },
  {
    id: 'office',
    label: '办公写作',
    matchers: ['outlook', 'word', 'excel', 'powerpnt', 'wps', 'onenote', 'notion'],
    promptSnippet: '该用户长期处于办公写作场景，遇到模糊表达时优先采用正式、完整、结构清晰的书面语，但不要新增事实。',
  },
  {
    id: 'browser',
    label: '浏览检索',
    matchers: ['chrome', 'msedge', 'edge', 'firefox', 'arc', 'safari'],
  },
]

const FALLBACK_SCENE: DomainSceneRule = {
  id: 'general',
  label: '通用输入',
  matchers: [],
}

function normalizeAppId(appId: string) {
  return String(appId || '').trim().toLowerCase()
}

function pickSceneRule(appId: string) {
  const normalized = normalizeAppId(appId)
  return DOMAIN_SCENE_RULES.find((rule) => rule.matchers.some((matcher) => normalized.includes(matcher))) || FALLBACK_SCENE
}

function getStatsTotalWords(stats: UserStats) {
  if (stats.totalWords > 0) return stats.totalWords
  return Object.values(stats.domainWords).reduce((sum, words) => sum + words, 0)
}

export function summarizeDomainScenes(stats: UserStats, limit = 3): DomainSceneSummary[] {
  const totalWords = getStatsTotalWords(stats)
  if (totalWords <= 0) return []

  const wordsByScene = new Map<string, DomainSceneSummary>()
  for (const [appId, words] of Object.entries(stats.domainWords)) {
    if (words <= 0) continue
    const rule = pickSceneRule(appId)
    const current = wordsByScene.get(rule.id)
    if (current) {
      current.words += words
      current.ratio = current.words / totalWords
      continue
    }

    wordsByScene.set(rule.id, {
      id: rule.id,
      label: rule.label,
      words,
      ratio: words / totalWords,
    })
  }

  return [...wordsByScene.values()]
    .sort((left, right) => right.words - left.words)
    .slice(0, limit)
}

export function buildDynamicIdentityPrompt(stats: UserStats) {
  if (stats.totalWords <= 1000) return ''

  const dominantScene = summarizeDomainScenes(stats, 1)[0]
  if (!dominantScene || dominantScene.ratio <= 0.3) return ''

  return DOMAIN_SCENE_RULES.find((rule) => rule.id === dominantScene.id)?.promptSnippet || ''
}
