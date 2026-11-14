import { describe, it, expect, vi, beforeEach } from 'vitest'

// 存储层走 Tauri IPC，换成一个内存 Map（同 asrProfileStore.test.ts 的做法）。
const { store, events } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  events: [] as unknown[][],
}))
vi.mock('@/services/store', () => ({
  getSetting: (key: string, fallback: unknown) =>
    Promise.resolve(store.has(key) ? store.get(key) : fallback),
  setSetting: (key: string, value: unknown) => {
    store.set(key, value)
    return Promise.resolve()
  },
}))
// 事件名要和 debugLog 里的常量一致：那边按这个名字放行进日志（见 aiLogMirroring.test.ts）
vi.mock('@/services/debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => { events.push(args) },
  SETTINGS_EVENT_MODEL_RENAMED: 'settings.retired_model_renamed',
}))

import {
  AI_ACTIVE_PROFILE_KEY,
  AI_PROFILES_KEY,
  AI_PROFILES_MIGRATED_KEY,
  loadAiProfiles,
  upgradeRetiredAiModelsOnStartup,
} from '../aiProfileStore'
import type { AiProfile } from '../aiProviderCatalog'
import { CONTEXT_SELECTION_AI_PROFILE_KEY } from '@/services/transcription/selectionAi'

function profile(over: Partial<AiProfile> = {}): AiProfile {
  return {
    id: 'p1',
    provider: 'deepseek',
    apiUrl: 'https://api.deepseek.com',
    apiKey: 'sk-key',
    model: 'deepseek-v4-flash',
    ...over,
  }
}

function seedProfiles(profiles: AiProfile[], activeId: string) {
  store.set(AI_PROFILES_MIGRATED_KEY, true)
  store.set(AI_PROFILES_KEY, profiles)
  store.set(AI_ACTIVE_PROFILE_KEY, activeId)
  const active = profiles.find((p) => p.id === activeId)
  store.set('cloudAi.provider', active?.provider ?? '')
  store.set('cloudAi.apiUrl', active?.apiUrl ?? '')
  store.set('cloudAi.apiKey', active?.apiKey ?? '')
  store.set('cloudAi.model', active?.model ?? '')
}

beforeEach(() => {
  store.clear()
  events.length = 0
})

/** 记下的换名事件（level, source, message, detail） */
function renameEvents() {
  return events.filter((e) => e[2] === 'settings.retired_model_renamed')
}

describe('upgradeRetiredAiModelsOnStartup', () => {
  /**
   * 录音链路只读运行时那四个键，所以光改列表不够 —— 这条钉住「运行时键跟着换了」。
   * 不在启动时做的话，从不打开 AI 服务页的人要等旧名被停掉、AI 整理报错才会发现。
   */
  it('列表和运行时键里的旧名一起换成 deepseek-flash', async () => {
    seedProfiles([
      profile({ id: 'ds' }),
      profile({ id: 'qw', provider: 'qwen', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode', model: 'qwen-plus' }),
    ], 'ds')

    await upgradeRetiredAiModelsOnStartup()

    const saved = store.get(AI_PROFILES_KEY) as AiProfile[]
    expect(saved.map((p) => [p.id, p.model])).toEqual([['ds', 'deepseek-flash'], ['qw', 'qwen-plus']])
    expect(store.get('cloudAi.model')).toBe('deepseek-flash')
    expect(store.get(AI_ACTIVE_PROFILE_KEY)).toBe('ds')
    // 改了用户配置就要留一条；没有走到 catch 里的 warn
    expect(renameEvents()).toEqual([['info', 'settings', 'settings.retired_model_renamed', { scope: 'profiles', merged: 0 }]])
    expect(events.some((e) => e[0] === 'warn')).toBe(false)
  })

  it('换名并掉的重复项：启用项和「改写选区」的引用都改指留下的那条', async () => {
    seedProfiles([
      profile({ id: 'old-chat', model: 'deepseek-chat' }),
      profile({ id: 'old-flash', model: 'deepseek-v4-flash' }),
    ], 'old-flash')
    store.set(CONTEXT_SELECTION_AI_PROFILE_KEY, 'old-chat')

    await upgradeRetiredAiModelsOnStartup()

    const saved = store.get(AI_PROFILES_KEY) as AiProfile[]
    expect(saved.map((p) => p.id)).toEqual(['old-flash'])
    expect(saved[0].model).toBe('deepseek-flash')
    expect(store.get(AI_ACTIVE_PROFILE_KEY)).toBe('old-flash')
    expect(store.get(CONTEXT_SELECTION_AI_PROFILE_KEY)).toBe('old-flash')
  })

  /** 中转站上的名字是对方定的，换了可能就不通了；而且没有要换的就一个键都不写。 */
  it('中转站上的配置原样不动、不写任何键', async () => {
    const relay = profile({ apiUrl: 'https://relay.example.com/v1', model: 'deepseek-chat' })
    seedProfiles([relay], relay.id)
    const before = new Map(store)

    await upgradeRetiredAiModelsOnStartup()

    expect(new Map(store)).toEqual(before)
    expect(events).toEqual([])
  })

  /** 还没打开过新版 AI 服务页的老用户：列表是空的，只有运行时键。 */
  it('列表还没摊平的老用户只改运行时键', async () => {
    store.set('cloudAi.provider', 'deepseek')
    store.set('cloudAi.apiUrl', 'https://api.deepseek.com')
    store.set('cloudAi.model', 'deepseek-chat')

    await upgradeRetiredAiModelsOnStartup()

    expect(store.get('cloudAi.model')).toBe('deepseek-flash')
    expect(store.has(AI_PROFILES_KEY)).toBe(false)
    expect(store.has(AI_PROFILES_MIGRATED_KEY)).toBe(false)
    expect(renameEvents()).toEqual([
      ['info', 'settings', 'settings.retired_model_renamed', { scope: 'runtime', from: 'deepseek-chat', to: 'deepseek-flash' }],
    ])
  })
})

describe('loadAiProfiles', () => {
  /** 老结构摊平出来的就是旧名；摊平和换名要在同一次加载里做完，运行时键也要跟上。 */
  it('从老结构摊平时一并换名，两条旧名并成一条', async () => {
    store.set('cloudAi.deepseek.apiUrl', 'https://api.deepseek.com')
    store.set('cloudAi.deepseek.apiKey', 'sk-ds')
    store.set('cloudAi.deepseek.model', 'deepseek-chat')
    store.set('cloudAi.deepseek.models', 'deepseek-chat,deepseek-reasoner')
    store.set('cloudAi.provider', 'deepseek')
    store.set('cloudAi.model', 'deepseek-chat')

    const { profiles, activeId } = await loadAiProfiles()

    expect(profiles.map((p) => p.model)).toEqual(['deepseek-flash'])
    expect(activeId).toBe(profiles[0].id)
    expect(store.get('cloudAi.model')).toBe('deepseek-flash')
    // 老的按供应商存的键不删：降级回旧版本还能用
    expect(store.get('cloudAi.deepseek.model')).toBe('deepseek-chat')
  })
})
