import type { ActiveAppContext } from '@/types/appContext'
import type { PromptPreset } from '@/services/store'

export interface AppPromptMatcher {
  processNames: string[]
  windowTitleIncludes?: string[]
  windowClasses?: string[]
  automationIds?: string[]
}

export interface AppPromptRule {
  id: string
  appId: string
  name: string
  enabled: boolean
  builtin?: boolean
  priority: number
  presetId?: string
  promptAppend: string
  matcher: AppPromptMatcher
}

export interface UserStats {
  totalWords: number
  totalSessions: number
  domainWords: Record<string, number>
  appUsageCount: Record<string, number>
  firstUsedAt?: number
  lastUsedAt?: number
}

export interface PromptResolution {
  appId?: string
  appName?: string
  preset: PromptPreset
  matchedRule?: AppPromptRule
  systemPrompt: string
  summary: string
}

export interface PromptRoutingInput {
  appContext: ActiveAppContext | null
  presets: PromptPreset[]
  activePresetId: string
  appRules: AppPromptRule[]
  userStats: UserStats
  /** 生效的热词列表（用于可选的"注入 AI 提示词"功能） */
  hotwords?: string[]
  /** 是否把热词注入到 AI 系统提示词，帮助 AI 纠正专有名词。默认关闭。 */
  injectHotwords?: boolean
}
