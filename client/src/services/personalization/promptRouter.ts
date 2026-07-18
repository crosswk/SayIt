import type { ActiveAppContext } from '@/types/appContext'
import { BUILTIN_PRESETS } from '@/services/store'
import type { AppPromptRule, PromptResolution, PromptRoutingInput } from './types'
import { buildDynamicIdentityPrompt, summarizeDomainScenes } from './userStats'

function normalizeText(value?: string) {
  return String(value || '').trim().toLowerCase()
}

function normalizeProcessName(context: ActiveAppContext | null) {
  const processName = normalizeText(context?.processName)
  if (processName) return processName

  const exePath = String(context?.exePath || '')
  const segments = exePath.split(/[\\/]/)
  return normalizeText(segments[segments.length - 1])
}

function includesAny(value: string, patterns?: string[]) {
  if (!value || !patterns?.length) return false
  return patterns.some((pattern) => value.includes(normalizeText(pattern)))
}

export function matchesAppPromptRule(rule: AppPromptRule, context: ActiveAppContext | null) {
  if (!context) return false

  const processName = normalizeProcessName(context)
  const windowTitle = normalizeText(context.windowTitle)
  const windowClass = normalizeText(context.windowClass)
  const automationId = normalizeText(context.automationId)

  const processMatched = rule.matcher.processNames.length > 0
    && rule.matcher.processNames.some((candidate) => processName === normalizeText(candidate))
  if (processMatched) return true
  if (includesAny(windowTitle, rule.matcher.windowTitleIncludes)) return true
  if (includesAny(windowClass, rule.matcher.windowClasses)) return true
  if (includesAny(automationId, rule.matcher.automationIds)) return true
  return false
}

function pickPreset(presetId: string | undefined, presets: PromptRoutingInput['presets'], activePresetId: string) {
  const fallback = presets.find((preset) => preset.id === activePresetId)
    || BUILTIN_PRESETS.find((preset) => preset.id === activePresetId)
    || presets[0]
    || BUILTIN_PRESETS[0]

  if (!presetId) return fallback
  return presets.find((preset) => preset.id === presetId)
    || BUILTIN_PRESETS.find((preset) => preset.id === presetId)
    || fallback
}

function summarizeResolution(parts: string[]) {
  return parts.filter(Boolean).join(' | ')
}

/** 构造"热词注入 AI 提示词"的段落；无热词时返回 null。供实时与重新识别两条路径共用。 */
export function buildHotwordInjectionPart(hotwords: string[] | undefined): string | null {
  if (!hotwords || hotwords.length === 0) return null
  const terms = Array.from(new Set(hotwords.map((w) => w.trim()).filter(Boolean)))
  if (terms.length === 0) return null
  return `用户术语表：以下是用户常用的专有名词/术语，整理时若遇到读音相近或明显误识的词，请优先纠正为下列正确写法（保持其大小写），并原样保留：\n${terms.join('、')}`
}

export function resolvePromptRouting(input: PromptRoutingInput): PromptResolution {
  const matchedRule = [...input.appRules]
    .filter((rule) => rule.enabled)
    .sort((left, right) => right.priority - left.priority)
    .find((rule) => matchesAppPromptRule(rule, input.appContext))

  const preset = pickPreset(matchedRule?.presetId, input.presets, input.activePresetId)
  const systemPromptParts = [preset.systemPrompt.trim()]
  const dominantScene = summarizeDomainScenes(input.userStats, 1)[0]

  if (matchedRule?.promptAppend) {
    systemPromptParts.push(`应用场景补充：\n${matchedRule.promptAppend.trim()}`)
  }

  const dynamicIdentityPrompt = buildDynamicIdentityPrompt(input.userStats)
  if (dynamicIdentityPrompt) {
    systemPromptParts.push(`用户画像补充：\n${dynamicIdentityPrompt}`)
  }

  // 可选：把热词表注入系统提示词，帮助 AI 在整理时纠正/保留专有名词（默认关闭）。
  let hotwordInjected = false
  if (input.injectHotwords) {
    const part = buildHotwordInjectionPart(input.hotwords)
    if (part) {
      systemPromptParts.push(part)
      hotwordInjected = true
    }
  }

  const summaryParts = [
    `基础预设: ${preset.name}`,
    matchedRule ? `应用规则: ${matchedRule.name}` : '应用规则: 未命中',
    dynamicIdentityPrompt && dominantScene ? `用户画像: ${dominantScene.label}` : '',
    hotwordInjected ? '热词注入: 开' : '',
  ]

  return {
    appId: matchedRule?.appId,
    appName: matchedRule?.name,
    preset,
    matchedRule,
    systemPrompt: systemPromptParts.join('\n\n'),
    summary: summarizeResolution(summaryParts),
  }
}
