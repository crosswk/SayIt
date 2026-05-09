// 本地模式 Provider
// 音频在本地积攒，stop 时调用 Rust 侧本地 ASR 推理
// ASR 完成后可选调用云端 AI 校对

import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import { BufferedProvider } from './BufferedProvider'
import type { TranscriptionCallbacks } from './types'

interface AiResult { text: string; elapsed_ms: number }

export class LocalProvider extends BufferedProvider {
  readonly mode = 'local' as const

  protected async onConnect(callbacks: TranscriptionCallbacks): Promise<void> {
    // 预加载本地模型
    try {
      const modelId = await getSetting('localAsr.modelId', 'sensevoice-small') as string
      if (modelId) {
        await invoke<string>('preload_local_model', { modelId })
      }
      callbacks.onReady?.({ asr: true, llm: false })
    } catch {
      callbacks.onReady?.({ asr: true, llm: false })
    }
  }

  protected async processAudio(audioB64: string, durationSec: number): Promise<void> {
    const startTime = performance.now()

    // 调用本地 ASR
    addRuntimeEvent('info', 'local', '开始本地 ASR', { durationSec })
    let asrText = ''
    let asrMs = 0

    try {
      const result = await invoke<{ text: string; elapsed_ms: number }>('local_transcribe', {
        audioB64,
        modelId: await getSetting('localAsr.modelId', 'sensevoice-small'),
        language: await getSetting('localAsr.language', 'auto'),
      })
      asrText = result.text
      asrMs = result.elapsed_ms
    } catch (err) {
      addRuntimeEvent('error', 'local', '本地 ASR 失败', { error: String(err) })
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
      return
    }

    this.callbacks.onASR?.({ text: asrText, asrMs, durationSec })

    if (!asrText.trim()) {
      this.callbacks.onFinal?.({ asrText: '', llmText: '', asrMs, llmMs: 0, durationSec })
      this.callbacks.onDone?.()
      return
    }

    // 可选 AI 校对
    let llmText = asrText
    let llmMs = 0

    const aiEnabled = await getSetting('aiEnabled', false)
    const disableAi = this.startOpts?.disableAi ?? false

    if (aiEnabled && !disableAi) {
      const aiProvider = await getSetting('cloudAi.provider', 'openai_compat') as string
      const aiApiUrl = await getSetting('cloudAi.apiUrl', '') as string
      const aiApiKey = await getSetting('cloudAi.apiKey', '') as string
      const aiModel = await getSetting('cloudAi.model', '') as string

      if (aiApiUrl && (aiApiKey || aiProvider === 'ollama')) {
        try {
          const aiResult = await invoke<AiResult>('cloud_polish', {
            request: {
              text: asrText,
              ai_config: { provider: aiProvider, api_url: aiApiUrl, api_key: aiApiKey, model: aiModel },
              system_prompt: this.startOpts?.systemPrompt || null,
            },
          })
          llmText = aiResult.text || asrText
          llmMs = aiResult.elapsed_ms
        } catch (err) {
          addRuntimeEvent('warn', 'local', 'AI 校对失败，使用 ASR 原文', { error: String(err) })
        }
      }
    }

    const totalMs = Math.round(performance.now() - startTime)
    addRuntimeEvent('info', 'local', '处理完成', { durationSec, asrMs, llmMs, totalMs })

    this.callbacks.onFinal?.({ asrText, llmText, asrMs, llmMs, durationSec })
    this.callbacks.onDone?.()
  }
}
