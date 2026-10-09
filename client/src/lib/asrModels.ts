/**
 * ASR 供应商 key → 实际模型 ID 映射
 */

const QWEN_OMNI_MODEL_MAP: Record<string, string> = {
  qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
  // 这两个旧运行时键原来指向 qwen3-omni-flash-realtime / qwen-omni-turbo-realtime。
  // 2026-09-23 实测那两个端点已被百炼缩容（读超时 / 「system capacity limits」），
  // 所以改指向同族还活着的 flash。**不能只是删掉这两行** —— 删了以后
  // resolveQwenOmniModel 返回 undefined、extra.model 不带值，后端会用它自己的
  // 默认模型，等于把落点交给另一处代码去定，两边一漂就查不出来。
  // 落点要和 asrProviderCatalog 的 RETIRED_MODELS / LEGACY_PROVIDERS 一致。
  qwen_omni_flash: 'qwen3.5-omni-flash-realtime',
  qwen_omni_turbo: 'qwen3.5-omni-flash-realtime',
}

/** 判断是否为 Qwen Omni 系列模型 */
export function isQwenOmniProvider(provider: string): boolean {
  return provider.startsWith('qwen_omni')
}

/** 根据供应商 key 解析 Qwen Omni 模型 ID，非 Omni 返回 undefined */
export function resolveQwenOmniModel(provider: string): string | undefined {
  return QWEN_OMNI_MODEL_MAP[provider]
}

/** ASR 供应商 key → 显示用的**默认**模型 ID（用户可能选了同平台的另一个） */
const ASR_DISPLAY_MODEL_MAP: Record<string, string> = {
  doubao_v2: 'Doubao-Seed-ASR-2.0',
  qwen: 'qwen3-asr-flash',
  qwen_realtime: 'qwen3-asr-flash-realtime',
  // 3.0 与 3.1 共用 `qwen_audio_stream` 这个运行时键，所以这里只能给一个**默认**值。
  // 跟着目录的默认项走（3.1）；用户选了 3.0 时由 selectedModel 覆盖，
  // 那条路才是准的 —— 这也正是 resolveAsrDisplayModel 要收 selectedModel 的原因。
  qwen_audio_stream: 'qwen-audio-3.1-asr-flash-streaming',
  mimo: 'mimo-v2.5-asr',
  groq_whisper: 'whisper-large-v3-turbo',
  openai_transcribe: 'gpt-transcribe',
  openai_live_transcribe: 'gpt-live-transcribe',
  gemini_transcribe: 'gemini-3.5-transcribe',
  gemini_live_transcribe: 'gemini-3.5-transcribe-live',
  openrouter_transcribe: 'openai/gpt-transcribe',
  ...QWEN_OMNI_MODEL_MAP,
}

/**
 * 将内部供应商 key 映射为显示用的模型名称。
 *
 * `selectedModel` 传的是运行时键 `cloudAsr.model`（用户在服务配置里选的那个）。
 * 只有 Groq / OpenAI 这类同协议多模型的服务会有值，其余一律走上面的默认表 ——
 * 不接这个参数的话，诊断和测试结果里显示的模型会和真正发出去的那个不是一个。
 */
export function resolveAsrDisplayModel(providerKey: string, selectedModel?: string): string {
  const picked = selectedModel?.trim()
  if (picked) return picked
  return ASR_DISPLAY_MODEL_MAP[providerKey] || providerKey || 'unknown'
}

/**
 * asr_config.extra 里我们会用到的字段。
 *
 * 继承 Record 是为了能直接赋给 `AsrProviderConfig.extra`（那边声明的是任意键值，
 * 因为每家供应商往里放的东西不同）。这里把用得上的两个字段显式列出来，
 * 好让拼错字段名当场报错，而不是静默变成一个后端读不到的键。
 */
export interface AsrConfigExtra extends Record<string, unknown> {
  model?: string
  instructions?: string
  /** 自定义端点地址。空 = 用实现里内置的官方地址 */
  baseUrl?: string
  /**
   * 「OpenAI 兼容」那张卡说哪种协议：`transcriptions` / `chat` / `chat_standard`。
   * 不带这个字段 = 让 Rust 侧自己探测（默认的 `auto` 就不往下传）。
   */
  protocol?: string
}

/**
 * 组 `asr_config.extra` —— 「这次用哪个模型」的唯一出处。
 *
 * 四个地方要组 asr_config（录音主链路、历史重跑、设置页识别测试、诊断页测试），
 * 以前每处都自己拼一遍 extra，于是加一个「可选模型」就得改四处、还容易漏掉一处 ——
 * 漏掉的那处会静默用回默认模型，而用户以为自己换了。
 *
 * ⚠️ 这里**不再**根据 provider 去反查 Omni 的模型名。改成「一张卡 = 一个平台」之后，
 * 模型由 `resolveAsrApiModel` 解析好再传进来，而运行时 provider 变成了 `qwen_omni`
 * 这个平台级的值 —— 老代码拿它去查 QWEN_OMNI_MODEL_MAP 查不到，于是
 * `extra.model` 是 undefined，后端回落到自己的默认模型。表现是**下拉里选哪个
 * Omni 都跑同一个**（都变成 qwen3-omni-flash-realtime），而界面显示得一切正常。
 * 老表只作为存量运行时键的兜底保留（那时 provider 还是 `qwen_omni_35_plus` 这类）。
 */
export function buildAsrExtra(
  provider: string,
  options: {
    model?: string
    instructions?: string
    baseUrl?: string
    protocol?: string
  } = {},
): AsrConfigExtra | undefined {
  const model = options.model?.trim() || resolveQwenOmniModel(provider) || ''
  const instructions = options.instructions?.trim() ?? ''
  const baseUrl = options.baseUrl?.trim() ?? ''
  // `auto` 不往下传：Rust 侧「没有这个字段」和「auto」是同一个意思，
  // 少传一个字段就少一处两边要对齐的约定。
  const protocol = options.protocol?.trim() ?? ''
  const explicitProtocol = protocol === 'auto' ? '' : protocol
  if (!model && !instructions && !baseUrl && !explicitProtocol) return undefined
  return {
    ...(model ? { model } : {}),
    ...(instructions ? { instructions } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(explicitProtocol ? { protocol: explicitProtocol } : {}),
  }
}

/**
 * 有流式实现的供应商（不含运行时前置条件）。
 *
 * 注意 qwen3-asr-flash（`qwen`）与 `openai_transcribe` / `gemini_transcribe` 都是
 * 一次性 HTTP 模型，不在此列 —— 它们对应的流式版本是各自单独的一张卡。
 */
const STREAMING_CAPABLE = new Set([
  'doubao_v2',
  'qwen_realtime',
  'qwen_audio_stream',
  'openai_live_transcribe',
  'gemini_live_transcribe',
])

export function isStreamingDisplayCapable(provider: string): boolean {
  return STREAMING_CAPABLE.has(provider)
}

/**
 * 判断当前配置下「流式实时显示」是否真正就绪可用（含运行时前置条件）。
 *
 * **这是运行时唯一的闸门**（CloudAPIProvider 拿它决定走不走 WebSocket），
 * 光在服务目录里给一条加 `streaming: true` 是没有任何效果的。
 *
 * - doubao_v2：直接可用（需在火山开通「流式语音识别 2.0」，运行时由服务端校验）。
 * - qwen_audio_stream（qwen-audio-3.1 / 3.0-asr-flash-streaming）：直接可用。这两代
 *   **都不需要 WorkspaceId** —— 通用域名 dashscope.aliyuncs.com 实测可用，
 *   别照抄下面那条的前置条件（见 providers/asr_qwen_audio_stream.rs 文件头的实测记录）。
 * - qwen_realtime（qwen3-asr-flash-realtime）：走地域专属实时端点，必须提供北京业务空间 WorkspaceId 才可用。
 * - openai_live_transcribe / gemini_live_transcribe：填了密钥就能用，没有额外前置条件。
 * - qwen（qwen3-asr-flash）：非实时模型，不支持实时字幕。
 */
export function isStreamingDisplayReady(provider: string, qwenWorkspaceId?: string): boolean {
  if (provider === 'qwen_realtime') {
    return Boolean(qwenWorkspaceId && qwenWorkspaceId.trim())
  }
  return isStreamingDisplayCapable(provider)
}

// ─────────────────────────── 热词能力 ───────────────────────────
//
// 声明在 Rust（providers/capabilities.rs），这里只做「五档 → 界面要说的话」的折叠。
// **前端刻意不再自己维护一份「哪家支持热词」的清单** —— 那正是 issue #67 的成因：
// 实现在 Rust、声明在前端一张手写表格，两者无人对账，结果 6 家云服务被漏掉。

/** Rust `HotwordDelivery` 的序列化形态。新增档位时 TS 这边会因为穷尽检查报错。 */
export type HotwordDelivery =
  | 'vocabulary'
  | 'context'
  | 'instruction'
  | 'protocol_has_no_slot'
  | 'not_wired_up'
  | 'undecided_protocol'
  | 'unknown_provider'

/** Rust `AsrHotwordCapability` 的序列化形态。 */
export interface AsrHotwordCapability {
  /** 走流式路径时的行为 */
  streaming: HotwordDelivery
  /** 走一次性路径时的行为，也是流式回落后的实际行为 */
  buffered: HotwordDelivery
  /** 这家有没有流式实现；为假时上面两个字段相同 */
  hasStreamingPath: boolean
  /** **SayIt 自设**的最多发送条数（走流式路径时），不是服务端限制 */
  streamingClientCap: number | null
  /** 同上，走一次性路径（含流式回落）时的那份 */
  bufferedClientCap: number | null
}

/**
 * 界面上要对用户说的那件事。
 *
 * 五档折成三种是因为用户在热词页只想知道一件事：我配的热词现在有用吗。
 * `vocabulary` / `context` / `instruction` 对他的**行动**没有区别（都是"配了有帮助、
 * 不保证命中"），只有不进请求那几档需要他去做别的事。五档的差别留给日志和文档。
 *
 * 三种而不是两种：`undecided` 那档不能归进任何一边 —— 「OpenAI 兼容」的 auto 协议
 * 探测之前，说"生效"和说"不生效"都是在编。
 */
export type HotwordUiState = 'sent' | 'not_sent' | 'undecided'

export function foldHotwordDelivery(delivery: HotwordDelivery): HotwordUiState {
  switch (delivery) {
    case 'vocabulary':
    case 'context':
    case 'instruction':
      return 'sent'
    case 'undecided_protocol':
      return 'undecided'
    case 'protocol_has_no_slot':
    case 'not_wired_up':
      return 'not_sent'
    // 声明缺失。**不能当成 'not_sent'** —— 那会把"我们漏了声明"显示成
    // "这家不支持热词"，用错误的确定性盖住一个 bug。归入 undecided：
    // 界面会说"未确定"，而 Rust 侧的测试会在漏声明时直接红。
    case 'unknown_provider':
      return 'undecided'
  }
}

/**
 * 「未确定」的三种成因。展示状态共用，**给用户的说明必须分开**。
 *
 * 折成同一个 `undecided` 是对的（三种都不能说"生效"或"不生效"），但原来三种都套用
 * 同一句文案「等第一次识别或测试连接之后才能确定」—— 那句话只对 `protocol` 成立。
 * 另两种再录一百次也不会变：
 *   · `declaration_missing`：Rust 返回 `unknown_provider`，是 SayIt 漏了声明（bug），
 *     该让用户知道这不是他的配置问题、可以反馈；
 *   · `query_failed`：命令本身没调通（旧版本二进制没有这个命令、IPC 异常），
 *     该提示重启或更新。
 * 告诉用户"再录一次就知道了"而实际永远不会变，是在把一个可指认的故障说成正常等待。
 */
export type HotwordUndecidedReason = 'protocol' | 'declaration_missing' | 'query_failed'

/** 这个档位落进「未确定」的原因；不是未确定则返回 null。 */
export function hotwordUndecidedReason(delivery: HotwordDelivery): HotwordUndecidedReason | null {
  switch (delivery) {
    case 'undecided_protocol':
      return 'protocol'
    case 'unknown_provider':
      return 'declaration_missing'
    default:
      return null
  }
}

/**
 * 本次录音**实际**会走哪条路径 —— 热词能力只能按它判断，不能按 provider 一概而论。
 *
 * 现场证据是这两家的行为在两条路径上相反：
 *   · `openai_live_transcribe` 流式有 keywords、回落到文件端点后一条都不传
 *   · `gemini_live_transcribe` 流式一条都不传、回落到文件转写反而会拼进 prompt
 *
 * 所以设置页展示的是**配置预期**（按当前开关算出来的那条路），而真正走了哪条要看
 * 日志 —— 没开字幕、配置没就绪、或者建连失败都会回落（见 CloudAPIProvider 的
 * tryStartRealtimeStream）。
 */
export interface HotwordPathOptions {
  streamingDisplayEnabled: boolean
  provider: string
  qwenWorkspaceId?: string
}

/**
 * 这次会走流式还是一次性路径。
 *
 * **只有这一处判断。** delivery 和条数上限都得按同一条路径取值，各判一次就会漂
 * —— 上限曾经按 provider 取一个数，于是 OpenAI live 关掉字幕时同时显示
 * 「不发送」和「最多发送 100 个」。
 */
export function willUseStreamingPath(
  capability: AsrHotwordCapability,
  opts: HotwordPathOptions,
): boolean {
  if (!capability.hasStreamingPath) return false
  return opts.streamingDisplayEnabled
    && isStreamingDisplayReady(opts.provider, opts.qwenWorkspaceId)
}

export function expectedHotwordDelivery(
  capability: AsrHotwordCapability,
  opts: HotwordPathOptions,
): HotwordDelivery {
  return willUseStreamingPath(capability, opts) ? capability.streaming : capability.buffered
}

/**
 * 这条路径上的发送条数上限，没有则为 null。
 *
 * 必须和 `expectedHotwordDelivery` 走同一个路径判断 —— 两家 live 供应商的上限只存在
 * 于其中一条路上（OpenAI 在流式、Gemini 在回落），取错一条界面就会自相矛盾。
 */
export function expectedClientCap(
  capability: AsrHotwordCapability,
  opts: HotwordPathOptions,
): number | null {
  return willUseStreamingPath(capability, opts)
    ? capability.streamingClientCap
    : capability.bufferedClientCap
}

/**
 * 回落会不会改变热词行为。为真时界面要说明"这取决于实时字幕能否连上"，
 * 否则用户看到的结论会在建连失败那次悄悄失效。
 */
export function hotwordDependsOnStreamingPath(capability: AsrHotwordCapability): boolean {
  return capability.hasStreamingPath
    && foldHotwordDelivery(capability.streaming) !== foldHotwordDelivery(capability.buffered)
}
