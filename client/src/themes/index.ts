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
import { getCurrentWindow, type Theme } from '@tauri-apps/api/window'
import { IS_MAC } from '@/lib/platform'

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
// mac：系统字体和苹方优先（否则装了 Office 的 Mac 会先命中微软雅黑）；Windows 保持原样。
const DEFAULT_FONT_BODY = IS_MAC
  ? '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif'
  : '"Microsoft YaHei", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'

/**
 * macOS：让系统画的部分和主题的深浅一致（只是渲染，不是新选项）。
 * - color-scheme：网页里的原生控件（系统滚动条、下拉框）按它取深浅色；
 * - 窗口外观：弹出的原生菜单（下拉框的选项、右键菜单）按它取深浅色。
 * 不同步的话，深色主题里滚动条是深色压在深色上、弹出的是浅色菜单。
 */
function syncMacAppearance(isDark: boolean): void {
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
  void setMainWindowAppearance(isDark ? 'dark' : 'light')
}

async function setMainWindowAppearance(theme: Theme): Promise<void> {
  try {
    await getCurrentWindow().setTheme(theme)
  } catch {
    // 设置失败只影响原生菜单的深浅色，不影响页面本身
  }
}

/**
 * 外观同步只做在主窗口里。更新通知是透明窗口：给它设 color-scheme 可能让 WebKit 把透明底
 * 画成深色底；它也没有原生菜单，没有 setTheme 权限。
 */
function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === 'main'
  } catch {
    // 不在 Tauri 里（单测）
    return false
  }
}

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

  if (IS_MAC && isMainWindow()) syncMacAppearance(theme.isDark)

  currentThemeId = theme.id
  return theme.id
}

export type { ThemeDefinition, ThemeId }
