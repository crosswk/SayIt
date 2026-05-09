// 文本替换服务 — 对 ASR 识别结果做客户端侧的文本替换

import { getSetting, setSetting } from './store'

export interface TextReplacementRule {
  id: string
  from: string
  to: string
  enabled: boolean
}

const STORAGE_KEY = 'textReplacements'

/** 内置默认文本替换规则（新用户首次使用时填充） */
export const BUILTIN_REPLACEMENTS: TextReplacementRule[] = [
  { id: 'builtin_1', from: '安卓说话', to: '按住说话', enabled: true },
  { id: 'builtin_2', from: '我的邮箱', to: 'test@example.com', enabled: true },
  { id: 'builtin_3', from: 'pump', to: 'Prompt', enabled: true },
  { id: 'builtin_4', from: 'Cloud Code', to: 'Claude Code', enabled: true },
]

export async function getTextReplacements(): Promise<TextReplacementRule[]> {
  const rules = await getSetting<TextReplacementRule[]>(STORAGE_KEY, [])
  // 新用户没有任何规则时，返回内置默认
  if (!rules || rules.length === 0) {
    return BUILTIN_REPLACEMENTS.map((r) => ({ ...r }))
  }
  return rules
}

export async function saveTextReplacements(rules: TextReplacementRule[]): Promise<void> {
  await setSetting(STORAGE_KEY, rules)
}

/** 对文本应用所有启用的替换规则 */
export function applyReplacements(text: string, rules: TextReplacementRule[]): string {
  let result = text
  for (const rule of rules) {
    if (rule.enabled && rule.from) {
      result = result.split(rule.from).join(rule.to)
    }
  }
  return result
}

/** 加载规则并应用替换（便捷方法） */
export async function applyTextReplacements(text: string): Promise<string> {
  if (!text) return text
  const rules = await getTextReplacements()
  if (rules.length === 0) return text
  return applyReplacements(text, rules)
}
