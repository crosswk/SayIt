// 服务器模式 Provider — 封装现有 WebSocket 逻辑
// 行为与原 websocket.ts 完全一致，只是包装为 TranscriptionProvider 接口

import * as ws from '../websocket'
import type {
  TranscriptionProvider,
  TranscriptionCallbacks,
  StartOptions,
  StopOptions,
} from './types'

export class ServerProvider implements TranscriptionProvider {
  readonly mode = 'server' as const

  private callbacks: TranscriptionCallbacks = {}

  async connect(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    await ws.connect({
      onStateChange: (state) => {
        callbacks.onStateChange?.(state)
      },
      onReady: (data) => {
        callbacks.onReady?.({
          connectionId: data.connectionId,
          asr: data.asr,
          llm: data.llm,
        })
      },
      onASR: (result) => {
        callbacks.onASR?.({
          text: result.text,
          asrMs: result.asrMs,
          durationSec: result.durationSec,
        })
      },
      onFinal: (result) => {
        callbacks.onFinal?.({
          asrText: result.asrText,
          llmText: result.llmText,
          asrMs: result.asrMs,
          llmMs: result.llmMs,
          durationSec: result.durationSec,
          asrEngine: result.asrEngine,
          asrModel: result.asrModel,
        })
      },
      onDone: () => {
        callbacks.onDone?.()
      },
      onError: (msg) => {
        callbacks.onError?.(msg)
      },
    })
  }

  start(opts?: StartOptions): boolean {
    return ws.sendStart(opts)
  }

  sendAudio(buffer: ArrayBuffer): void {
    ws.sendAudio(buffer)
  }

  stop(opts?: StopOptions): boolean {
    return ws.sendStop(opts)
  }

  disconnect(): void {
    ws.disconnect()
  }

  isReady(): boolean {
    return ws.isConnected()
  }
}
