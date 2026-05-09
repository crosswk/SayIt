// 云 API 模式 Provider
// 豆包 ASR：边录边发（实时流式）
// 其他 ASR：录完再发（BufferedProvider）

import { isQwenOmniProvider, resolveQwenOmniModel } from '@/lib/asrModels'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import type {
  TranscriptionProvider,
  TranscriptionCallbacks,
  StartOptions,
  StopOptions,
  WorkMode,
} from './types'

interface AiProviderConfig {
  provider: string
  api_url: string
  api_key: string
  model: string
  extra?: Record<string, unknown>
}

interface AsrProviderConfig {
  provider: string
  api_key: string
  app_id: string
  extra?: Record<string, unknown>
}

interface AsrResult { text: string; elapsed_ms: number }
interface AiResult { text: string; elapsed_ms: number }

export class CloudAPIProvider implements TranscriptionProvider {
  readonly mode: WorkMode = 'cloud_api'

  private callbacks: TranscriptionCallbacks = {}
  private pcmBuffers: ArrayBuffer[] = []
  private sessionActive = false
  private startOpts: StartOptions | undefined
  private ready = false

  // 豆包/千问流式状态
  private isDoubaoStream = false
  private isQwenStream = false
  private doubaoStreamReady = false
  private qwenStreamReady = false
  private streamStartTime = 0
  private pendingChunks: ArrayBuffer[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  async connect(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    this.ready = true
    callbacks.onStateChange?.('connected')
    callbacks.onReady?.({ asr: true, llm: true })
  }

  start(opts?: StartOptions): boolean {
    if (!this.ready) {
      addRuntimeEvent('error', 'cloud_api', 'start 失败：Provider 未就绪')
      return false
    }
    this.pcmBuffers = []
    this.sessionActive = true
    this.startOpts = opts
    this.isDoubaoStream = false
    this.isQwenStream = false
    this.doubaoStreamReady = false
    this.qwenStreamReady = false
    this.streamStartTime = performance.now()
    this.pendingChunks = []

    // 异步判断供应商并建连
    void this.tryStartRealtimeStream()

    return true
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (!this.sessionActive) return

    // 始终缓存一份（用于非豆包场景 + 音频保存）
    this.pcmBuffers.push(buffer.slice(0))

    // 豆包/千问流式：攒到 pendingChunks，由定时器批量发送
    if (this.isDoubaoStream || this.isQwenStream) {
      this.pendingChunks.push(buffer.slice(0))
    }
  }

  stop(_opts?: StopOptions): boolean {
    if (!this.sessionActive) return false
    this.sessionActive = false
    void this.runProcess()
    return true
  }

  disconnect(): void {
    this.sessionActive = false
    this.pcmBuffers = []
    this.pendingChunks = []
    this.ready = false
    this.isDoubaoStream = false
    this.isQwenStream = false
    this.doubaoStreamReady = false
    this.qwenStreamReady = false
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    invoke('doubao_stream_close').catch(() => {})
    invoke('qwen_stream_close').catch(() => {})
    this.callbacks.onStateChange?.('disconnected')
  }

  isReady(): boolean {
    return this.ready
  }


  // ── 豆包流式建连 ──

  private async tryStartRealtimeStream(): Promise<void> {
    try {
      const asrProvider = await getSetting('cloudAsr.provider', 'doubao') as string

      if (asrProvider === 'doubao_v2') {
        // 豆包流式
        this.isDoubaoStream = true
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const asrAppId = await getSetting('cloudAsr.appId', '') as string

        addRuntimeEvent('info', 'cloud_api', '豆包流式：建立连接')
        await invoke('doubao_stream_open', {
          config: { provider: 'doubao_v2', api_key: asrApiKey, app_id: asrAppId },
          sampleRate: 16000,
        })
        this.doubaoStreamReady = true
        addRuntimeEvent('info', 'cloud_api', '豆包流式：连接就绪')
      } else if (asrProvider === 'qwen' || asrProvider === 'qwen_realtime') {
        // 千问流式
        this.isQwenStream = true
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string

        addRuntimeEvent('info', 'cloud_api', '千问流式：建立连接')
        await invoke('qwen_stream_open', {
          config: { provider: 'qwen', api_key: asrApiKey, app_id: '' },
        })
        this.qwenStreamReady = true
        addRuntimeEvent('info', 'cloud_api', '千问流式：连接就绪')
      } else {
        // 其他供应商不走流式
        return
      }

      // 补发建连期间已缓存的音频
      await this.flushPendingChunks()

      // 启动定时器，每 200ms 批量发送一次
      this.flushTimer = setInterval(() => {
        const ready = this.doubaoStreamReady || this.qwenStreamReady
        if (ready && this.pendingChunks.length > 0) {
          void this.flushPendingChunks()
        }
      }, 200)
    } catch (err) {
      addRuntimeEvent('warn', 'cloud_api', '流式建连失败，回退到录完再发', { error: String(err) })
      this.isDoubaoStream = false
      this.isQwenStream = false
      this.doubaoStreamReady = false
      this.qwenStreamReady = false
    }
  }

  private async flushPendingChunks(): Promise<void> {
    if (this.pendingChunks.length === 0) return

    const chunks = this.pendingChunks
    this.pendingChunks = []

    const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0)
    const merged = new Uint8Array(totalLen)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }

    const b64 = uint8ArrayToBase64(merged)
    try {
      if (this.isDoubaoStream) {
        await invoke('doubao_stream_send', { pcmB64: b64 })
      } else if (this.isQwenStream) {
        await invoke('qwen_stream_send', { pcmB64: b64 })
      }
    } catch (err) {
      addRuntimeEvent('warn', 'cloud_api', '流式发送失败', { error: String(err) })
    }
  }

  // ── 处理逻辑 ──

  private async runProcess(): Promise<void> {
    const stopTime = performance.now() // stop 时刻，用于计算流式模式的等待时间
    const startTime = this.streamStartTime || stopTime

    try {
      const totalBytes = this.pcmBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
      if (totalBytes === 0) {
        this.callbacks.onDone?.()
        return
      }

      const durationSec = (totalBytes / 2) / 16000
      if (durationSec < 0.3) {
        addRuntimeEvent('info', 'cloud_api', '音频过短，跳过处理', { durationSec })
        if (this.isDoubaoStream) invoke('doubao_stream_close').catch(() => {})
        if (this.isQwenStream) invoke('qwen_stream_close').catch(() => {})
        this.callbacks.onDone?.()
        return
      }

      // 读取 ASR 配置
      const asrProvider = await getSetting('cloudAsr.provider', 'doubao') as string
      const isQwenOmni = isQwenOmniProvider(asrProvider)

      let asrText = ''
      let asrMs = 0

      if ((this.isDoubaoStream && this.doubaoStreamReady) || (this.isQwenStream && this.qwenStreamReady)) {
        // 流式：停止定时器，flush 剩余数据，发送最后一包
        if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
        await this.flushPendingChunks()

        if (this.isDoubaoStream) {
          addRuntimeEvent('info', 'cloud_api', '豆包流式：发送 finish')
          const finishStart = performance.now()
          const text = await invoke<string>('doubao_stream_finish')
          asrText = text
          asrMs = Math.round(performance.now() - finishStart)
          addRuntimeEvent('info', 'cloud_api', '豆包流式：识别完成', { asrMs, textLen: asrText.length })
        } else {
          addRuntimeEvent('info', 'cloud_api', '千问流式：发送 finish')
          const finishStart = performance.now()
          const text = await invoke<string>('qwen_stream_finish')
          asrText = text
          asrMs = Math.round(performance.now() - finishStart)
          addRuntimeEvent('info', 'cloud_api', '千问流式：识别完成', { asrMs, textLen: asrText.length })
        }
      } else {
        // 非豆包 / 豆包建连失败：录完再发
        const merged = new Uint8Array(totalBytes)
        let offset = 0
        for (const buf of this.pcmBuffers) {
          merged.set(new Uint8Array(buf), offset)
          offset += buf.byteLength
        }
        const audioB64 = uint8ArrayToBase64(merged)

        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const asrAppId = await getSetting('cloudAsr.appId', '') as string
        const qwenOmniModel = resolveQwenOmniModel(asrProvider)

        let omniInstructions: string | undefined
        if (isQwenOmni) {
          const savedPrompt = await getSetting('cloudAsr.omniSystemPrompt', '') as string
          omniInstructions = savedPrompt || undefined
        }

        const asrConfig: AsrProviderConfig = {
          provider: isQwenOmni ? 'qwen_omni' : asrProvider,
          api_key: asrApiKey,
          app_id: asrAppId,
          ...(isQwenOmni && {
            extra: { model: qwenOmniModel, instructions: omniInstructions },
          }),
        }

        addRuntimeEvent('info', 'cloud_api', '开始 ASR', { provider: asrProvider, durationSec })
        const asrResult = await invoke<AsrResult>('cloud_transcribe', {
          request: { audio_b64: audioB64, sample_rate: 16000, asr_config: asrConfig },
        })
        asrText = asrResult.text
        asrMs = asrResult.elapsed_ms
      }

      this.pcmBuffers = []

      // 发送 ASR 中间结果
      this.callbacks.onASR?.({ text: asrText, asrMs, durationSec })

      if (!asrText.trim()) {
        this.callbacks.onFinal?.({ asrText: '', llmText: '', asrMs, llmMs: 0, durationSec })
        this.callbacks.onDone?.()
        return
      }

      // AI 校对（Qwen Omni 已内置 AI，跳过）
      let llmText = asrText
      let llmMs = 0

      const disableAi = this.startOpts?.disableAi ?? false
      if (!disableAi && !isQwenOmni) {
        const aiProvider = await getSetting('cloudAi.provider', 'openai_compat') as string
        const aiApiUrl = await getSetting('cloudAi.apiUrl', '') as string
        const aiApiKey = await getSetting('cloudAi.apiKey', '') as string
        const aiModel = await getSetting('cloudAi.model', '') as string

        if (aiApiUrl && aiApiKey && aiModel) {
          const aiConfig: AiProviderConfig = {
            provider: aiProvider, api_url: aiApiUrl, api_key: aiApiKey, model: aiModel,
          }
          addRuntimeEvent('info', 'cloud_api', '开始 AI 校对', { provider: aiProvider, model: aiModel })

          try {
            const aiResult = await invoke<AiResult>('cloud_polish', {
              request: { text: asrText, ai_config: aiConfig, system_prompt: this.startOpts?.systemPrompt || null },
            })
            llmText = aiResult.text || asrText
            llmMs = aiResult.elapsed_ms
          } catch (err) {
            addRuntimeEvent('warn', 'cloud_api', 'AI 校对失败，使用 ASR 原文', { error: String(err) })
          }
        }
      }

      const totalMs = Math.round(performance.now() - startTime)
      addRuntimeEvent('info', 'cloud_api', '处理完成', { durationSec, asrMs, llmMs, totalMs })

      const omniModel = isQwenOmni ? resolveQwenOmniModel(asrProvider) : undefined

      this.callbacks.onFinal?.({
        asrText, llmText, asrMs, llmMs, durationSec,
        ...(isQwenOmni && { asrEngine: 'qwen_omni', asrModel: omniModel }),
      })
      this.callbacks.onDone?.()
    } catch (err) {
      addRuntimeEvent('error', 'cloud_api', '处理异常', { error: String(err) })
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
    }
  }
}
