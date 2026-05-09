// 反馈意见服务 — 发送用户反馈到后端

import { getBackendBaseUrl } from './runtimeConfig'
import { getClientRuntimeInfo } from './bridge'
import { getSetting, getActivePreset, listHistory, type HistoryRecord } from './store'
import { getWorkMode } from './transcription'

export interface FeedbackPayload {
  machine_id: string
  app_version: string
  timestamp: string
  feedback_text: string
  transcript: {
    asr_text: string
    ai_text: string
    duration_sec: number
  } | null
  context: {
    work_mode: string
    asr_provider: string
    asr_model: string
    ai_enabled: boolean
    ai_provider: string
    ai_model: string
    ai_preset_name: string
    ai_system_prompt: string
    ai_prompt_append: string
  }
}

export interface FeedbackResult {
  ok: boolean
  message: string
}

/** 获取最后一条转录记录 */
export async function getLastTranscript(): Promise<HistoryRecord | null> {
  const records = await listHistory({ limit: 1, offset: 0 })
  return records.length > 0 ? records[0] : null
}

/** 收集当前配置上下文 */
async function collectContext(): Promise<FeedbackPayload['context']> {
  const workMode = getWorkMode()
  const aiEnabled = await getSetting('aiEnabled', false) as boolean
  const aiProvider = await getSetting('cloudAi.provider', '') as string
  const aiModel = await getSetting(`cloudAi.${aiProvider}.model`, '') as string
  const activePreset = await getActivePreset()
  const aiPromptAppend = await getSetting('aiPromptAppend', '') as string

  // ASR 信息
  let asrProvider = ''
  let asrModel = ''
  if (workMode === 'cloud_api') {
    asrProvider = await getSetting('cloudAsr.provider', '') as string
    asrModel = await getSetting(`cloudAsr.${asrProvider}.model`, '') as string
  } else if (workMode === 'local') {
    asrProvider = 'local'
    asrModel = await getSetting('localAsr.model', '') as string
  } else {
    asrProvider = 'server'
    asrModel = ''
  }

  return {
    work_mode: workMode,
    asr_provider: asrProvider,
    asr_model: asrModel,
    ai_enabled: aiEnabled,
    ai_provider: aiProvider,
    ai_model: aiModel,
    ai_preset_name: activePreset.name,
    ai_system_prompt: activePreset.systemPrompt.slice(0, 5000),
    ai_prompt_append: (aiPromptAppend || '').slice(0, 5000),
  }
}

/** 发送反馈到后端 */
export async function submitFeedback(feedbackText: string, options?: { includeTranscript?: boolean }): Promise<FeedbackResult> {
  const includeTranscript = options?.includeTranscript ?? true

  // 校验
  const trimmed = feedbackText.trim()
  if (trimmed.length < 2) {
    return { ok: false, message: '反馈内容至少需要 2 个字' }
  }
  if (trimmed.length > 1000) {
    return { ok: false, message: '反馈内容不能超过 1000 字' }
  }

  // 收集信息
  const clientInfo = await getClientRuntimeInfo()
  const lastRecord = includeTranscript ? await getLastTranscript() : null
  const context = await collectContext()

  const payload: FeedbackPayload = {
    machine_id: clientInfo.deviceId,
    app_version: clientInfo.clientVersion,
    timestamp: new Date().toISOString(),
    feedback_text: trimmed,
    transcript: lastRecord
      ? {
          asr_text: (lastRecord.asrText || '').slice(0, 5000),
          ai_text: (lastRecord.llmText || '').slice(0, 5000),
          duration_sec: lastRecord.durationSec || 0,
        }
      : null,
    context,
  }

  // 发送
  const baseUrl = getBackendBaseUrl()
  const res = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (res.status === 429) {
    return { ok: false, message: '发送太频繁，请稍后再试' }
  }

  if (!res.ok) {
    return { ok: false, message: `发送失败 (${res.status})` }
  }

  return { ok: true, message: '发送成功，感谢您的反馈。' }
}
