import type { ThemeDefinition } from './types'

/**
 * Claude UI 风格主题
 * 灵感来源：Claude 的暖色调、米色背景、棕橙色强调色
 */
const claude: ThemeDefinition = {
  id: 'claude',
  name: '暖色',
  isDark: false,
  previewColors: {
    bg: '#faf9f5',
    sidebar: '#eeece7',
    primary: '#b5490f',
    accent: '#eeece7',
  },
  vars: {
    // 基础色 — 暖色调米色系
    '--background': '40 33% 97%',       // #faf9f5 米白
    '--foreground': '25 8% 20%',         // #3b3530 深棕
    '--card': '40 33% 98%',              // #fbfaf7 卡片白
    '--card-foreground': '25 8% 20%',
    '--primary': '22 85% 38%',           // #b5490f 棕橙（Claude 标志色）
    '--primary-foreground': '40 33% 97%',
    '--secondary': '37 22% 90%',         // #eeece7 暖灰
    '--secondary-foreground': '25 8% 20%',
    '--muted': '37 22% 90%',
    '--muted-foreground': '25 6% 50%',   // #877f76 中棕
    '--accent': '37 22% 90%',
    '--accent-foreground': '25 8% 20%',
    '--destructive': '0 72% 51%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '37 18% 84%',            // #ddd9d1 暖边框
    '--input': '37 18% 84%',
    '--ring': '22 85% 38%',
    '--radius': '0.5rem',

    // 区域色
    '--sidebar-bg': '37 22% 92%',        // #f0eee9 侧边栏暖灰
    '--sidebar-border': '37 18% 84%',
    '--sidebar-item-active-bg': '37 22% 86%',
    '--sidebar-item-hover-bg': '37 22% 88%',
    '--sidebar-text': '25 6% 50%',
    '--sidebar-text-active': '25 8% 20%',
    '--titlebar-bg': '37 22% 92%',
    '--titlebar-text': '25 6% 50%',
    '--titlebar-close-hover-bg': '0 72% 51%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // 表单控件
    '--input-bg': '40 33% 98%',
    '--input-border': '37 18% 84%',
    '--input-focus-border': '22 85% 38%',
    '--input-focus-ring': '22 85% 38%',
    '--input-placeholder': '25 6% 62%',

    // 状态色
    '--success': '142 76% 36%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '0 0% 100%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
  },

  // Claude 主题特色扩展
  extras: {
    '--claude-accent-warm': '22 85% 38%',
    '--claude-bg-subtle': '40 25% 95%',
  },
}

export default claude
