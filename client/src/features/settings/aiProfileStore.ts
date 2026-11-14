// 「AI 服务」列表的持久化，以及与运行时配置的同步。
//
// 这里有两套键，职责必须分清：
//   1. 列表本身 —— `cloudAi.profiles` + `cloudAi.activeProfileId`，只有本页读写；
//   2. 运行时生效的那一份 —— `cloudAi.provider / apiUrl / apiKey / model`，
//      由录音链路（CloudAPIProvider、LocalProvider）、历史记录重跑、诊断页、反馈上报
//      六处消费。它们只认这四个扁平键，**这个契约不能动**。
//
// 所以规则是：列表是真相，每次列表或启用项变化都把启用的那条整份写进那四个键。
// 「切了模型但地址/密钥还是上一家的」这个 bug 之所以可能存在，就是因为过去这四个键
// 是分别维护的；现在它们只有一个写入点。
//
// profiles 里带 apiKey，会跟着配置导出走（Rust 侧 export_app_settings 是整表导出，
// 无需登记新键）。诊断报告不受影响：collect_settings 用的是固定白名单，不含 cloudAi.*。

import { getSetting, setSetting } from '@/services/store'
import { addRuntimeEvent, SETTINGS_EVENT_MODEL_RENAMED } from '@/services/debugLog'
import { CONTEXT_SELECTION_AI_PROFILE_KEY } from '@/services/transcription/selectionAi'
import {
  AI_PROVIDERS,
  aiSettingKey,
  migrateLegacyProfiles,
  parseLegacyLatencies,
  parseProfiles,
  resolveActiveProfile,
  upgradeRetiredAiModel,
  upgradeRetiredAiModels,
  type AiProfile,
  type LegacyProviderData,
} from './aiProviderCatalog'

export const AI_PROFILES_KEY = 'cloudAi.profiles'
export const AI_ACTIVE_PROFILE_KEY = 'cloudAi.activeProfileId'
/** 老数据只迁一次。没有这个标记，用户删光列表后下次进页面又会被"救回来" */
export const AI_PROFILES_MIGRATED_KEY = 'cloudAi.profilesMigrated'

export interface AiProfileState {
  profiles: AiProfile[]
  activeId: string
}

/** 把启用的那条写进运行时四个键。没有可用的服务时写空串，让下游自己跳过 AI 环节 */
async function syncRuntimeActive(profile: AiProfile | null): Promise<void> {
  await Promise.all([
    setSetting('cloudAi.provider', profile?.provider ?? ''),
    setSetting('cloudAi.apiUrl', profile?.apiUrl ?? ''),
    setSetting('cloudAi.apiKey', profile?.apiKey ?? ''),
    setSetting('cloudAi.model', profile?.model ?? ''),
  ])
}

/** 读出老的「每供应商一组配置」。键一律不删：降级回旧版本还能用 */
async function readLegacyData(): Promise<LegacyProviderData[]> {
  return Promise.all(
    AI_PROVIDERS.map(async (provider): Promise<LegacyProviderData> => {
      const [apiUrl, apiKey, model, modelsRaw, latencyRaw] = await Promise.all([
        getSetting(aiSettingKey(provider.value, 'apiUrl'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'apiKey'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'model'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'models'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'latency'), '') as Promise<string>,
      ])
      return {
        provider: provider.value,
        apiUrl,
        apiKey,
        model,
        models: modelsRaw ? modelsRaw.split(',').map((m) => m.trim()).filter(Boolean) : [],
        latencies: parseLegacyLatencies(latencyRaw),
      }
    }),
  )
}

/**
 * 加载服务列表。首次进入会把老的按供应商存的配置摊平成列表。
 *
 * 返回前会把 activeId 归一化（指向已不存在的 id 时回落到第一条），并在确实写过东西时
 * 顺手同步运行时那四个键——否则会出现"列表里高亮着 A，实际在用 B"。
 */
export async function loadAiProfiles(): Promise<AiProfileState> {
  const [migrated, rawProfiles, storedActiveId] = await Promise.all([
    getSetting(AI_PROFILES_MIGRATED_KEY, false) as Promise<boolean>,
    getSetting(AI_PROFILES_KEY, [] as unknown[]) as Promise<unknown>,
    getSetting(AI_ACTIVE_PROFILE_KEY, '') as Promise<string>,
  ])

  let profiles = parseProfiles(rawProfiles)
  let activeId = storedActiveId
  let needsWrite = false

  if (!migrated) {
    // 老用户：把每家的候选模型摊平成一条条服务；新用户这里得到空列表，走空状态引导
    if (profiles.length === 0) {
      const [legacy, legacyProvider, legacyModel] = await Promise.all([
        readLegacyData(),
        getSetting('cloudAi.provider', '') as Promise<string>,
        getSetting('cloudAi.model', '') as Promise<string>,
      ])
      const result = migrateLegacyProfiles(legacy, legacyProvider, legacyModel)
      profiles = result.profiles
      activeId = result.activeId
    }
    await setSetting(AI_PROFILES_MIGRATED_KEY, true)
    needsWrite = profiles.length > 0
  }

  // 老结构刚摊平出来的那批也要过一遍：老版本的默认就是 deepseek-chat / deepseek-v4-flash
  const upgraded = upgradeRetiredAiModels(profiles, activeId)
  if (upgraded.changed) {
    profiles = upgraded.profiles
    activeId = upgraded.mergedInto[activeId] ?? activeId
    await remapSelectionProfile(upgraded.mergedInto)
    needsWrite = true
  }

  const active = resolveActiveProfile(profiles, activeId)
  if (active && active.id !== activeId) {
    activeId = active.id
    needsWrite = true
  }
  if (!active && activeId !== '') {
    activeId = ''
    needsWrite = true
  }

  if (needsWrite) {
    await saveAiProfiles({ profiles, activeId })
  }

  return { profiles, activeId }
}

/** 换名时并掉了重复项，「改写选区」那一项指着被并掉的 id 的话，改指留下的那条 */
async function remapSelectionProfile(mergedInto: Record<string, string>): Promise<void> {
  if (Object.keys(mergedInto).length === 0) return
  const current = await getSetting(CONTEXT_SELECTION_AI_PROFILE_KEY, '') as string
  const next = current ? mergedInto[current] : undefined
  if (next) await setSetting(CONTEXT_SELECTION_AI_PROFILE_KEY, next)
}

/**
 * 启动时把已下线的模型名换成新名字，列表和运行时四个键一起改。
 *
 * 必须在启动时做，不能等用户打开「AI 服务」页：录音链路只读运行时键，而大多数人
 * 配好之后再也不会打开那一页 —— 等旧名真被停掉，他们看到的就是 AI 整理报错。
 *
 * 还没打开过新版 AI 服务页的老用户（列表还没摊平出来）只改运行时键，列表留给
 * loadAiProfiles 摊平时一起换。幂等：没有要换的就一个键都不写。
 */
export async function upgradeRetiredAiModelsOnStartup(): Promise<void> {
  try {
    const [migrated, rawProfiles, activeId] = await Promise.all([
      getSetting(AI_PROFILES_MIGRATED_KEY, false) as Promise<boolean>,
      getSetting(AI_PROFILES_KEY, [] as unknown[]) as Promise<unknown>,
      getSetting(AI_ACTIVE_PROFILE_KEY, '') as Promise<string>,
    ])
    if (migrated) {
      const upgraded = upgradeRetiredAiModels(parseProfiles(rawProfiles), activeId)
      if (upgraded.changed) {
        await remapSelectionProfile(upgraded.mergedInto)
        // saveAiProfiles 会把启用的那条同步进运行时键
        await saveAiProfiles({
          profiles: upgraded.profiles,
          activeId: upgraded.mergedInto[activeId] ?? activeId,
        })
        // 事件名固定，日志与调试页才会留下它（见 debugLog 的 SETTINGS_EVENT_MODEL_RENAMED）
        addRuntimeEvent('info', 'settings', SETTINGS_EVENT_MODEL_RENAMED, {
          scope: 'profiles',
          merged: Object.keys(upgraded.mergedInto).length,
        })
      }
    }
    const [provider, apiUrl, model] = await Promise.all([
      getSetting('cloudAi.provider', '') as Promise<string>,
      getSetting('cloudAi.apiUrl', '') as Promise<string>,
      getSetting('cloudAi.model', '') as Promise<string>,
    ])
    const next = upgradeRetiredAiModel(provider, apiUrl, model)
    if (next !== model) {
      await setSetting('cloudAi.model', next)
      addRuntimeEvent('info', 'settings', SETTINGS_EVENT_MODEL_RENAMED, { scope: 'runtime', from: model, to: next })
    }
  } catch (error) {
    // 换不成也不影响使用（旧名今天仍然可调），别让它挡住启动
    addRuntimeEvent('warn', 'settings', 'Could not rename retired AI model names', { error: String(error) })
  }
}

/** 落盘列表 + 启用项，并把启用的那条同步进运行时四个键。所有写路径都必须走这里 */
export async function saveAiProfiles(state: AiProfileState): Promise<void> {
  const active = resolveActiveProfile(state.profiles, state.activeId)
  await Promise.all([
    setSetting(AI_PROFILES_KEY, state.profiles),
    setSetting(AI_ACTIVE_PROFILE_KEY, active?.id ?? ''),
  ])
  await syncRuntimeActive(active)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ai-profiles-changed'))
}
