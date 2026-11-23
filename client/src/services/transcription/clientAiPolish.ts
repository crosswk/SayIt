import { invoke } from '@tauri-apps/api/core'
import { addRuntimeEvent, AI_EVENT_REQUEST, AI_LOG_SOURCE } from '../debugLog'
import { getSetting } from '../store'
import type { ClientAiConfig } from './selectionAi'
import {
  resolveAndLogAiOutcome,
  type AiEvidence,
  type AiOutcomeContext,
  type AiPolicy,
} from './aiPolicy'
import type { AiExecutionSource, AiExecutionStatus, StartOptions } from './types'

interface AiResult {
  text: string
  elapsed_ms: number
}

const CLIENT_AI_TIMEOUT_MS = 8_000

export interface ClientAiPolishResult {
  llmText: string
  llmMs: number
  contextApplied?: boolean
  aiSource: AiExecutionSource
  aiStatus: AiExecutionStatus
  aiProvider?: string
  aiModel?: string
  /** 跳过 / 失败的稳定原因码，供日志与历史共用。成功时为 undefined。 */
  aiReason?: string
  /** 是否真的向 AI 发出过调用。用来交叉验证「跳过确实没调用」。 */
  aiAttempted: boolean
}

interface ClientAiPolishOptions {
  asrText: string
  startOptions?: Readonly<StartOptions>
  /**
   * 本次策略。**必须由调用方算好传进来**，不在这里重算：
   * 时长门槛、总开关、路由此前在五处各判一遍，结论已经漂移过。
   */
  policy: AiPolicy
  /** 落 ai.outcome 用；同一个 operationId 只会写出一条。 */
  outcomeContext: AiOutcomeContext
  logSource: string
  /** 异步读设置和原生请求结束后都要验代；false 表示结果已经属于旧录音。 */
  isCurrent?: () => boolean
}

async function loadClientAiConfig(): Promise<ClientAiConfig> {
  const [provider, apiUrl, apiKey, model] = await Promise.all([
    getSetting('cloudAi.provider', 'openai_compat') as Promise<string>,
    getSetting('cloudAi.apiUrl', '') as Promise<string>,
    getSetting('cloudAi.apiKey', '') as Promise<string>,
    getSetting('cloudAi.model', '') as Promise<string>,
  ])
  return { provider, apiUrl, apiKey, model }
}

/**
 * 档案是否可用。ollama 免密是唯一豁免。
 *
 * 这条判据此前有三份：这里、History 的云 API 重跑（漏了 ollama 豁免，于是 ollama
 * 用户重跑时被静默判成配置不完整）、History 的本地重跑。收口成一处。
 */
export function isClientAiConfigComplete(config: ClientAiConfig): boolean {
  return Boolean(
    config.apiUrl.trim()
    && config.model.trim()
    && (config.apiKey.trim() || config.provider === 'ollama'),
  )
}

function safeFallbackText(asrText: string, startOptions?: Readonly<StartOptions>): string {
  // 选区编辑依赖 AI 理解口述命令。AI 没有真正完成时，回填原选区才是安全 no-op；
  // 直接回填 ASR 会把“改成更正式”这种命令本身覆盖进正文。
  return startOptions?.textContext?.selectedText || asrText
}

function toResult(
  policy: AiPolicy,
  evidence: AiEvidence,
  options: ClientAiPolishOptions,
  llmText?: string,
): ClientAiPolishResult {
  const outcome = resolveAndLogAiOutcome(options.outcomeContext, policy, evidence)
  const applied = outcome.status === 'applied'
  return {
    llmText: applied && llmText ? llmText : safeFallbackText(options.asrText, options.startOptions),
    llmMs: outcome.llmMs,
    contextApplied: options.startOptions?.textContext ? applied : undefined,
    aiSource: outcome.source,
    aiStatus: outcome.status,
    aiProvider: outcome.provider,
    aiModel: outcome.model,
    aiReason: outcome.reason,
    aiAttempted: outcome.attempted,
  }
}

/**
 * 使用当前启用的客户端 AI 档案整理一段 ASR 文本。
 *
 * 服务器（自配来源）、云 API、本地三种识别来源共用这一处，避免 Ollama 免密、
 * 短语音门槛、选区编辑回退在三条链路里逐渐漂移。返回 null 表示录音代次已经失效。
 *
 * 本函数只负责「执行 + 收集证据」，不自己判策略 —— 是否该调用由 policy 决定。
 * 结果里带齐 status/reason/attempted，调用方不要再靠耗时或文本相等反推。
 */
export async function polishWithClientAi(
  options: ClientAiPolishOptions,
): Promise<ClientAiPolishResult | null> {
  const { asrText, startOptions, policy, logSource } = options
  const isCurrent = options.isCurrent ?? (() => true)

  if (!asrText.trim()) {
    return toResult(policy, { asrTextEmpty: true }, options)
  }

  // 策略不允许调用（总开关关闭 / 低于门槛 / 引擎自带整理）。这里原来是静默 return，
  // 于是"AI 没生效"在日志里一个字都没有 —— 本轮要修的正是它。原因由 policy 给出，
  // 调用方只负责落日志，不在这里重新解释。
  if (!policy.allowCall) {
    return toResult(policy, {}, options)
  }

  const config = startOptions?.selectionAiConfig ?? await loadClientAiConfig()
  if (!isCurrent()) return null

  if (!isClientAiConfigComplete(config)) {
    return toResult(policy, {
      configComplete: false,
      provider: config.provider || undefined,
      model: config.model || undefined,
    }, options)
  }

  addRuntimeEvent('info', AI_LOG_SOURCE, AI_EVENT_REQUEST, {
    logSource,
    route: policy.route,
    provider: config.provider,
    model: config.model,
    // 只记长度，不记正文（与 providers/diag.rs 的口径一致）
    asrChars: asrText.length,
  })

  const timeoutMs = startOptions?.aiTimeoutMs && startOptions.aiTimeoutMs > 0
    ? startOptions.aiTimeoutMs
    : CLIENT_AI_TIMEOUT_MS
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const request = invoke<AiResult>('cloud_polish', {
      request: {
        text: asrText,
        ai_config: {
          provider: config.provider,
          api_url: config.apiUrl,
          api_key: config.apiKey,
          model: config.model,
        },
        system_prompt: startOptions?.systemPrompt || null,
        text_context: startOptions?.textContext || null,
      },
    })
    const result = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Custom AI timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
    if (!isCurrent()) return null

    const evidence: AiEvidence = {
      llmMs: result.elapsed_ms,
      provider: config.provider,
      model: config.model,
      ...(result.text ? {} : { clientOutputEmpty: true }),
    }
    return toResult(policy, evidence, options, result.text)
  } catch (error) {
    if (!isCurrent()) return null
    const message = String(error)
    // 超时和调用失败要分开：前者多半是模型慢或网络，后者常常是密钥/地址/模型名。
    // 合成一个原因会让这两类问题在日志里长得一样。
    const isTimeout = message.includes('timed out')
    // 原因码进 ai.outcome，**错误原文只在这条 warn 里**（warn 无条件落盘）。
    // 不把它塞进结果对象：那个对象会流向历史记录，错误文本可能回显请求内容。
    addRuntimeEvent('warn', logSource, 'Custom AI cleanup failed; using raw ASR text', {
      error: message,
      provider: config.provider,
      model: config.model,
    })
    return toResult(policy, {
      clientFailure: isTimeout ? 'timeout' : 'error',
      provider: config.provider,
      model: config.model,
    }, options)
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
