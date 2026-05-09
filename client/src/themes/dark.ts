import type { ThemeDefinition } from './types'

/**
 * 暗色主题 — VS Code 风格
 * 低饱和度中性灰，蓝色强调，文字对比度充足
 */
const dark: ThemeDefinition = {
  id: 'dark',
  name: '深色',
  isDark: true,
  previewColors: {
    bg: '#1e1e1e',
    sidebar: '#181818',
    primary: '#569cd6',
    accent: '#2d2d2d',
  },
  vars: {
    // 基础色 — 中性灰
    '--background': '0 0% 12%',
    '--foreground': '0 0% 90%',
    '--card': '0 0% 15%',
    '--card-foreground': '0 0% 90%',
    '--primary': '210 60% 58%',            // VS Code 蓝
    '--primary-foreground': '0 0% 100%',
    '--secondary': '0 0% 18%',
    '--secondary-foreground': '0 0% 88%',
    '--muted': '0 0% 18%',
    '--muted-foreground': '0 0% 65%',
    '--accent': '0 0% 20%',
    '--accent-foreground': '0 0% 90%',
    '--destructive': '0 60% 55%',
    '--destructive-foreground': '0 0% 95%',
    '--border': '0 0% 22%',
    '--input': '0 0% 22%',
    '--ring': '210 60% 58%',
    '--radius': '0.5rem',

    // 区域色
    '--sidebar-bg': '0 0% 10%',
    '--sidebar-border': '0 0% 18%',
    '--sidebar-item-active-bg': '0 0% 18%',
    '--sidebar-item-hover-bg': '0 0% 16%',
    '--sidebar-text': '0 0% 60%',
    '--sidebar-text-active': '0 0% 92%',
    '--titlebar-bg': '0 0% 10%',
    '--titlebar-text': '0 0% 65%',
    '--titlebar-close-hover-bg': '0 60% 50%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // 表单控件
    '--input-bg': '0 0% 13%',
    '--input-border': '0 0% 22%',
    '--input-focus-border': '210 60% 58%',
    '--input-focus-ring': '210 60% 58%',
    '--input-placeholder': '0 0% 45%',

    // 状态色
    '--success': '120 40% 55%',
    '--success-foreground': '0 0% 100%',
    '--warning': '40 80% 60%',
    '--warning-foreground': '0 0% 10%',
    '--info': '210 60% 58%',
    '--info-foreground': '0 0% 100%',
  },
}

export default dark
