// 「AI 供应商」页的数据模型与纯函数。
//
// 单独成文件的原因：这里每一条都曾经或可能悄悄漂移（默认值与示例不一致、密钥长度断言
// 过期、老数据迁移），而它们全都是纯逻辑，值得被测试锁住。组件只负责渲染与副作用。

/**
 * 供应商清单 —— 这是唯一的真相来源。
 *
 * 默认地址与候选模型原来另有三张表（DEFAULT_URLS / DEFAULT_MODELS / DEFAULT_MODEL_LISTS）
 * 声明在组件函数体里，于是同一个供应商在示例文字和默认值之间漂移过：
 * 千问的示例写 `qwen-plus` 而实际种进去的是 `qwen3.6-flash`，
 * MiMo 的示例写 `mimo-v2.5-pro` 而默认选中的是 `mimo-v2.5`。
 * 合并成一张表后，示例直接由 defaultModels[0] 派生，漂移不可能再发生。
 */
import { getLocale, t } from '@/i18n'

export interface AiProvider {
  value: string
  /**
   * 展示名。品牌名用官方英文写法（Qwen / Doubao (Volcengine Ark) / Xiaomi MiMo），
   * 不是直译 —— 中文语境习惯叫「通义千问」，所以它仍然要跟界面语言走。
   *
   * ⚠️ 表里几条用的是 **getter**，不是普通字符串字段。原因：这张表是模块级常量，
   * 普通字段会在模块加载那一刻把当时的语言固化下来，切语言后不再变。改成 getter
   * 就能保留 `.label` 这个读法 —— 二十多个调用点和三个测试文件都不用动。
   */
  label: string
  defaultUrl: string
  /** A blank URL uses the provider's default when saving. */
  urlOptional?: boolean
  /** 建议的模型，第一个作为新建时的默认值；同时作为表单里的快速选择 */
  defaultModels: string[]
  /** 不需要 API Key（目前只有本机 Ollama） */
  keyless?: boolean
  /** 申请密钥的控制台地址 */
  consoleUrl?: string
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    value: 'deepseek',
    label: 'DeepSeek',
    defaultUrl: 'https://api.deepseek.com',
    // 2026-09 起官方名字是 deepseek-flash（V4.1 Flash），旧名见 DEEPSEEK_RETIRED_MODELS
    defaultModels: ['deepseek-flash'],
    consoleUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    value: 'qwen',
    get label() { return t('aiProvider.qwen') },
    defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    defaultModels: ['qwen3.6-flash', 'qwen-plus'],
    consoleUrl: 'https://bailian.console.aliyun.com',
  },
  {
    value: 'doubao',
    get label() { return t('aiProvider.doubao') },
    defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModels: ['doubao-seed-2-0-lite-260215'],
    consoleUrl: 'https://console.volcengine.com/ark',
  },
  {
    value: 'mimo',
    get label() { return t('aiProvider.mimo') },
    defaultUrl: 'https://api.xiaomimimo.com/v1',
    defaultModels: ['mimo-v2.5', 'mimo-v2.5-pro'],
  },
  {
    value: 'zhipu',
    get label() { return t('aiProvider.zhipu') },
    /**
     * 版本段在 base 里是 `/v4`，不是 `/v1`（normalize_base_url 认得这个形状，会原样保留）。
     *
     * 之前没有这张卡，用户只能选「OpenAI 兼容」自己填地址，而这个地址**几乎必然填错**：
     * 智谱文档里出现的是完整端点 `.../v4/chat/completions`，照抄过来会被再拼一次；
     * 只填到 `.../api/paas` 又会被补成 `/api/paas/v1`。两种都是 404，用户看到的就是
     * 「智谱接不上」。做成内置卡之后没有可填错的余地。
     */
    defaultUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // glm-4.7-flash 在官方「免费模型」目录下（docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash），
    // 所以放第一位当默认值 —— 想白用的人开箱即可。
    defaultModels: ['glm-4.7-flash', 'glm-4.7'],
    consoleUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    value: 'groq',
    // 品牌名，中英文都写 Groq，不需要 locale 键（同 DeepSeek 的处理）
    label: 'Groq',
    // 末段已经是 /v1，normalize_base_url 会原样保留、不再追加版本段
    defaultUrl: 'https://api.groq.com/openai/v1',
    defaultModels: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    consoleUrl: 'https://console.groq.com/keys',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    defaultUrl: 'https://openrouter.ai/api/v1',
    urlOptional: true,
    defaultModels: ['deepseek/deepseek-v4.1-flash'],
    consoleUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    value: 'openai_compat',
    get label() { return t('aiProvider.openaiCompat') },
    defaultUrl: 'https://api.openai.com',
    defaultModels: ['gpt-4o-mini'],
  },
  {
    value: 'ollama',
    get label() { return t('aiProvider.ollama') },
    defaultUrl: 'http://127.0.0.1:11434',
    defaultModels: ['qwen2.5:7b'],
    keyless: true,
  },
]

/**
 * 新建服务时的地区默认；只影响还没选择过供应商的场景。
 * 英文默认 OpenRouter，与英文界面推荐的 DeepSeek V4.1 Flash（经 OpenRouter）一致；
 * 中文不跟：国内付款和访问 OpenRouter 都不方便，直连 DeepSeek 更合适。
 */
export function preferredAiProviderValue(): string {
  return getLocale() === 'en' ? 'openrouter' : 'deepseek'
}

/** 把地区默认那家排到最前，原数组顺序保持不变供迁移逻辑使用。 */
export function aiProvidersForDisplay(): AiProvider[] {
  const preferred = preferredAiProviderValue()
  if (AI_PROVIDERS[0]?.value === preferred) return AI_PROVIDERS
  return [
    ...AI_PROVIDERS.filter((provider) => provider.value === preferred),
    ...AI_PROVIDERS.filter((provider) => provider.value !== preferred),
  ]
}

export function findProvider(value: string): AiProvider {
  return AI_PROVIDERS.find((p) => p.value === value) ?? AI_PROVIDERS[0]
}

/** 每供应商独立存储的字段 */
export type AiSettingField = 'apiUrl' | 'apiKey' | 'model' | 'models' | 'latency'

/**
 * 每个供应商的配置键。
 *
 * 键名格式是历史约定（`cloudAi.<provider>.<field>`），**不能随意改**：
 * 改了等于用户已存的地址与密钥全部读不到，界面上看着像被清空了。
 * 另有一组不带 provider 的 `cloudAi.provider/apiUrl/apiKey/model`，
 * 那是运行时实际生效的"当前配置"，由本页在保存/切换时同步过去。
 */
export function aiSettingKey(provider: string, field: AiSettingField): string {
  return `cloudAi.${provider}.${field}`
}

export function providerLabel(value: string): string {
  return AI_PROVIDERS.find((p) => p.value === value)?.label ?? value
}

/**
 * 一条已配置的 AI 服务。
 *
 * 为什么是这个形状：原来的模型是「供应商」为主轴、模型只是它下面的一串字符串，
 * 而地址和密钥挂在供应商上。后果有两个：
 *   1. 两个不同端点的「OpenAI 兼容」模型（比如一个 OpenAI、一个本地 vLLM）没法各自
 *      配置——切了模型却还在用同一个地址和密钥，其中一个必然打不通；
 *   2. 想在 DeepSeek 和千问之间换一下，得走下拉、改地址、改密钥，等于重配一遍。
 * 把「供应商 + 地址 + 密钥 + 模型」打包成一条可命名的服务后，切换就是点一下列表。
 */
/**
 * 一次可用性检测的结果。
 *
 * 为什么不是单独存一个 latencyMs：那样界面上只能说出「多快」，说不出「行不行」。
 * 而用户按下这个按钮时想知道的第一件事是"这份配置能不能用"——密钥对不对、模型开通了没、
 * 网络通不通；耗时是可用之后的第二个维度（口述场景里确实重要，但它不是结论）。
 * 失败也要留痕：卡上必须能显示「不可用」，而不是停在「未测试」装作没事。
 */
export interface AiProfileCheck {
  ok: boolean
  /** 检测完成的时间戳。用来说"多久之前测的"——一次通过不等于此刻还通 */
  at?: number
  /** 成功时的一次往返耗时 */
  latencyMs?: number
  /** 失败时的一句话原因（已由 describeProviderError 归一化过） */
  reason?: string
}

export interface AiProfile {
  id: string
  provider: string
  apiUrl: string
  apiKey: string
  model: string
  /** 最近一次可用性检测。没有 = 还没测过 */
  check?: AiProfileCheck
}

export function makeProfileId(): string {
  return `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 新建一条服务时的初值 */
export function blankProfile(providerValue = preferredAiProviderValue()): AiProfile {
  const meta = findProvider(providerValue)
  return {
    id: makeProfileId(),
    provider: meta.value,
    apiUrl: meta.defaultUrl,
    apiKey: '',
    model: meta.defaultModels[0] ?? '',
  }
}

/**
 * 编辑框里换供应商时，密钥该变成什么。
 *
 * **密钥跟着地址走。** 原来的规则是「密钥框不空就绝不动」，为的是不覆盖用户自己粘的密钥。
 * 但「新建」会自动带上当前启用那家的地址和密钥：当前用的是智谱，新建出来就装着智谱的密钥，
 * 改选 DeepSeek 后地址和模型都换了，密钥却留着智谱那把 —— 测试只会报「密钥被拒绝」，
 * 用户还会把它当成 DeepSeek 的密钥复制到别处（2026-11 实测，0.1.8 起就这样）。
 *
 * 所以：
 *  - 密钥框空着 → 带上新供应商配过的那把（原来的行为）；
 *  - 地址换到了另一台服务器上，且密钥是上一家配置里存着的那把 → 换成新供应商配过的那把，
 *    新供应商没配过就清空。上一家的密钥在新服务器上不可能有效，清空至少会提示「缺密钥」；
 *  - 其余一律不动：密钥是用户自己粘的（哪份配置里都没有），或者地址没换
 *    （比如「OpenAI 兼容」填的就是 api.deepseek.com，换成 DeepSeek 卡后还是同一把能用的密钥）。
 *
 * `toUrl` 要传换完供应商之后的地址，`toSavedKey` 是新供应商最近一份配置的密钥（没有就是空串）。
 */
export function keyAfterProviderSwitch(input: {
  key: string
  fromProvider: string
  fromUrl: string
  toUrl: string
  toSavedKey: string
  profiles: AiProfile[]
}): string {
  const key = input.key.trim()
  if (!key) return input.toSavedKey
  const hostOf = (url: string): string => {
    try {
      return new URL(url.trim()).host.toLowerCase()
    } catch {
      return url.trim().toLowerCase()
    }
  }
  if (hostOf(input.fromUrl) === hostOf(input.toUrl)) return input.key
  const savedUnderPrevious = input.profiles.some(
    (p) => p.provider === input.fromProvider && p.apiKey.trim() === key,
  )
  return savedUnderPrevious ? input.toSavedKey : input.key
}

/**
 * 端点的主机名，且**只在它不是这家供应商的默认地址时**才返回，否则空串。
 *
 * 卡片上要不要显示地址，取决于它能不能区分两张卡：用 DeepSeek 官方地址的那张，
 * 写出 `api.deepseek.com` 只是重复"DeepSeek"这三个字；而两个都叫「OpenAI 兼容」的
 * 端点，主机名是唯一能把它们分开的东西——那正是旧结构根本存不下第二份的那个场景。
 * 只给主机名不给完整 URL：路径（/v1、/compatible-mode）在窄卡片里会挤掉模型名，
 * 完整地址在编辑弹窗里看。
 */
function profileCustomHost(profile: AiProfile): string {
  const hostOf = (url: string): string => {
    try {
      return new URL(url).host
    } catch {
      return url.trim()
    }
  }
  const host = hostOf(profile.apiUrl)
  const defaultHost = hostOf(findProvider(profile.provider).defaultUrl)
  return host && host !== defaultHost ? host : ''
}

/** 一条服务的一行式说法（供应商 · 主机名），用于读屏名称等只能给一串文字的地方 */
export function profileSubtitle(profile: AiProfile): string {
  const label = providerLabel(profile.provider)
  const host = profileCustomHost(profile)
  return host ? `${label} · ${host}` : label
}

/** 列表里一行的主标题。模型名就是标题；还没填的时候也得有字，否则那一行看着像坏了 */
export function profileTitle(profile: AiProfile): string {
  return profile.model.trim() || t('aiProvider.noModel')
}

/** 一条服务是否填齐了能用的东西 */
export function isProfileComplete(profile: AiProfile): boolean {
  if (!profile.apiUrl.trim() || !profile.model.trim()) return false
  if (!findProvider(profile.provider).keyless && !profile.apiKey.trim()) return false
  return true
}

/**
 * 把存储里读回来的东西还原成服务列表。
 *
 * 为什么要这么小心：这个值会经过配置导出/导入、用户手改数据库、以及将来版本的字段增减，
 * 任何一条脏数据都不该让整页白屏。所以规则是"能救的救、救不了的丢"，绝不抛异常。
 * id 重复同样要处理——单选和编辑都靠 id 定位，重复 id 会让你点 A 改到 B。
 */
export function parseProfiles(raw: unknown): AiProfile[] {
  if (!Array.isArray(raw)) return []
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const used = new Set<string>()
  const out: AiProfile[] = []

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const source = item as Record<string, unknown>

    let id = text(source.id).trim() || `recovered-${index}`
    while (used.has(id)) id = `${id}-${index}`
    used.add(id)

    out.push({
      id,
      provider: text(source.provider) || AI_PROVIDERS[0].value,
      apiUrl: text(source.apiUrl),
      apiKey: text(source.apiKey),
      model: text(source.model),
      check: parseCheck(source.check, source.latencyMs, finite),
    })
  })

  return out
}

/** 检测结果的容错解析。第二个参数是更早版本平铺在 profile 上的 latencyMs，只有测通才会写。 */
function parseCheck(
  raw: unknown,
  legacyLatency: unknown,
  finite: (value: unknown) => number | undefined,
): AiProfileCheck | undefined {
  if (raw && typeof raw === 'object') {
    const source = raw as Record<string, unknown>
    if (typeof source.ok === 'boolean') {
      const reason = typeof source.reason === 'string' ? source.reason.trim() : ''
      return {
        ok: source.ok,
        at: finite(source.at),
        latencyMs: finite(source.latencyMs),
        reason: reason || undefined,
      }
    }
  }
  const latency = finite(legacyLatency)
  return latency === undefined ? undefined : { ok: true, latencyMs: latency }
}

/** 当前启用的那条。id 失效（删掉了、导入的数据对不上）时回落到第一条，而不是"什么都没启用" */
export function resolveActiveProfile(profiles: AiProfile[], activeId: string): AiProfile | null {
  if (profiles.length === 0) return null
  return profiles.find((p) => p.id === activeId) ?? profiles[0]
}

/**
 * 检查 API Key 格式，返回提示文字（空字符串表示格式正常）。
 *
 * 只保留「几乎不会误报」的规则：粘贴时常带进来的空白字符，以及确定的前缀约定。
 * 原来还断言 DeepSeek / 通义千问「必须 35 位」、豆包「必须是 UUID」——供应商一改密钥
 * 长度，这里就开始对**合法**密钥报警，而用户看到警告的第一反应是去重新生成一个密钥。
 * 对合法密钥误报的代价高于漏报，所以长度断言去掉了。
 */
export function checkAiKeyFormat(provider: string, key: string): string {
  if (!key.trim()) return ''
  if (/\s/.test(key)) {
    return t('aiProvider.keyHasSpace')
  }
  if ((provider === 'deepseek' || provider === 'qwen') && !/^sk-/.test(key.trim())) {
    return t('aiProvider.keyPrefix', { provider: providerLabel(provider) })
  }
  return ''
}

/** 地址是否像个能用的 base URL。原来这里零校验，填错要等到测试失败才知道。 */
export function checkApiUrl(url: string): string {
  const u = url.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) {
    return t('aiProvider.urlNeedsScheme')
  }
  try {
    const parsed = new URL(u)
    if (!parsed.hostname) return t('aiProvider.urlInvalid')
  } catch {
    return t('aiProvider.urlInvalid')
  }
  return ''
}

/**
 * 从后端 detail 里取那句「回复: xxx」。
 *
 * detail 的完整内容是 `耗时/模型/发送/回复` 四行（见 ai_openai_compat.rs 的
 * test_connection），其中「发送」那行会把内部测试提示词
 * （`system="只回复「连接正常」四个字…"`）原样展示给用户——那是后端的调试信息，
 * 不该出现在成功提示里。这里只取「回复」，耗时和模型名走结构化字段。
 */
export function extractTestReply(detail?: string): string {
  const match = detail?.match(/^回复:\s*(.*)$/m) // i18n-allow: 匹配供应商返回的中文响应字段
  return match?.[1]?.trim() ?? ''
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * 延迟分档。
 *
 * 口述场景的判断标准和跑分不一样：用户松开热键站在原地等文字出现在光标处，
 * 一次往返超过 1 秒就已经能感觉到停顿，超过 2 秒基本没法用来干活。
 * 所以纯数字不够——1.4s 和 140ms 在界面上必须长得不一样。
 *
 * 分档只在"需要提醒"时才给词：够快的时候多一个「很快」是噪音，慢下来才值得占字。
 * 颜色只有 ok / warn 两档：红色在这一页已经被「不可用」占了，
 * 「能用但慢」不该和「根本用不了」撞成同一个颜色。
 */
export type LatencyTier = 'instant' | 'fast' | 'normal' | 'slow' | 'tooSlow'

export interface LatencyGrade {
  tier: LatencyTier
  /** 一个词的结论，和数字一起显示 */
  label: string
  /** ok = 放心用，warn = 能用但拖，bad = 不建议用 */
  tone: 'ok' | 'warn' | 'bad'
}

/** 分界值集中在这里，想调手感只改这一处 */
const LATENCY_THRESHOLDS = { instant: 200, fast: 500, normal: 1000, slow: 2000 } as const

export function gradeLatency(ms: number): LatencyGrade {
  if (ms < LATENCY_THRESHOLDS.instant) return { tier: 'instant', label: t('grade.instant'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.fast) return { tier: 'fast', label: t('grade.fast'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.normal) return { tier: 'normal', label: t('grade.normal'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.slow) return { tier: 'slow', label: t('grade.slow'), tone: 'warn' }
  return { tier: 'tooSlow', label: t('grade.tooSlow'), tone: 'bad' }
}

/**
 * 检测结论的保鲜期。
 *
 * 为什么需要这个：一次测通只是那一刻的事实。额度用光、密钥被吊销、模型下线、
 * 供应商限流都会让它悄悄失效，而界面上那枚绿色的「可用」会一直挂着，
 * 变成一句无限期的承诺——三天前测的绿灯，读起来和刚测的一模一样。
 * 过了保鲜期就把颜色收回中性：绿色只代表"刚刚验过，可以信"。
 */
export const CHECK_FRESH_MS = 24 * 60 * 60 * 1000

/** 结论还新鲜吗。没有时间戳的（更早版本迁移来的）一律当过期，重测一次就好了 */
export function isCheckFresh(check: AiProfileCheck | undefined, now = Date.now()): boolean {
  if (!check?.at) return false
  return now - check.at < CHECK_FRESH_MS
}

/**
 * 「多久之前测的」。
 *
 * 为什么要显示这个：一次测通不代表此刻还通（额度用光、密钥被吊销、模型下线都会变）。
 * 卡上那枚「可用」标签如果不说清是什么时候测的，就变成了一句无限期的承诺。
 * now 作为参数传入，纯函数好测。
 */
export function formatCheckedAt(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return t('time.justNow')
  // 用 Intl.RelativeTimeFormat 而不是自己拼字符串：英文的单复数（"1 minute ago"
  // vs "5 minutes ago"）没法用一条模板覆盖，而这是最容易被忽略、也最显业余的细节。
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return rtf.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  return rtf.format(-Math.floor(hours / 24), 'day')
}

// ── 老数据迁移 ────────────────────────────────────────────────────────────

/** 老结构：每个供应商一组配置，模型是一串逗号分隔的字符串 */
export interface LegacyProviderData {
  provider: string
  apiUrl: string
  apiKey: string
  /** 当时选中的模型 */
  model: string
  /** 候选模型列表 */
  models: string[]
  /** `model=ms,model=ms` 解析后的耗时表 */
  latencies: Record<string, number>
}

/**
 * 把 `model=ms,model=ms` 解析成表（老版本把整张延迟表存成一个字符串）。
 *
 * 只读不写：新结构把耗时放在每条服务的 latencyMs 上。损坏条目一律跳过——
 * 这只是给"哪个更快"排序用的展示数据，绝不该因为一条脏数据让迁移整体失败。
 */
export function parseLegacyLatencies(raw: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of raw.split(',')) {
    const [name, ms] = part.split('=')
    const value = Number(ms)
    if (name?.trim() && ms !== undefined && ms !== '' && Number.isFinite(value)) {
      out[name.trim()] = value
    }
  }
  return out
}

/**
 * 把老的「每供应商一组配置」摊平成服务列表。
 *
 * 规则：只迁移填齐了的（有地址、且有密钥或免密钥）；该供应商下的每个候选模型各成一条；
 * 老的「当前供应商 + 当前模型」成为启用项。老的存储键一律不删——降级回旧版本还能用，
 * 也不至于因为迁移出错就丢掉用户的密钥。
 */
export function migrateLegacyProfiles(
  legacy: LegacyProviderData[],
  activeProvider: string,
  activeModel: string,
): { profiles: AiProfile[]; activeId: string } {
  const profiles: AiProfile[] = []

  for (const entry of legacy) {
    const meta = findProvider(entry.provider)
    const url = entry.apiUrl.trim() || meta.defaultUrl
    if (!url) continue
    if (!meta.keyless && !entry.apiKey.trim()) continue

    // 候选列表 + 当时选中的，去重后各成一条
    const models = [...entry.models]
    if (entry.model && !models.includes(entry.model)) models.unshift(entry.model)
    const unique = models.map((m) => m.trim()).filter(Boolean).filter((m, i, a) => a.indexOf(m) === i)
    if (unique.length === 0) continue

    for (const model of unique) {
      const latencyMs = entry.latencies[model]
      profiles.push({
        // 迁移用确定性 id，方便排查，也保证重复迁移不会产生两份
        id: `legacy-${entry.provider}-${model}`,
        provider: entry.provider,
        apiUrl: url,
        apiKey: entry.apiKey,
        model,
        // 老版本只在测通之后才记耗时，所以有耗时就等于有过一次通过的检测；
        // 但那是什么时候测的没人知道，所以不写 at（界面上就不会声称"刚测过"）
        check: latencyMs === undefined ? undefined : { ok: true, latencyMs },
      })
    }
  }

  const matched = profiles.find((p) => p.provider === activeProvider && p.model === activeModel)
    ?? profiles.find((p) => p.provider === activeProvider)
    ?? profiles[0]

  return { profiles, activeId: matched?.id ?? '' }
}

// ── 已下线的模型名 ────────────────────────────────────────────────────────

/**
 * DeepSeek 已下线的模型名 → 接替它的那个。
 *
 * 2026-09-10 起 DeepSeek 只列 `deepseek-flash`（V4.1 Flash）和 `deepseek-v4-pro` 两个名字，
 * 旧名「暂时路由」到 deepseek-flash；`deepseek-chat` / `deepseek-reasoner` 更早，
 * 2026-04-24 就公告 7 月 24 日停用。2026-11 实测这几个旧名都还能调，响应里的 model
 * 字段都是 deepseek-flash；但哪天真停了，按旧默认配过 DeepSeek 的用户 AI 整理会直接报错。
 *
 * `deepseek-reasoner` 也换成 deepseek-flash，行为不变：我们对 DeepSeek 一律发
 * `thinking.type=disabled`，实测 reasoner 收到它同样不思考。
 */
const DEEPSEEK_RETIRED_MODELS: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
}

/**
 * 这条服务的模型名该换成什么（不用换就原样返回）。
 *
 * 只认 **DeepSeek 官方地址**，DeepSeek 卡和「OpenAI 兼容」卡都算。中转站、聚合网关上的
 * 模型名是对方定的，它们未必认 deepseek-flash，照改只会把一份能用的配置改坏。
 * DeepSeek 卡地址空着时按官方地址算（保存时会补上默认值）。
 */
export function upgradeRetiredAiModel(provider: string, apiUrl: string, model: string): string {
  if (provider !== 'deepseek' && provider !== 'openai_compat') return model
  const url = apiUrl.trim() || (provider === 'deepseek' ? findProvider('deepseek').defaultUrl : '')
  let hostname = ''
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return model
  }
  if (hostname !== 'api.deepseek.com') return model
  return DEEPSEEK_RETIRED_MODELS[model.trim().toLowerCase()] ?? model
}

/**
 * 把一组服务里已下线的模型名换掉。
 *
 * 换名会造出重复项：老版本的候选列表常常同时有 deepseek-chat 和 deepseek-v4-flash，
 * 换完都是 deepseek-flash、地址密钥也一样，列表里就多出两行一模一样的服务。
 * 所以**换名造出来的**重复项只留一条（`keepId` 那条优先，通常是启用中的那条），
 * 被并掉的 id → 留下的 id 交回给调用方，由它改写指向旧 id 的引用。
 * 换名之前就重复的不动：那是用户自己建的。
 */
export function upgradeRetiredAiModels(
  profiles: AiProfile[],
  keepId = '',
): { profiles: AiProfile[]; changed: boolean; mergedInto: Record<string, string> } {
  const renamed = new Set<string>()
  const upgraded = profiles.map((p) => {
    const model = upgradeRetiredAiModel(p.provider, p.apiUrl, p.model)
    if (model === p.model) return p
    renamed.add(p.id)
    return { ...p, model }
  })
  if (renamed.size === 0) return { profiles, changed: false, mergedInto: {} }

  const sameService = (a: AiProfile, b: AiProfile) =>
    a.provider === b.provider
    && a.apiUrl.trim() === b.apiUrl.trim()
    && a.apiKey.trim() === b.apiKey.trim()
    && a.model === b.model
  const mergedInto: Record<string, string> = {}
  const out: AiProfile[] = []
  for (const p of upgraded) {
    const at = out.findIndex((q) => sameService(q, p) && (renamed.has(p.id) || renamed.has(q.id)))
    if (at < 0) {
      out.push(p)
    } else if (p.id === keepId) {
      // 留启用中的那条，占先来那条的位置，列表顺序不变
      mergedInto[out[at].id] = p.id
      out[at] = p
    } else {
      mergedInto[p.id] = out[at].id
    }
  }
  // 先并进 A、A 又被 keepId 顶掉的，要一路追到最后留下的那条
  for (const id of Object.keys(mergedInto)) {
    let target = mergedInto[id]
    while (mergedInto[target]) target = mergedInto[target]
    mergedInto[id] = target
  }
  return { profiles: out, changed: true, mergedInto }
}
