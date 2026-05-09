import type { AppPromptRule, UserStats } from './types'

export const BUILTIN_APP_RULES: AppPromptRule[] = [
  {
    id: 'teams',
    appId: 'teams',
    name: 'Teams',
    builtin: true,
    enabled: true,
    priority: 100,
    presetId: 'intent',
    promptAppend: '适合即时协作聊天。优先输出可以直接发送的短消息，语气自然、清晰、简洁，避免邮件腔。',
    matcher: {
      processNames: ['teams.exe', 'ms-teams.exe'],
      windowTitleIncludes: ['teams'],
    },
  },
  {
    id: 'outlook',
    appId: 'outlook',
    name: 'Outlook',
    builtin: true,
    enabled: true,
    priority: 95,
    presetId: 'intent',
    promptAppend: '适合工作邮件草稿。语气正式、完整，必要时自然分段，但不要编造收件人、称呼或任何事实。',
    matcher: {
      processNames: ['outlook.exe', 'olk.exe'],
      windowTitleIncludes: ['outlook'],
    },
  },
  {
    id: 'kiro',
    appId: 'kiro',
    name: 'Kiro',
    builtin: true,
    enabled: true,
    priority: 90,
    presetId: 'faithful',
    promptAppend: '面向开发工具输入。保留代码、命令、文件名、路径、英文标识符和 Markdown 结构，不要把技术词改写成普通中文。',
    matcher: {
      processNames: ['kiro.exe'],
      windowTitleIncludes: ['kiro'],
    },
  },
  {
    id: 'vscode',
    appId: 'vscode',
    name: 'VSCode',
    builtin: true,
    enabled: true,
    priority: 85,
    presetId: 'faithful',
    promptAppend: '面向 VSCode 编辑区。保留代码、命令、文件名、API、英文术语和 Markdown 结构，不要过度润色技术内容。',
    matcher: {
      processNames: ['code.exe'],
      windowTitleIncludes: ['visual studio code', 'vscode'],
    },
  },
  {
    id: 'cursor',
    appId: 'cursor',
    name: 'Cursor',
    builtin: true,
    enabled: true,
    priority: 80,
    presetId: 'faithful',
    promptAppend: '面向 Cursor 编辑区。保留代码、命令、路径、技术名词和英文标识符，不要擅自解释或补全技术内容。',
    matcher: {
      processNames: ['cursor.exe'],
      windowTitleIncludes: ['cursor'],
    },
  },
]

export function createDefaultUserStats(): UserStats {
  return {
    totalWords: 0,
    totalSessions: 0,
    domainWords: {},
    appUsageCount: {},
  }
}
