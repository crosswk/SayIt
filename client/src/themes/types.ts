/** 主题系统类型定义 */

/** 全局语义 CSS 变量 — 所有主题必须提供 */
export interface ThemeVars {
  // 基础色
  '--background': string
  '--foreground': string
  '--card': string
  '--card-foreground': string
  '--primary': string
  '--primary-foreground': string
  '--secondary': string
  '--secondary-foreground': string
  '--muted': string
  '--muted-foreground': string
  '--accent': string
  '--accent-foreground': string
  '--destructive': string
  '--destructive-foreground': string
  '--border': string
  '--input': string
  '--ring': string
  '--radius': string

  // 区域色
  '--sidebar-bg': string
  '--sidebar-border': string
  '--sidebar-item-active-bg': string
  '--sidebar-item-hover-bg': string
  '--sidebar-text': string
  '--sidebar-text-active': string
  '--titlebar-bg': string
  '--titlebar-text': string
  '--titlebar-close-hover-bg': string
  '--titlebar-close-hover-text': string

  // 表单控件
  '--input-bg': string
  '--input-border': string
  '--input-focus-border': string
  '--input-focus-ring': string
  '--input-placeholder': string

  // 状态色
  '--success': string
  '--success-foreground': string
  '--warning': string
  '--warning-foreground': string
  '--info': string
  '--info-foreground': string
}

/** 主题扩展变量 — 主题独有的特色变量（可选） */
export type ThemeExtras = Record<string, string>

/** 主题字体配置（可选） */
export interface ThemeFonts {
  /** body 正文字体 */
  body?: string
  /** 等宽字体 */
  mono?: string
}

/** 主题定义 */
export interface ThemeDefinition {
  /** 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 是否为暗色主题（控制 Tailwind dark: 前缀） */
  isDark: boolean
  /** 预览色（用于设置页面的主题选择器） */
  previewColors: {
    bg: string
    sidebar: string
    primary: string
    accent: string
  }
  /** 全局 CSS 变量 */
  vars: ThemeVars
  /** 主题独有的扩展变量 */
  extras?: ThemeExtras
  /** 主题字体（不设置则使用全局默认字体） */
  fonts?: ThemeFonts
}

/** 主题 ID 类型 */
export type ThemeId = 'light' | 'dark' | 'claude'
