import type { ThemeDefinition } from './types'

/**
 * 青绿主题 — 纸张质感
 * 暖米色背景 + 青绿强调，灵感来自后端管理页面
 * 适合长时间使用，护眼且有品牌感
 */
const teal: ThemeDefinition = {
  id: 'teal',
  name: '纸墨',
  isDark: false,
  previewColors: {
    bg: '#f5f3eb',
    sidebar: '#edeae2',
    primary: '#0d7377',
    accent: '#e8eeec',
  },
  vars: {
    // 基础色 — 暖米纸张底
    '--background': '42 22% 94%',          // #f5f3eb
    '--foreground': '220 13% 18%',         // #1f2937
    '--card': '44 50% 97%',               // #faf8f2 暖白卡片
    '--card-foreground': '220 13% 18%',
    '--primary': '182 80% 26%',            // #0d7377 青绿，比之前更亮更鲜活
    '--primary-foreground': '0 0% 100%',
    '--secondary': '40 16% 90%',           // #ece9e1
    '--secondary-foreground': '220 13% 18%',
    '--muted': '40 16% 90%',
    '--muted-foreground': '220 9% 46%',
    '--accent': '175 14% 91%',            // 浅青灰
    '--accent-foreground': '220 13% 18%',
    '--destructive': '0 72% 51%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '36 22% 85%',             // #ddd8cc 暖米边框
    '--input': '36 22% 85%',
    '--ring': '182 80% 26%',
    '--radius': '0.5rem',

    // 区域色
    '--sidebar-bg': '40 16% 90%',
    '--sidebar-border': '36 22% 85%',
    '--sidebar-item-active-bg': '175 16% 87%',
    '--sidebar-item-hover-bg': '40 14% 88%',
    '--sidebar-text': '220 9% 46%',
    '--sidebar-text-active': '182 80% 26%',
    '--titlebar-bg': '40 16% 90%',
    '--titlebar-text': '220 9% 46%',
    '--titlebar-close-hover-bg': '0 72% 51%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // 表单控件
    '--input-bg': '44 50% 97%',
    '--input-border': '36 22% 85%',
    '--input-focus-border': '182 80% 26%',
    '--input-focus-ring': '182 80% 26%',
    '--input-placeholder': '220 6% 58%',

    // 状态色
    '--success': '160 60% 38%',            // 与青绿协调的绿
    '--success-foreground': '0 0% 100%',
    '--warning': '38 85% 50%',
    '--warning-foreground': '0 0% 100%',
    '--info': '195 80% 44%',
    '--info-foreground': '0 0% 100%',
  },
}

export default teal
