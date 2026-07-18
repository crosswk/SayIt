// 云 API 模式 Provider
// 豆包 ASR：边录边发（实时流式）
// 其他 ASR：录完再发（BufferedProvider）

import { isQwenOmniProvider, isStreamingDisplayReady, resolveQwenOmniModel } from '@/lib/asrModels'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getSetting } from '../store'
import { restoreHotwordSpacing } from '../textPostProcess'
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

  // 流式实时显示：本次会话是否开启，以及中间结果事件的取消监听函数
  private streamingDisplay = false
  private partialUnlisten: (() => void) | null = null

  // 流式发送串行化：所有音频包经此链路顺序发送，保证收尾负包一定排在最后，
  // 避免「音频包在负包之后到达」导致服务端报 last packet has been received already。
  private sendLock: Promise<void> = Promise.resolve()
  private streamFinishing = false

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
    this.streamingDisplay = Boolean(opts?.streamingDisplay)
    this.streamFinishing = false
    this.sendLock = Promise.resolve()

    // 异步判断供应商并建连
    void this.tryStartRealtimeStream()

    return true
  }

  /** 订阅 Rust 上抛的流式中间识别结果，实时转发给上层用于悬浮窗上屏 */
  private async subscribePartials(): Promise<void> {
    if (this.partialUnlisten) return
    let partialCount = 0
    this.partialUnlisten = await listen<{ text?: string }>('asr-partial', (event) => {
      if (!this.sessionActive && this.pcmBuffers.length === 0) return
      const text = event.payload?.text ?? ''
      partialCount++
      // 只记录第一条，避免刷屏；证明前端确实收到了 Rust 上抛的中间结果
      if (partialCount === 1) {
        addRuntimeEvent('info', 'cloud_api', '收到首个流式中间结果', { textLen: text.length })
      }
      this.callbacks.onPartialASR?.(text)
    })
    addRuntimeEvent('info', 'cloud_api', '已订阅 asr-partial 事件')
  }

  private teardownPartials(): void {
    if (this.partialUnlisten) {
      this.partialUnlisten()
      this.partialUnlisten = null
    }
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (!this.sessionActive) return

    // 始终缓存一份（用于非豆包场景 + 音频保存）
    this.pcmBuffers.push(buffer.slice(0))

    // 豆包/千问流式：攒到 pendingChunks，由定时器批量发送。
    // 收尾阶段不再接收新音频，确保负包之后不会再有音频包。
    if ((this.isDoubaoStream || this.isQwenStream) && !this.streamFinishing) {
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
    this.teardownPartials()
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
      const qwenWorkspaceId = await getSetting('cloudAsr.qwen.workspaceId', '') as string

      // 是否为本次会话开启「流式实时显示」：直接读设置（单一真源，避免录音器缓存过期），
      // 结合 startOpts 兜底，并要求当前供应商在当前配置下真正就绪（qwen 需 WorkspaceId）。
      const settingOn = Boolean(await getSetting('streamingDisplayEnabled', false))
      const realtime = (settingOn || Boolean(this.streamingDisplay)) && isStreamingDisplayReady(asrProvider, qwenWorkspaceId)
      addRuntimeEvent('info', 'cloud_api', '流式实时显示判定', { asrProvider, settingOn, startOpt: Boolean(this.streamingDisplay), hasWorkspace: Boolean(qwenWorkspaceId), realtime })
      if (realtime) {
        // 先订阅中间结果，避免建连后、订阅前丢帧
        await this.subscribePartials()
      }

      if (asrProvider === 'doubao_v2') {
        // 豆包流式
        this.isDoubaoStream = true
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const asrAppId = await getSetting('cloudAsr.appId', '') as string

        addRuntimeEvent('info', 'cloud_api', '豆包流式：建立连接', { realtime })
        await invoke('doubao_stream_open', {
          config: { provider: 'doubao_v2', api_key: asrApiKey, app_id: asrAppId },
          sampleRate: 16000,
          hotwords: this.startOpts?.hotwords ?? [],
          realtime,
        })
        this.doubaoStreamReady = true
        addRuntimeEvent('info', 'cloud_api', '豆包流式：连接就绪')
      } else if (asrProvider === 'qwen_realtime' && realtime) {
        // 千问实时（qwen3-asr-flash-realtime）：仅在开启实时显示且配置了 WorkspaceId 时才走流式 WebSocket。
        // qwen3-asr-flash（非实时）与未配置/未开启时都不进此分支，走下面的一次性识别。
        this.isQwenStream = true
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string

        addRuntimeEvent('info', 'cloud_api', '千问实时：建立连接', { hasWorkspace: Boolean(qwenWorkspaceId) })
        await invoke('qwen_stream_open', {
          config: { provider: 'qwen', api_key: asrApiKey, app_id: '' },
          hotwords: this.startOpts?.hotwords ?? [],
          realtime,
          workspaceId: qwenWorkspaceId,
        })
        this.qwenStreamReady = true
        addRuntimeEvent('info', 'cloud_api', '千问实时：连接就绪')
      } else {
        // 其他情况（含未配置 WorkspaceId 的千问）走录完再发的一次性识别
        this.teardownPartials()
        return
      }

      // 补发建连期间已缓存的音频
      await this.flushPendingChunks()

      // 启动定时器，每 200ms 批量发送一次（收尾阶段不再触发新发送）
      this.flushTimer = setInterval(() => {
        if (this.streamFinishing) return
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
      this.teardownPartials()
    }
  }

  /** 把一次批量发送排入串行链路，返回可 await 的 Promise。
   *  链式串行保证多次 flush、以及收尾前的最终 flush 都严格按顺序送达 Rust，
   *  绝不会出现音频包穿插到负包之后。 */
  private flushPendingChunks(): Promise<void> {
    const run = async () => {
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
    // 接到发送链尾部，串行执行（无论前一个成功或失败都继续）
    this.sendLock = this.sendLock.then(run, run)
    return this.sendLock
  }

  // ── 处理逻辑 ──

  private async runProcess(): Promise<void> {
    const stopTime = performance.now() // stop 时刻，用于计算流式模式的等待时间
    const startTime = this.streamStartTime || stopTime

    try {
      const totalBytes = this.pcmBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
      if (totalBytes === 0) {
        this.teardownPartials()
        this.callbacks.onDone?.()
        return
      }

      const durationSec = (totalBytes / 2) / 16000
      if (durationSec < 0.3) {
        addRuntimeEvent('info', 'cloud_api', '音频过短，跳过处理', { durationSec })
        if (this.isDoubaoStream) invoke('doubao_stream_close').catch(() => {})
        if (this.isQwenStream) invoke('qwen_stream_close').catch(() => {})
        this.teardownPartials()
        this.callbacks.onDone?.()
        return
      }

      // 读取 ASR 配置
      const asrProvider = await getSetting('cloudAsr.provider', 'doubao') as string
      const isQwenOmni = isQwenOmniProvider(asrProvider)

      let asrText = ''
      let asrMs = 0

      if ((this.isDoubaoStream && this.doubaoStreamReady) || (this.isQwenStream && this.qwenStreamReady)) {
        // 流式收尾：先置收尾标志（阻止新音频入队/定时器再发），停定时器，
        // flush 剩余数据并等发送链彻底排空，最后再发负包——保证负包是最后一个包。
        this.streamFinishing = true
        if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
        await this.flushPendingChunks()
        await this.sendLock

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
          request: {
            audio_b64: audioB64,
            sample_rate: 16000,
            asr_config: asrConfig,
            hotwords: this.startOpts?.hotwords ?? [],
          },
        })
        asrText = asrResult.text
        asrMs = asrResult.elapsed_ms
      }

      this.pcmBuffers = []
      // ASR 已拿到最终文本，后续不再有中间结果，撤下监听
      this.teardownPartials()

      // 还原被 ASR 拆开加空格的无空格热词（如豆包把 "SayIt" 识别成 "Say It"）
      asrText = restoreHotwordSpacing(asrText, this.startOpts?.hotwords ?? [])

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
      this.teardownPartials()
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
    }
  }
}
