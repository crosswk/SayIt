import { beforeEach, describe, expect, it, vi } from 'vitest'

// 边录边发的那条连接在收尾时失败，完整录音还在手里：必须自动改走一次性上传，
// 而不是把失败报给用户、让他自己去历史里重试（诊断包 61c93385，豆包长录音 4/10 失败）。

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  transcribe: vi.fn(),
  settings: {} as Record<string, unknown>,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => { }) }))
vi.mock('../../store', () => ({
  getSetting: async (key: string, fallback: unknown) => (key in mocks.settings ? mocks.settings[key] : fallback),
}))
vi.mock('../../debugLog', () => ({
  addRuntimeEvent: vi.fn(),
  AI_LOG_SOURCE: 'ai',
  AI_EVENT_REQUEST: 'request',
  AI_EVENT_OUTCOME: 'outcome',
}))
vi.mock('../../bridge', () => ({
  cloudTranscribeRaw: (...args: unknown[]) => mocks.transcribe(...args),
  notifyAsrCapabilityMaybeChanged: () => { },
}))
vi.mock('../clientAiPolish', () => ({
  polishWithClientAi: async ({ asrText }: { asrText: string }) => ({ llmText: asrText, llmMs: 0 }),
}))

import { CloudAPIProvider } from '../CloudAPIProvider'

/** 1 秒 16kHz 16bit 单声道 PCM */
const oneSecond = () => new ArrayBuffer(32000)

async function record(finish: () => Promise<unknown>) {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'doubao_stream_finish') return finish()
    return undefined
  })
  const onFinal = vi.fn()
  const onError = vi.fn()
  const provider = new CloudAPIProvider()
  await provider.connect({ onFinal, onError })
  provider.start({ runId: 1 })
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('doubao_stream_open', expect.anything()))
  // 等 open 完成、streamReady 置位（open 之后还有一次 flush）
  await new Promise((resolve) => setTimeout(resolve, 0))
  provider.sendAudio(oneSecond())
  provider.stop()
  await vi.waitFor(() => expect(onFinal.mock.calls.length + onError.mock.calls.length).toBe(1))
  return { onFinal, onError }
}

describe('cloud streaming finish failure', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.transcribe.mockReset().mockResolvedValue({ text: '完整的识别结果', elapsed_ms: 5100 })
    mocks.settings = {
      'cloudAsr.provider': 'doubao_v2',
      'cloudAsr.apiKey': 'key',
      aiEnabled: false,
    }
  })

  it('re-recognizes the full recording when the streaming session dies before the final result', async () => {
    const { onFinal, onError } = await record(async () => {
      throw new Error('sayit_error:provider_timeout:Recognition error: waiting next packet timeout')
    })

    expect(mocks.invoke).toHaveBeenCalledWith('doubao_stream_finish')
    expect(mocks.transcribe).toHaveBeenCalledTimes(1)
    const [pcm, request] = mocks.transcribe.mock.calls[0]
    expect((pcm as Uint8Array).byteLength).toBe(32000)
    expect(request).toMatchObject({ asr_config: { provider: 'doubao_v2' } })
    expect(onError).not.toHaveBeenCalled()
    expect(onFinal.mock.calls[0][0]).toMatchObject({ asrText: '完整的识别结果' })
  })

  it('keeps the streamed result and does not upload twice when finish succeeds', async () => {
    const { onFinal } = await record(async () => '流式结果')

    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(onFinal.mock.calls[0][0]).toMatchObject({ asrText: '流式结果' })
  })

  it('reports the error when the buffered retry fails too', async () => {
    mocks.transcribe.mockRejectedValue(new Error('sayit_error:provider_unreachable:offline'))
    const { onFinal, onError } = await record(async () => {
      throw new Error('connection reset')
    })

    expect(mocks.transcribe).toHaveBeenCalledTimes(1)
    expect(onFinal).not.toHaveBeenCalled()
    expect(onError.mock.calls[0][0]).toContain('offline')
  })
})
