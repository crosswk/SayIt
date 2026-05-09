/**
 * 主题注册表 + 切换逻辑
 *
 * 用法：
 *   import { applyTheme, getTheme, themeList } from '@/themes'
 *   applyTheme('dark')
 */
import type { ThemeDefinition, ThemeId } from './types'
import light from './light'
import dark from './dark'
import claude from './claude'

/** 所有已注册主题（新增主题只需在此添加一行） */
const themes: Record<string, ThemeDefinition> = {
  light,
  dark,
  claude,
}

/** 主题列表（用于 UI 渲染） */
export const themeList: ThemeDefinition[] = Object.values(themes)

/** 获取主题定义，找不到则回退 light */
export function getTheme(id: string): ThemeDefinition {
  return themes[id] || themes.light
}

/** 当前已应用的主题 ID */
let currentThemeId: string = 'light'

/** 获取当前主题 ID */
export function getCurrentThemeId(): string {
  return currentThemeId
}

/** 默认字体（与 index.css body 一致） */
const DEFAULT_FONT_BODY = '"Microsoft YaHei", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'

/**
 * 应用主题：将 CSS 变量注入 :root，切换 dark class，设置字体
 * @returns 实际应用的主题 ID
 */
export function applyTheme(id: string): string {
  const theme = getTheme(id)
  const root = document.documentElement

  // 注入全局变量
  const allVars = { ...theme.vars, ...(theme.extras || {}) }
  for (const [key, value] of Object.entries(allVars)) {
    root.style.setProperty(key, value)
  }

  // 切换字体
  document.body.style.fontFamily = theme.fonts?.body || DEFAULT_FONT_BODY

  // 切换 dark class（Tailwind dark: 前缀）
  if (theme.isDark) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }

  // 切换主题标识 class（方便主题特定 CSS）
  for (const t of themeList) {
    root.classList.remove(`theme-${t.id}`)
  }
  root.classList.add(`theme-${theme.id}`)

  currentThemeId = theme.id
  return theme.id
}

export type { ThemeDefinition, ThemeId }
