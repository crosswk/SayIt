// 云 API 模式 Provider
//
// 两条路，按供应商分：
//   · 有流式实现的（见下面 STREAM_COMMANDS）→ 边录边发 WebSocket，可出实时字幕；
//   · 其余 → 录完再发一次 HTTP（cloud_transcribe）。
// 流式建连失败会自动回落到后者 —— 音频始终在 pcmBuffers 里留着完整一份。

import { buildAsrExtra, isQwenOmniProvider, isStreamingDisplayReady, resolveQwenOmniModel } from '@/lib/asrModels'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getSetting } from '../store'
import { restoreHotwordSpacing } from '../textPostProcess'
import { addRuntimeEvent } from '../debugLog'
import { cloudTranscribeRaw, notifyAsrCapabilityMaybeChanged } from '../bridge'
import { polishWithClientAi } from './clientAiPolish'
import { policyFromSnapshot, resolveAndLogAiOutcome, type AiOutcomeContext } from './aiPolicy'
import type {
  TranscriptionProvider,
  TranscriptionCallbacks,
  StartOptions,
  StopOptions,
  WorkMode,
} from './types'

interface AsrProviderConfig {
  provider: string
  api_key: string
  app_id: string
  extra?: Record<string, unknown>
}

interface AsrResult { text: string; elapsed_ms: number }

/**
 * 一个流式 ASR 供应商需要的全部前端信息。
 *
 * 每个字段都对应一处真实差异，不是可配置项 —— 各家 open 的 Rust 签名收的参数不同，
 * 传多了或少了都会让 open 失败，而失败的症状是**静默退回「录完再发」**，
 * 不报错、只是字幕永远不出来。
 */
interface StreamCommandSet {
  open: string
  send: string
  finish: string
  close: string
  /**
   * 关掉实时字幕时还走不走流式。
   *
   * 只有豆包是 true：它的流式协议同时也是它唯一的识别通道，realtime 只决定要不要
   * 把中间结果 emit 上来。其余几家关掉字幕就走「录完再发」的一次性路径，
   * 省一条长连接。这个不对称是有意的，别为了整齐把它抹平。
   */
  streamWithoutRealtime?: boolean
  /** open 要带 sampleRate（只有豆包的 Rust 签名收它，其余把 16000 写死在函数体里） */
  needsSampleRate?: boolean
  /** open 要带 workspaceId（百炼业务空间，只有千问那两个用） */
  needsWorkspaceId?: boolean
  /** open 要带 appId（只有豆包旧版控制台用得上） */
  needsAppId?: boolean
  /** open 要带选定的模型（同一份协议下有多个模型的那几家） */
  needsModel?: boolean
}

/**
 * 每家流式供应商的一组原生命令。**加一家只改这张表。**
 *
 * 它们是各不相同的 WebSocket 协议，不是同一个接口的几个模型名，所以 Rust 侧
 * 各有一份实现：
 *   · doubao_v2               → 火山流式语音识别 2.0（自有二进制分帧协议）
 *   · qwen_realtime           → OpenAI-Realtime 风格（/api-ws/v1/realtime）
 *   · qwen_audio_stream       → DashScope duplex run-task（/api-ws/v1/inference）
 *   · openai_live_transcribe  → OpenAI Realtime 转写会话（/v1/realtime?intent=transcription）
 *   · gemini_live_transcribe  → Gemini Live API（BidiGenerateContent）
 *
 * 这里只记住本次会话用的是哪一组，收尾时才不会去 finish 一条没开的会话。
 *
 * 以前这套是「豆包一条硬编码 if 分支 + 千问一个命令组 + queueNativeClose 里第三份
 * close 清单 + runProcess 里第四处分支」，加一家要改四处。漏掉 close 那处的后果最阴：
 * 取消录音时新供应商的 WebSocket 不会被关，只能靠 Rust 侧下一次 open 的 cleanup 兜底。
 */
const STREAM_COMMANDS: Record<string, StreamCommandSet> = {
  doubao_v2: {
    open: 'doubao_stream_open',
    send: 'doubao_stream_send',
    finish: 'doubao_stream_finish',
    close: 'doubao_stream_close',
    streamWithoutRealtime: true,
    needsSampleRate: true,
    needsAppId: true,
  },
  qwen_realtime: {
    open: 'qwen_stream_open',
    send: 'qwen_stream_send',
    finish: 'qwen_stream_finish',
    close: 'qwen_stream_close',
    needsWorkspaceId: true,
  },
  qwen_audio_stream: {
    open: 'qwen_audio_stream_open',
    send: 'qwen_audio_stream_send',
    finish: 'qwen_audio_stream_finish',
    close: 'qwen_audio_stream_close',
    needsWorkspaceId: true,
  },
  openai_live_transcribe: {
    open: 'openai_live_open',
    send: 'openai_live_send',
    finish: 'openai_live_finish',
    close: 'openai_live_close',
    needsModel: true,
  },
  gemini_live_transcribe: {
    open: 'gemini_live_open',
    send: 'gemini_live_send',
    finish: 'gemini_live_finish',
    close: 'gemini_live_close',
    needsModel: true,
  },
}

/** 所有 close 命令。取消录音时逐个发，没有会话时每个都是无操作。 */
const ALL_STREAM_CLOSE_COMMANDS = Object.values(STREAM_COMMANDS).map((c) => c.close)

function streamCommandsOf(provider: string): StreamCommandSet | undefined {
  return STREAM_COMMANDS[provider]
}

export class CloudAPIProvider implements TranscriptionProvider {
  readonly mode: WorkMode = 'cloud_api'

  private callbacks: TranscriptionCallbacks = {}
  private pcmBuffers: ArrayBuffer[] = []
  private sessionActive = false
  private activeRunId = 0
  private activeStartOpts: Readonly<StartOptions> | undefined
  private ready = false

  /** 本次会话用的流式命令组；没走流式时为 null */
  private streamCommands: StreamCommandSet | null = null
  /** open 成功才置 true。仅 streamCommands 非空不代表连上了 */
  private streamReady = false
  private streamStartTime = 0
  private pendingChunks: ArrayBuffer[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  // 流式实时显示：中间结果事件的取消监听函数
  private partialUnlisten: (() => void) | null = null

  // 流式发送串行化：所有音频包经此链路顺序发送，保证收尾负包一定排在最后，
  // 避免「音频包在负包之后到达」导致服务端报 last packet has been received already。
  private sendLock: Promise<void> = Promise.resolve()
  private streamFinishing = false

  // 原生流生命周期串行化：open / finish / close 共用 Provider 级队列。
  // cancel 会先把 close 排入旧 open 之后；下一代 open 因而只能在旧 close 完成后执行。
  private nativeLifecycleQueue: Promise<void> = Promise.resolve()

  async connect(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    this.ready = true
    callbacks.onStateChange?.('connected')
    callbacks.onReady?.({ asr: true, llm: true })
  }

  start(opts: StartOptions): boolean {
    if (!this.ready) {
      addRuntimeEvent('error', 'cloud_api', 'Start failed: provider is not ready')
      return false
    }

    // 新会话不得复用旧会话的任何逻辑状态；旧 close 会先进入生命周期队列。
    if (this.activeRunId !== 0) this.cancel()

    const runOpts = this.snapshotStartOptions(opts)
    this.pcmBuffers = []
    this.sessionActive = true
    this.activeRunId = runOpts.runId
    this.activeStartOpts = runOpts
    this.streamCommands = null
    this.streamReady = false
    this.streamStartTime = performance.now()
    this.pendingChunks = []
    this.streamFinishing = false
    this.sendLock = Promise.resolve()

    // 异步判断供应商并建连；所有异步步骤只使用本次 run 的 StartOptions 快照。
    void this.tryStartRealtimeStream(runOpts.runId, runOpts)

    return true
  }

  private snapshotStartOptions(opts: StartOptions): Readonly<StartOptions> {
    return {
      ...opts,
      hotwords: opts.hotwords ? [...opts.hotwords] : undefined,
      textContext: opts.textContext ? { ...opts.textContext } : undefined,
    }
  }

  private isRunCurrent(runId: number): boolean {
    return runId !== 0 && this.activeRunId === runId
  }

  private completeRun(runId: number): void {
    if (!this.isRunCurrent(runId)) return

    // 先让本次 run 失效，后续迟到结果一律丢弃；close 在队列中等待旧发送链排空。
    this.activeRunId = 0
    this.activeStartOpts = undefined
    const sendLockToDrain = this.sendLock
    this.sessionActive = false
    this.pcmBuffers = []
    this.pendingChunks = []
    this.streamFinishing = true
    this.streamCommands = null
    this.streamReady = false
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    this.teardownPartials()
    void this.queueNativeClose(sendLockToDrain)
  }

  private enqueueNativeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.nativeLifecycleQueue.then(operation)
    this.nativeLifecycleQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private queueNativeClose(sendLockToDrain: Promise<void>): Promise<void> {
    return this.enqueueNativeLifecycle(async () => {
      await sendLockToDrain.catch(() => { })
      // 逐个关：每个 close 在没有会话时都是无操作，所以不需要先判断开了哪一个。
      // 清单来自 STREAM_COMMANDS，加供应商时不会漏掉这里。
      for (const close of ALL_STREAM_CLOSE_COMMANDS) {
        await invoke(close).catch(() => { })
      }
    })
  }

  private invokeNativeOpen(
    runId: number,
    command: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    return this.enqueueNativeLifecycle(async () => {
      if (!this.isRunCurrent(runId)) return false
      try {
        await invoke(command, args)
      } catch (err) {
        if (!this.isRunCurrent(runId)) return false
        throw err
      }
      if (!this.isRunCurrent(runId)) return false
      return true
    })
  }

  private invokeNativeFinish(
    runId: number,
    command: string,
  ): Promise<string | undefined> {
    return this.enqueueNativeLifecycle(async () => {
      if (!this.isRunCurrent(runId)) return undefined
      try {
        const text = await invoke<string>(command)
        if (!this.isRunCurrent(runId)) return undefined
        return text
      } catch (err) {
        if (!this.isRunCurrent(runId)) return undefined
        throw err
      }
    })
  }

  /** 订阅 Rust 上抛的流式中间识别结果，实时转发给上层用于悬浮窗上屏 */
  private async subscribePartials(runId: number): Promise<void> {
    if (this.partialUnlisten) return
    let partialCount = 0
    const unlisten = await listen<{ text?: string }>('asr-partial', (event) => {
      if (!this.isRunCurrent(runId)) return
      if (!this.sessionActive && this.pcmBuffers.length === 0) return
      const text = event.payload?.text ?? ''
      partialCount++
      // 只记录第一条，避免刷屏；证明前端确实收到了 Rust 上抛的中间结果
      if (partialCount === 1) {
        addRuntimeEvent('info', 'cloud_api', 'First streaming partial received', { textLen: text.length })
      }
      this.callbacks.onPartialASR?.(text)
    })
    if (!this.isRunCurrent(runId) || this.partialUnlisten) {
      unlisten()
      return
    }
    this.partialUnlisten = unlisten
    addRuntimeEvent('info', 'cloud_api', 'Subscribed to asr-partial events')
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

    // 流式：攒到 pendingChunks，由定时器批量发送。
    // 收尾阶段不再接收新音频，确保负包之后不会再有音频包。
    if (this.streamCommands && !this.streamFinishing) {
      this.pendingChunks.push(buffer.slice(0))
    }
  }

  stop(_opts?: StopOptions): boolean {
    if (!this.sessionActive) return false
    const runId = this.activeRunId
    const runOpts = this.activeStartOpts
    if (!runOpts || runOpts.runId !== runId) return false
    this.sessionActive = false
    void this.runProcess(runId, runOpts)
    return true
  }

  cancel(): void {
    // 必须先使 run 失效，再清理前端状态；close 最后入队且等待此刻的旧发送链。
    this.activeRunId = 0
    this.activeStartOpts = undefined
    const sendLockToDrain = this.sendLock
    this.sessionActive = false
    this.pcmBuffers = []
    this.pendingChunks = []
    this.streamFinishing = true
    this.streamCommands = null
    this.streamReady = false
    this.teardownPartials()
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    void this.queueNativeClose(sendLockToDrain)
  }

  disconnect(): void {
    this.cancel()
    this.ready = false
    this.callbacks.onStateChange?.('disconnected')
  }

  isReady(): boolean {
    return this.ready
  }


  // ── 流式建连 ──

  private async tryStartRealtimeStream(
    runId: number,
    startOpts: Readonly<StartOptions>,
  ): Promise<void> {
    try {
      const asrProvider = await getSetting('cloudAsr.provider', 'doubao') as string
      const qwenWorkspaceId = await getSetting('cloudAsr.qwen.workspaceId', '') as string
      if (!this.isRunCurrent(runId)) return

      // 是否为本次会话开启「流式实时显示」：直接读设置（单一真源，避免录音器缓存过期），
      // 结合本次 start 快照兜底，并要求当前供应商在当前配置下真正就绪（qwen 需 WorkspaceId）。
      const settingOn = Boolean(await getSetting('streamingDisplayEnabled', false))
      if (!this.isRunCurrent(runId)) return
      const realtime = (settingOn || Boolean(startOpts.streamingDisplay)) && isStreamingDisplayReady(asrProvider, qwenWorkspaceId)
      addRuntimeEvent('info', 'cloud_api', 'Streaming display decision', { asrProvider, settingOn, startOpt: Boolean(startOpts.streamingDisplay), hasWorkspace: Boolean(qwenWorkspaceId), realtime, runId })
      if (realtime) {
        // 先订阅中间结果，避免建连后、订阅前丢帧
        await this.subscribePartials(runId)
        if (!this.isRunCurrent(runId)) return
      }

      const commands = streamCommandsOf(asrProvider)
      // 不走流式的三种情形：这家没有流式实现、没开实时字幕（豆包除外）、
      // 或者这份配置还不就绪（千问 realtime 缺业务空间 ID）。
      // 一律回落到「录完再发」，音频在 pcmBuffers 里有完整一份。
      if (!commands || (!realtime && !commands.streamWithoutRealtime)) {
        this.teardownPartials()
        return
      }
      this.streamCommands = commands

      const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
      const asrAppId = commands.needsAppId
        ? await getSetting('cloudAsr.appId', '') as string
        : ''
      const asrModel = commands.needsModel
        ? await getSetting('cloudAsr.model', '') as string
        : ''
      if (!this.isRunCurrent(runId)) return

      // 参数按各家 Rust open 的签名给，多给的会被忽略但少给的会让 open 失败
      const openArgs: Record<string, unknown> = {
        config: {
          provider: asrProvider,
          api_key: asrApiKey,
          app_id: asrAppId,
          ...(asrModel && { extra: { model: asrModel } }),
        },
        hotwords: startOpts.hotwords ?? [],
        realtime,
      }
      if (commands.needsSampleRate) openArgs.sampleRate = 16000
      if (commands.needsWorkspaceId) openArgs.workspaceId = qwenWorkspaceId

      addRuntimeEvent('info', 'cloud_api', 'Streaming: connecting', {
        asrProvider,
        realtime,
        model: asrModel || '(provider default)',
        hasWorkspace: Boolean(qwenWorkspaceId),
      })
      const opened = await this.invokeNativeOpen(runId, commands.open, openArgs)
      if (!opened || !this.isRunCurrent(runId)) return
      this.streamReady = true
      addRuntimeEvent('info', 'cloud_api', 'Streaming: ready', { asrProvider })

      // 补发建连期间已缓存的音频
      await this.flushPendingChunks(runId)
      if (!this.isRunCurrent(runId)) return

      // 启动定时器，每 200ms 批量发送一次（收尾阶段不再触发新发送）
      this.flushTimer = setInterval(() => {
        if (!this.isRunCurrent(runId) || this.streamFinishing) return
        if (this.streamReady && this.pendingChunks.length > 0) {
          void this.flushPendingChunks(runId)
        }
      }, 200)
    } catch (err) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('warn', 'cloud_api', 'Streaming connection failed; falling back to buffered upload', { error: String(err) })
      this.streamCommands = null
      this.streamReady = false
      this.teardownPartials()
    }
  }

  /** 把一次批量发送排入串行链路，返回可 await 的 Promise。
   *  链式串行保证多次 flush、以及收尾前的最终 flush 都严格按顺序送达 Rust，
   *  绝不会出现音频包穿插到负包之后。 */
  private flushPendingChunks(runId: number): Promise<void> {
    const run = async () => {
      if (!this.isRunCurrent(runId) || this.pendingChunks.length === 0) return
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
        if (this.streamCommands) {
          await invoke(this.streamCommands.send, { pcmB64: b64 })
        }
      } catch (err) {
        addRuntimeEvent('warn', 'cloud_api', 'Streaming send failed', { error: String(err) })
      }
    }
    // 接到发送链尾部，串行执行（无论前一个成功或失败都继续）
    this.sendLock = this.sendLock.then(run, run)
    return this.sendLock
  }

  // ── 处理逻辑 ──

  private async runProcess(
    runId: number,
    startOpts: Readonly<StartOptions>,
  ): Promise<void> {
    const stopTime = performance.now() // stop 时刻，用于计算流式模式的等待时间
    const startTime = this.streamStartTime || stopTime

    try {
      if (!this.isRunCurrent(runId)) return
      const totalBytes = this.pcmBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
      if (totalBytes === 0) {
        this.teardownPartials()
        this.callbacks.onDone?.()
        return
      }

      const durationSec = (totalBytes / 2) / 16000
      if (durationSec < 0.3) {
        addRuntimeEvent('info', 'cloud_api', 'Audio too short; skipped processing', { durationSec })
        this.teardownPartials()
        this.callbacks.onDone?.()
        return
      }

      // 读取 ASR 配置
      const asrProvider = await getSetting('cloudAsr.provider', 'doubao') as string
      if (!this.isRunCurrent(runId)) return
      const isQwenOmni = isQwenOmniProvider(asrProvider)

      let asrText = ''
      let asrMs = 0
      /** 流式收尾拿到了结果；为 false 时走下面的一次性上传 */
      let streamedOk = false

      if (this.streamCommands && this.streamReady) {
        // 流式收尾：先置收尾标志（阻止新音频入队/定时器再发），停定时器，
        // flush 剩余数据并等发送链彻底排空，最后再发负包——保证负包是最后一个包。
        const commands = this.streamCommands
        this.streamFinishing = true
        if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
        await this.flushPendingChunks(runId)
        await this.sendLock
        if (!this.isRunCurrent(runId)) return

        addRuntimeEvent('info', 'cloud_api', 'Streaming: sending finish', { command: commands.finish })
        const finishStart = performance.now()
        try {
          const text = await this.invokeNativeFinish(runId, commands.finish)
          if (text === undefined || !this.isRunCurrent(runId)) return
          asrText = text
          asrMs = Math.round(performance.now() - finishStart)
          streamedOk = true
          addRuntimeEvent('info', 'cloud_api', 'Streaming: recognition complete', { asrMs, textLen: asrText.length })
        } catch (err) {
          if (!this.isRunCurrent(runId)) return
          // 边录边发的那条连接出了事（服务端提前结束会话、连接被重置、超时），但完整录音
          // 还在 pcmBuffers 里：直接改走下面的一次性上传，等于自动做一遍「历史里重新识别」。
          // 以前这里直接报失败，用户只能自己去历史里点重试（诊断包 61c93385：长录音 4/10 失败，
          // 历史重试全部成功）。只重试一次，一次性上传也失败就照常报错。
          addRuntimeEvent('warn', 'cloud_api', 'Streaming finish failed; retrying with buffered upload', {
            error: String(err),
            durationSec,
            command: commands.finish,
          })
          this.streamCommands = null
          this.streamReady = false
        }
      }

      if (!streamedOk) {
        // 没走流式（这家不支持 / 没开字幕 / 建连失败），或者流式收尾失败：录完再发
        const merged = new Uint8Array(totalBytes)
        let offset = 0
        for (const buf of this.pcmBuffers) {
          merged.set(new Uint8Array(buf), offset)
          offset += buf.byteLength
        }
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const asrAppId = await getSetting('cloudAsr.appId', '') as string
        const asrModel = await getSetting('cloudAsr.model', '') as string
        if (!this.isRunCurrent(runId)) return

        let omniInstructions: string | undefined
        if (isQwenOmni) {
          const savedPrompt = await getSetting('cloudAsr.omniSystemPrompt', '') as string
          if (!this.isRunCurrent(runId)) return
          omniInstructions = savedPrompt || undefined
        }

        // 地址自己填的那两张卡才有值；其余卡片这个键是空串（见 asrEndpointUrl）
        const asrBaseUrl = await getSetting('cloudAsr.baseUrl', '') as string
        const asrProtocol = await getSetting('cloudAsr.protocol', 'auto') as string
        if (!this.isRunCurrent(runId)) return

        const extra = buildAsrExtra(asrProvider, {
          model: asrModel,
          instructions: omniInstructions,
          baseUrl: asrBaseUrl,
          protocol: asrProtocol,
        })
        const asrConfig: AsrProviderConfig = {
          provider: isQwenOmni ? 'qwen_omni' : asrProvider,
          api_key: asrApiKey,
          app_id: asrAppId,
          ...(extra && { extra }),
        }

        addRuntimeEvent('info', 'cloud_api', 'ASR started', {
          provider: asrProvider,
          model: extra?.model ?? '(provider default)',
          durationSec,
        })
        const asrResult = await cloudTranscribeRaw<AsrResult>(merged, {
          sample_rate: 16000,
          asr_config: asrConfig,
          hotwords: startOpts.hotwords ?? [],
        })
        // 「OpenAI 兼容」的 auto 协议是在这条调用**内部**探测出来的（结果进
        // asr_openai_compat 的 PROTOCOL_CACHE）。热词页只在挂载时查过一次能力，
        // 不广播的话它会一直挂着"协议还没探测出来"，而答案其实已经有了。
        // 放在代次检查之前：探测缓存是进程级的，这一轮作不作废都不影响它已经更新。
        notifyAsrCapabilityMaybeChanged()
        if (!this.isRunCurrent(runId)) return
        asrText = asrResult.text
        asrMs = asrResult.elapsed_ms
      }

      this.pcmBuffers = []
      // ASR 已拿到最终文本，后续不再有中间结果，撤下监听
      this.teardownPartials()

      // 还原被 ASR 拆开加空格的无空格热词（如豆包把 "SayIt" 识别成 "Say It"）
      asrText = restoreHotwordSpacing(asrText, startOpts.hotwords ?? [])

      // 发送 ASR 中间结果
      this.callbacks.onASR?.({ text: asrText, asrMs, durationSec })

      // 与其它模式共用同一份判据。isQwenOmni 走 integrated_asr 路由：它表达的是
      // "识别引擎自带整理，没有另外调独立 AI"，而不是"用户的预设已经执行过"。
      const policy = policyFromSnapshot(startOpts.aiConfig, 'cloud_api', durationSec, isQwenOmni)
      const outcomeContext: AiOutcomeContext = {
        operationId: startOpts.operationId || `cloud-${runId}`,
        trigger: startOpts.source === 'history_reprocess' ? 'history_reprocess' : 'live',
      }

      if (!asrText.trim()) {
        const outcome = resolveAndLogAiOutcome(outcomeContext, policy, { asrTextEmpty: true })
        this.callbacks.onFinal?.({
          asrText: '',
          llmText: '',
          asrMs,
          llmMs: 0,
          durationSec,
          aiSource: outcome.source,
          aiStatus: outcome.status,
        })
        this.callbacks.onDone?.()
        return
      }

      // AI 校对（Qwen Omni 已内置 AI，由 policy 判成不允许调用，这里走同一条返回）
      const polish = policy.route === 'integrated_asr'
        ? (() => {
          const outcome = resolveAndLogAiOutcome(outcomeContext, policy)
          return {
            llmText: startOpts.textContext?.selectedText || asrText,
            llmMs: 0,
            contextApplied: startOpts.textContext ? false : undefined,
            aiSource: outcome.source,
            aiStatus: outcome.status,
          }
        })()
        : await polishWithClientAi({
          asrText,
          startOptions: startOpts,
          policy,
          outcomeContext,
          logSource: 'cloud_api',
          isCurrent: () => this.isRunCurrent(runId),
        })
      if (!polish || !this.isRunCurrent(runId)) return

      const totalMs = Math.round(performance.now() - startTime)
      addRuntimeEvent('info', 'cloud_api', 'Processing complete', {
        durationSec,
        asrMs,
        llmMs: polish.llmMs,
        totalMs,
        runId,
      })

      const omniModel = isQwenOmni ? resolveQwenOmniModel(asrProvider) : undefined

      this.callbacks.onFinal?.({
        asrText,
        asrMs,
        durationSec,
        ...polish,
        ...(isQwenOmni && { asrEngine: 'qwen_omni', asrModel: omniModel }),
      })
      this.callbacks.onDone?.()
    } catch (err) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('error', 'cloud_api', 'Processing failed', { error: String(err) })
      this.teardownPartials()
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
    } finally {
      this.completeRun(runId)
    }
  }
}
