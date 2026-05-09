/**
 * 主题状态管理
 * 负责主题的持久化（存到 settings）和初始化
 */
import { applyTheme, getCurrentThemeId } from '@/themes'
import { getSetting, setSetting } from '@/services/store'

const THEME_SETTING_KEY = 'theme'
const DEFAULT_THEME = 'teal-dark'

/** 初始化主题：从 settings 读取并应用 */
export async function initTheme(): Promise<string> {
  const saved = await getSetting(THEME_SETTING_KEY, DEFAULT_THEME)
  const themeId = typeof saved === 'string' ? saved : DEFAULT_THEME
  return applyTheme(themeId)
}

/** 切换主题并持久化 */
export async function switchTheme(id: string): Promise<string> {
  const applied = applyTheme(id)
  await setSetting(THEME_SETTING_KEY, applied)
  return applied
}

/** 获取当前主题 ID */
export function getActiveThemeId(): string {
  return getCurrentThemeId()
}
