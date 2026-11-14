import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ appendDebugLog: vi.fn() }))

// 只替换真正的落盘出口。debugLog 本体用真实实现 —— 这条测试要验的就是它里面那层
// 白名单过滤，mock 掉它等于什么都没验。
vi.mock('../bridge', () => ({ appendDebugLog: mocks.appendDebugLog }))

import {
  addRuntimeEvent,
  AI_EVENT_OUTCOME,
  AI_EVENT_REQUEST,
  AI_LOG_SOURCE,
  clearRuntimeEvents,
  getRuntimeEvents,
  SETTINGS_EVENT_MODEL_RENAMED,
} from '../debugLog'

interface MirroredPayload {
  kind?: string
  level?: string
  source?: string
  message?: string
  detail?: unknown
}

function mirrored(): MirroredPayload[] {
  return mocks.appendDebugLog.mock.calls.map((call) => call[0] as MirroredPayload)
}

function mirroredMessages(): string[] {
  return mirrored()
    .filter((p) => p.kind === 'runtime')
    .map((p) => p.message ?? '')
}

/**
 * 这次排查真正卡住的地方：`polishWithClientAi` 里那条"低于门槛所以跳过"的 info 日志
 * **执行了但没落盘** —— 它的 source 是 'server' / 'local' / 'cloud_api'，三个都不在
 * debugLog 的白名单里，于是既不进 sayit.log 也不进内存环形缓冲。
 *
 * 所以只断言"我调了 addRuntimeEvent"是不够的（那在出 bug 的版本上也全绿）。
 * 这里断言的是"它确实穿过了过滤层"。
 *
 * 变异验证：把 debugLog.ts 里 `source === AI_LOG_SOURCE && AI_KEY_EVENTS.has(...)`
 * 那两处放行条件去掉，本文件的前两条用例必须失败。若仍全绿，说明测试没覆盖过滤机制。
 */
describe('AI 事件必须真的穿过落盘过滤层', () => {
  beforeEach(() => {
    mocks.appendDebugLog.mockClear()
    clearRuntimeEvents()
  })

  it.each([AI_EVENT_OUTCOME, AI_EVENT_REQUEST])('%s 会被镜像到主日志', (event) => {
    addRuntimeEvent('info', AI_LOG_SOURCE, event, { operationId: 'op-x' })
    expect(mirroredMessages()).toContain(event)
  })

  it.each([AI_EVENT_OUTCOME, AI_EVENT_REQUEST])('%s 也会进内存运行事件（两处判据必须同步）', (event) => {
    addRuntimeEvent('info', AI_LOG_SOURCE, event, { operationId: 'op-y' })
    const kept = getRuntimeEvents().filter((e) => e.message === event)
    expect(kept.length).toBeGreaterThan(0)
  })

  it('同来源的其它 info 事件仍然被过滤掉（放行面只有这两个，不是整个 ai 来源）', () => {
    addRuntimeEvent('info', AI_LOG_SOURCE, 'ai.some.debug.chatter', { noise: true })
    expect(mirroredMessages()).not.toContain('ai.some.debug.chatter')
  })

  it('旧路径那条按 provider 命名的 info 依然不落盘（说明本轮的修法是必要的）', () => {
    // 这几个 source 就是改之前 polishWithClientAi 用的 logSource
    for (const source of ['server', 'local', 'cloud_api', 'history']) {
      addRuntimeEvent('info', source, 'AI cleanup skipped below duration threshold', {})
    }
    expect(mirroredMessages()).not.toContain('AI cleanup skipped below duration threshold')
  })

  it('warn 级别不受白名单限制（自配 AI 失败详情靠它落盘）', () => {
    addRuntimeEvent('warn', 'server', 'Custom AI cleanup failed; using raw ASR text', { error: 'boom' })
    expect(mirroredMessages()).toContain('Custom AI cleanup failed; using raw ASR text')
  })
})

/**
 * 启动时换掉下线模型名那条事件。它最早写成普通文案的 info，执行了却哪儿都没留下：
 * settings 来源的 info 不在白名单里（2026-11 开发版实测，sayit.log 里一个字都没有）。
 */
describe('启动时改配置的事件必须留痕', () => {
  beforeEach(() => {
    mocks.appendDebugLog.mockClear()
    clearRuntimeEvents()
  })

  it('换模型名的事件进主日志，也进内存运行事件', () => {
    addRuntimeEvent('info', 'settings', SETTINGS_EVENT_MODEL_RENAMED, { scope: 'runtime', from: 'deepseek-chat', to: 'deepseek-flash' })
    expect(mirroredMessages()).toContain(SETTINGS_EVENT_MODEL_RENAMED)
    expect(getRuntimeEvents().some((e) => e.message === SETTINGS_EVENT_MODEL_RENAMED)).toBe(true)
  })

  it('settings 来源的其它 info 仍然被过滤掉', () => {
    addRuntimeEvent('info', 'settings', 'Saved a setting', { key: 'theme' })
    expect(mirroredMessages()).not.toContain('Saved a setting')
    expect(getRuntimeEvents().some((e) => e.message === 'Saved a setting')).toBe(false)
  })
})
