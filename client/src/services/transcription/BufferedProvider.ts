/**
 * 缓冲式 Provider 基类
 * CloudAPIProvider 和 LocalProvider 共享的 PCM 缓冲、合并、生命周期逻辑。
 * 子类只需实现 onConnect() 和 processAudio()。
 */

import { uint8ArrayToBase64 } from '@/lib/encoding'
import { addRuntimeEvent } from '../debugLog'
import type {
  TranscriptionProvider,
  TranscriptionCallbacks,
  StartOptions,
  StopOptions,
  WorkMode,
} from './types'

export abstract class BufferedProvider implements TranscriptionProvider {
  abstract readonly mode: WorkMode

  protected callbacks: TranscriptionCallbacks = {}
  protected pcmBuffers: ArrayBuffer[] = []
  protected sessionActive = false
  protected startOpts: StartOptions | undefined
  protected ready = false

  /** 子类可覆盖，用于连接时的额外初始化（如预加载模型） */
  protected async onConnect(_callbacks: TranscriptionCallbacks): Promise<void> {}

  async connect(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    this.ready = true
    callbacks.onStateChange?.('connected')
    await this.onConnect(callbacks)
  }

  start(opts?: StartOptions): boolean {
    if (!this.ready) {
      addRuntimeEvent('error', this.mode, 'start 失败：Provider 未就绪')
      return false
    }
    this.pcmBuffers = []
    this.sessionActive = true
    this.startOpts = opts
    return true
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (!this.sessionActive) return
    this.pcmBuffers.push(buffer.slice(0))
  }

  stop(_opts?: StopOptions): boolean {
    if (!this.sessionActive) return false
    this.sessionActive = false
    void this.runProcessAudio()
    return true
  }

  disconnect(): void {
    this.sessionActive = false
    this.pcmBuffers = []
    this.ready = false
    this.callbacks.onStateChange?.('disconnected')
  }

  isReady(): boolean {
    return this.ready
  }

  // ─── 子类实现 ───

  /**
   * 处理合并后的音频数据。
   * @param audioB64 base64 编码的 PCM 数据
   * @param durationSec 音频时长（秒）
   */
  protected abstract processAudio(audioB64: string, durationSec: number): Promise<void>

  // ─── 内部逻辑 ───

  private async runProcessAudio(): Promise<void> {
    const startTime = performance.now()

    try {
      const totalBytes = this.pcmBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
      if (totalBytes === 0) {
        this.callbacks.onDone?.()
        return
      }

      const merged = new Uint8Array(totalBytes)
      let offset = 0
      for (const buf of this.pcmBuffers) {
        merged.set(new Uint8Array(buf), offset)
        offset += buf.byteLength
      }
      this.pcmBuffers = []

      const durationSec = (totalBytes / 2) / 16000
      if (durationSec < 0.3) {
        addRuntimeEvent('info', this.mode, '音频过短，跳过处理', { durationSec })
        this.callbacks.onDone?.()
        return
      }

      const audioB64 = uint8ArrayToBase64(merged)
      await this.processAudio(audioB64, durationSec)
    } catch (err) {
      addRuntimeEvent('error', this.mode, '处理异常', { error: String(err) })
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
    }
  }
}
