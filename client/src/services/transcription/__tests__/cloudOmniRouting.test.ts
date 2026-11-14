import { beforeEach, describe, expect, it, vi } from 'vitest'

// 真录音时「按不按 Omni 处理」的回归测试。
//
// 0.2.1~0.2.5 里 HTTP 那个 qwen3.8-omni-flash（运行时 key = qwen_chat_audio）被当成普通识别：
// 录音链路拿 isQwenOmniProvider（只认 qwen_omni 前缀）判这件事，于是 System Prompt
// 发不出去、模型只做转写，之后又被客户端 AI 整理一遍。设置页的测试按钮看的是目录标记，
// 所以那边一切正常。这里钉的是机制，不只是结果：发出去的 extra 里有没有 instructions、
// ai.outcome 的 route 是不是 integrated_asr（排查时 grep 的就是这一条）。

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  transcribe: vi.fn(),
  polish: vi.fn(),
  events: vi.fn(),
  settings: {} as Record<string, unknown>,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => { }) }))
vi.mock('../../store', () => ({
  getSetting: async (key: string, fallback: unknown) => (key in mocks.settings ? mocks.settings[key] : fallback),
}))
vi.mock('../../debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => mocks.events(...args),
  AI_LOG_SOURCE: 'ai',
  AI_EVENT_REQUEST: 'request',
  AI_EVENT_OUTCOME: 'outcome',
}))
vi.mock('../../bridge', () => ({
  cloudTranscribeRaw: (...args: unknown[]) => mocks.transcribe(...args),
  notifyAsrCapabilityMaybeChanged: () => { },
}))
vi.mock('../clientAiPolish', () => ({
  polishWithClientAi: (...args: unknown[]) => mocks.polish(...args),
}))

import { CloudAPIProvider } from '../CloudAPIProvider'
import { __resetAiOutcomeLogDedupe } from '../aiPolicy'

const PROMPT = '整理成通顺的书面语'

async function recordOnce(runtime: { provider: string; model: string }) {
  mocks.settings = {
    'cloudAsr.provider': runtime.provider,
    'cloudAsr.model': runtime.model,
    'cloudAsr.apiKey': 'key',
    'cloudAsr.omniSystemPrompt': PROMPT,
  }
  const onFinal = vi.fn()
  const onError = vi.fn()
  const provider = new CloudAPIProvider()
  await provider.connect({ onFinal, onError })
  provider.start({ runId: 1 })
  provider.sendAudio(new ArrayBuffer(32000)) // 1 秒 16kHz 16bit
  provider.stop()
  await vi.waitFor(() => expect(onFinal.mock.calls.length + onError.mock.calls.length).toBe(1))
  expect(onError).not.toHaveBeenCalled()
  expect(mocks.transcribe).toHaveBeenCalledTimes(1)
  const request = mocks.transcribe.mock.calls[0][1] as {
    asr_config: { provider: string; extra?: Record<string, unknown> }
  }
  const outcome = mocks.events.mock.calls.find((call) => call[2] === 'outcome')?.[3] as
    | { route?: string; reason?: string }
    | undefined
  return { asrConfig: request.asr_config, outcome, final: onFinal.mock.calls[0][0] }
}

describe('cloud API: Omni routing at recording time', () => {
  beforeEach(() => {
    __resetAiOutcomeLogDedupe()
    mocks.invoke.mockReset()
    mocks.events.mockReset()
    mocks.transcribe.mockReset().mockResolvedValue({ text: '识别结果', elapsed_ms: 800 })
    mocks.polish.mockReset().mockImplementation(
      async ({ asrText }: { asrText: string }) => ({ llmText: asrText, llmMs: 0 }),
    )
  })

  it('HTTP qwen3.8-omni-flash sends the System Prompt and skips the client AI', async () => {
    const { asrConfig, outcome, final } = await recordOnce({
      provider: 'qwen_chat_audio',
      model: 'qwen3.8-omni-flash',
    })

    // 分发 key 不能被换成 qwen_omni —— 那是 realtime WebSocket 的实现
    expect(asrConfig.provider).toBe('qwen_chat_audio')
    expect(asrConfig.extra).toMatchObject({ model: 'qwen3.8-omni-flash', instructions: PROMPT })
    expect(mocks.polish).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ route: 'integrated_asr', reason: 'integrated_asr' })
    expect(final).toMatchObject({ asrText: '识别结果', llmText: '识别结果' })
  })

  it('realtime Omni still dispatches to qwen_omni with the System Prompt', async () => {
    const { asrConfig, outcome } = await recordOnce({
      provider: 'qwen_omni',
      model: 'qwen3.5-omni-flash-realtime',
    })

    expect(asrConfig.provider).toBe('qwen_omni')
    expect(asrConfig.extra).toMatchObject({ model: 'qwen3.5-omni-flash-realtime', instructions: PROMPT })
    expect(mocks.polish).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ route: 'integrated_asr' })
  })

  it('plain ASR gets no System Prompt and goes through the client AI', async () => {
    const { asrConfig } = await recordOnce({ provider: 'qwen', model: 'qwen3-asr-flash' })

    expect(asrConfig.provider).toBe('qwen')
    expect(asrConfig.extra).toEqual({ model: 'qwen3-asr-flash' })
    expect(mocks.polish).toHaveBeenCalledTimes(1)
  })
})
