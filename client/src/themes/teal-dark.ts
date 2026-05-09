import type { ThemeDefinition } from './types'

/**
 * 青绿深色主题 — 墨玉
 * 深灰底带极微青色调，青绿强调色，沉稳护眼
 */
const tealDark: ThemeDefinition = {
  id: 'teal-dark',
  name: '墨玉',
  isDark: true,
  previewColors: {
    bg: '#191d1d',
    sidebar: '#141818',
    primary: '#2ec4b6',
    accent: '#222928',
  },
  vars: {
    // 基础色 — 深灰微青
    '--background': '180 5% 10%',          // #191d1d
    '--foreground': '170 5% 88%',
    '--card': '180 4% 13%',
    '--card-foreground': '170 5% 88%',
    '--primary': '174 65% 47%',            // #2ec4b6 亮青绿
    '--primary-foreground': '180 8% 6%',
    '--secondary': '180 4% 16%',
    '--secondary-foreground': '170 5% 85%',
    '--muted': '180 4% 16%',
    '--muted-foreground': '170 3% 58%',
    '--accent': '178 6% 18%',
    '--accent-foreground': '170 5% 88%',
    '--destructive': '0 55% 55%',
    '--destructive-foreground': '0 0% 95%',
    '--border': '180 4% 20%',
    '--input': '180 4% 20%',
    '--ring': '174 65% 47%',
    '--radius': '0.5rem',

    // 区域色
    '--sidebar-bg': '180 6% 8%',
    '--sidebar-border': '180 4% 16%',
    '--sidebar-item-active-bg': '178 8% 15%',
    '--sidebar-item-hover-bg': '180 5% 13%',
    '--sidebar-text': '170 3% 52%',
    '--sidebar-text-active': '174 65% 47%',
    '--titlebar-bg': '180 6% 8%',
    '--titlebar-text': '170 3% 58%',
    '--titlebar-close-hover-bg': '0 55% 50%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // 表单控件
    '--input-bg': '180 4% 11%',
    '--input-border': '180 4% 20%',
    '--input-focus-border': '174 65% 47%',
    '--input-focus-ring': '174 65% 47%',
    '--input-placeholder': '170 3% 40%',

    // 状态色
    '--success': '160 45% 52%',
    '--success-foreground': '0 0% 100%',
    '--warning': '42 75% 58%',
    '--warning-foreground': '0 0% 10%',
    '--info': '190 55% 52%',
    '--info-foreground': '0 0% 100%',
  },
}

export default tealDark
