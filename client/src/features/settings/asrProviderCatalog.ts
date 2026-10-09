// 云 API 语音识别的供应商目录、服务档案（profile）解析与延迟分档。
//
// 结构与「AI 服务」页对齐：一张卡 = 一份完整配置（供应商 + 该平台的凭据），可以存多份，
// 同一家也能存多份（比如两个百炼账号、两套豆包密钥）。启用哪一份由 activeProfileId 决定。
//
// 和 AI 服务的唯一实质差别：供应商只能从内置清单里选，不能填任意地址 —— 每家 ASR 的
// 协议都要一份专门的 Rust 实现（asr_doubao / asr_qwen / asr_qwen_omni / asr_mimo），
// 不像 AI 整理那边只要是 OpenAI 兼容端点就能接。
//
// 「同平台重复粘密钥」的问题不靠"按平台存"解决（那样一张卡就不再是一份完整配置了），
// 而是照 AI 服务的做法：新建时若该平台已有配置，自动把密钥带过来，界面上说明它从哪来。

import {
  describeDoubaoMissing,
  effectiveDoubaoCredentials,
  type DoubaoConsole,
  type DoubaoCredentials,
} from '@/lib/cloudAsrCreds'

/** 凭据归属的平台。同平台的服务用同一种密钥形态。 */
import { t } from '@/i18n'

export type AsrPlatform =
  | 'doubao' | 'qwen' | 'mimo' | 'groq' | 'openai' | 'google' | 'openrouter'
  // 这个不是「一家服务商」，而是「一类协议」：地址由用户填，对面是谁我们不知道。
  | 'openai_compat'

export interface AsrPlatformInfo {
  label: string
  /** 去哪儿领密钥 */
  consoleUrl: string
}

// label 用 getter：这是模块级常量，普通字段会把加载那一刻的语言固化下来。
// 见 aiProviderCatalog.ts 里 AiProvider.label 的注释。
export const ASR_PLATFORMS: Record<AsrPlatform, AsrPlatformInfo> = {
  doubao: { get label() { return t('asrPlatform.doubao') }, consoleUrl: 'https://console.volcengine.com/speech/app' },
  qwen: { get label() { return t('asrPlatform.qwen') }, consoleUrl: 'https://bailian.console.aliyun.com' },
  mimo: { get label() { return t('asrPlatform.mimo') }, consoleUrl: 'https://xiaoai.mi.com' },
  groq: { label: 'Groq', consoleUrl: 'https://console.groq.com/keys' },
  openai: { label: 'OpenAI', consoleUrl: 'https://platform.openai.com/api-keys' },
  // Gemini API 的 key 在 AI Studio 领，不是 Google Cloud 控制台 —— 后者那套
  // （项目 + 服务账号 + OAuth）我们刻意没接，见 providers/asr_gemini.rs 的文件头。
  google: { label: 'Google Gemini', consoleUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', consoleUrl: 'https://openrouter.ai/keys' },
  // consoleUrl 指向协议文档而不是某家控制台 —— 密钥去哪儿领取决于用户对接的是谁，
  // 我们给不出那个链接，能给的是「这条协议长什么样」。
  openai_compat: {
    get label() { return t('asrPlatform.openaiCompat') },
    consoleUrl: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
  },
}

/**
 * 「OpenAI 兼容」那张卡实际说哪种协议。
 *
 * 这两套协议都被叫做「OpenAI 兼容」，但地址、请求体、响应形状完全不同：
 *   · `transcriptions` → `/audio/transcriptions`，multipart 传文件，响应 `{"text": ...}`。
 *     OpenAI 自己、Groq、硅基流动、whisper.cpp / faster-whisper / FunASR 的包装都是这套。
 *   · `chat`           → `/chat/completions`，阿里云百炼 data URL 字符串。
 *   · `chat_standard`  → `/chat/completions`，标准 OpenAI `input_audio.data`（裸 base64）
 *     与 `input_audio.format`。兼容 Gemini 等使用标准 OpenAI 格式的网关。
 *
 * **默认是 `auto`，让代码自己试出来。** 协议是端点的属性、不是用户的偏好 ——
 * 要用户先去翻对方文档才知道该选哪个，等于把我们的实现细节推给他承担。
 * 显式值留作退路：探测判不准时（比如填的模型名只在其中一种协议下有效，
 * 另一种的失败就不是协议原因）用户得能直接指定。
 */
export type AsrCompatProtocol = 'auto' | 'transcriptions' | 'chat' | 'chat_standard'

export const ASR_COMPAT_PROTOCOLS: AsrCompatProtocol[] = ['auto', 'transcriptions', 'chat', 'chat_standard']

export function parseAsrCompatProtocol(value: unknown): AsrCompatProtocol {
  return value === 'transcriptions' || value === 'chat' || value === 'chat_standard' ? value : 'auto'
}

/**
 * 一家平台下的一个可选模型。
 *
 * **关键在 `provider`：同一张卡里的模型可以走完全不同的后端实现。**
 * 千问那五个就是四种协议（DashScope duplex / HTTP 一次性 / OpenAI-Realtime 风格 /
 * chat+base64），OpenAI 与 Gemini 也各是「HTTP 一次性」加「WebSocket 流式」两种。
 *
 * 这个字段的存在就是为了让「界面按平台归拢」和「后端按协议分发」两件事同时成立 ——
 * 早先的做法是一个模型占一张卡（`qwen_audio_stream`、`qwen_realtime`… 各一张），
 * 界面上千问一家占了五张卡，用户得先知道协议差异才能选。
 */
export interface AsrModelOption {
  /**
   * 存进 `profile.model`，也是下拉里的值。同一张卡内唯一。
   * 用真实模型名（不是内部代号），这样用户在下拉里看到的和服务商文档里写的是一个东西。
   */
  id: string
  /** 走哪份后端实现 —— 即 Rust `registry.rs` 分发用的 key，会写进 `cloudAsr.provider` */
  provider: string
  /**
   * 实际发给服务端的模型名，缺省等于 `id`。
   *
   * 目前只有 Omni 那两个用得上：它们的接口模型名带 `-realtime` 后缀
   * （`qwen3.5-omni-plus-realtime`），而产品名是不带的。以前这层映射在
   * asrModels.ts 的 QWEN_OMNI_MODEL_MAP 里按 provider id 索引，现在跟着模型走。
   */
  apiModel?: string
  // ⚠️ 这里刻意**没有** label 字段。
  //
  // 曾经有过，值是「千问 ASR 一次性」「千问 3.5 Omni Plus」这种 —— 那是
  // 「一张卡 = 一个模型」时代的**卡片标题**，「一次性」靠跟「流式」那张卡对比才有意义。
  // 归拢成一卡一平台后它们成了卡内的模型名，于是「千问」前缀重复、对比对象也消失了，
  // 用户在「模型」那一栏看到的是一个既不像模型、也说不清是什么的词（用户原话：
  // 「还有什么『千问一次性』…下面不是应该显示模型吗」）。
  //
  // 现在一律显示真实模型 ID：它一眼认得出是模型，还能拿去对服务商文档和账单。
  // 「这个模型什么时候该选」交给 blurb 说，那本来就是它的活。
  /**
   * 一句话说清「什么时候选这个模型」，显示在模型下拉下面。
   *
   * 平台卡的 blurb 只能说这一家整体如何，而真正要帮用户做的决定是**在一家里面选哪个**
   * （千问那五个的差别比千问和豆包的差别还大）。所以这些文案留在模型级。
   */
  blurb?: string
  /** 边说边出字（实时字幕）。**这是模型的属性，不是平台的** */
  streaming?: boolean
  /** 识别与 AI 整理一步完成，不需要单独配 AI 服务 */
  omni?: boolean
  /** 需要百炼「业务空间 ID」才能用 */
  needsWorkspaceId?: boolean
  /**
   * 这个模型的地址可以由用户覆盖（填了就用他的，空着就用实现里内置的官方地址）。
   *
   * **这是协议的属性，不是平台的属性** —— 所以它挂在模型上而不是卡片上。
   * 千问那张卡里 `qwen3.8-omni-flash` 是 HTTP（能改），`qwen3.5-omni-plus` 是
   * realtime WebSocket（改不了）：同一张卡里两种答案，挂在卡片上就表达不了。
   *
   * 为什么内置卡也要开放：中转站/反代很常见（尤其 OpenAI 和 Gemini），
   * 用户拿的是官方协议、只是换了个域名。不给填就等于逼他们用不了。
   *
   * 安全边界靠两件事守住，缺一不可：
   *  1. 这个标记为假的模型，`asrEndpointUrl` 一律返回空串 —— 档案里即使残留了
   *     地址也发不出去（切过供应商就会留下残值）；
   *  2. WebSocket 那几份实现压根不读 `extra.baseUrl`。
   */
  supportsCustomUrl?: boolean
  /** 地址是必填的（协议卡），不是可选覆盖 */
  requiresCustomUrl?: boolean
}

export interface AsrProviderEntry {
  /**
   * 卡片 id，存进 `profile.provider`。**一张卡 = 一个平台**，所以它等于 `platform`。
   *
   * ⚠️ 它不再是 Rust 侧的分发 key —— 那个现在由选中模型的 `provider` 决定。
   * 存量配置里 `profile.provider` 存的是旧的分发 key（`qwen_audio_stream` 之类），
   * 由 parseAsrProfiles 迁移过来，见 LEGACY_PROVIDERS。
   */
  id: string
  /** 卡片标题，短 */
  label: string
  platform: AsrPlatform
  /** 一句定位，说清「什么时候选这家」 */
  blurb: string
  /**
   * 当前内置端点与控制台所面向的账号地区。
   * `global` 是海外端点，国内直连可能不稳定，卡片上要如实标出来 ——
   * 否则用户会把「连不上」当成自己密钥填错。
   */
  availability: 'mainland_china' | 'global'
  /** 这家有哪些模型。**第一项是默认**（新建配置时选它） */
  models: AsrModelOption[]
  /**
   * 这是「协议卡」：对面是谁我们不知道，地址必填、模型名是自由文本。
   *
   * 两处与内置卡不同：
   *  · 地址为空时这张卡不算配置完整（内置卡地址是可选的，空着就用官方地址）；
   *  · 模型名**自由文本**而不是下拉 —— 对面挂什么模型无从知道，
   *    `models` 只当推荐值用，用户填的值必须原样保留（见 resolveAsrModelOption）。
   *
   * ⚠️ 「能不能改地址」**不由这个字段决定**，那是模型级的 `supportsCustomUrl` ——
   * 理由见那边的注释。
   */
  customEndpoint?: boolean
  /** 「接口地址」输入框的占位示例 */
  urlPlaceholder?: string
}

/**
 * OpenRouter 上的全部转写模型（拉取自 `/api/v1/models?output_modalities=transcription`，
 * 2026-09-16，共 21 个）。
 *
 * **这些 slug 是从那个接口原样抄下来的，不是照模型页的展示名推的。**
 * 展示名和 slug 经常不是一回事（"Whisper Large V3 Turbo" 的 slug 是
 * `openai/whisper-large-v3-turbo`，但 "Grok STT 1.0" 是 `x-ai/grok-stt-1.0`、
 * "Qwen3 ASR Flash" 带日期后缀 `qwen/qwen3-asr-flash-2026-02-10`）。
 * 猜错的表现是 404 "model not found" —— 看着像模型下线了，其实是名字写错。
 * 那个接口**不需要密钥**，要更新清单直接跑：
 *   `python dev-scripts/probe_new_asr_providers.py --target openrouter --list-models`
 *
 * ── 排序按「什么时候选它」，不按厂商也不按价格 ──
 * 第一项是默认值（resolveAsrModel 在用户没选过时给它），所以第一项必须是
 * 「不知道选什么就用这个」那一个。往后依次是：中文口述、多语种、便宜、其余。
 *
 * ── 有一类要特别说明：Whisper 系在这里可能没有中文标点 ──
 * OpenRouter 的两种请求形态都没有 prompt 通道（它接受 prompt 字段但忽略），
 * 而 Whisper 全靠「拿带标点的句子做示范」才会输出标点。所以 whisper-* 这几个
 * 转写中文短句可能一个标点都没有，排在自带标点的那些后面。
 * 详见 providers/asr_openrouter.rs 的文件头。
 */
const OPENROUTER_SLUGS = [
  // 默认：自带标点、准确率第一档
  'openai/gpt-transcribe',
  // 中文口述优先：qwen 这几个覆盖 30 语言 + 22 种中文方言，而且便宜
  'qwen/qwen3-asr-flash-2026-02-10',
  'qwen/qwen3-asr-1.7b',
  'qwen/qwen3-asr-0.6b',
  // 多语种最强的几个：mai-transcribe-2 是 FLEURS 榜首（60 语言），chirp-3 自带标点
  'microsoft/mai-transcribe-2',
  'google/chirp-3',
  'microsoft/mai-transcribe-1.5',
  // OpenAI 其余几代（token 计费的两个更透明，whisper 系按时长）
  'openai/gpt-4o-transcribe',
  'openai/gpt-4o-mini-transcribe',
  'openai/whisper-large-v3-turbo',
  'openai/whisper-large-v3',
  'openai/whisper-1',
  // 其余厂商
  'deepgram/nova-3',
  'meta/muse-voice-transcribe-1.0',
  'x-ai/grok-stt-1.0',
  'mistralai/voxtral-mini-transcribe',
  'mistralai/voxtral-small-24b-2507-stt',
  'mistralai/voxtral-mini-3b-2507',
  'nvidia/parakeet-tdt-0.6b-v3',
  'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b',
  'fish-audio/transcribe-1',
]

/** 这 21 个都走同一份实现（asr_openrouter.rs），只换 model 字符串。 */
const OPENROUTER_MODELS: AsrModelOption[] = OPENROUTER_SLUGS.map((id) => ({
  id,
  provider: 'openrouter_transcribe',
  // OpenRouter 本身就是路由层，改地址的用处不大，但它是 HTTP 协议、
  // 自建反代也有人用，没有理由单独禁掉。
  supportsCustomUrl: true,
}))

/**
 * 内置服务清单。顺序即卡片顺序，也是新建时下拉的顺序：把最推荐的放前面。
 *
 * label 刻意不带模型名后缀（模型名单独一行小字），否则卡片标题会被
 * 「千问 3.5 Omni Plus（qwen3.5-omni-plus，ASR+AI）」这种括号串撑爆。
 *
 * ── blurb 的口径（改文案前先读这段）──
 * 每条只回答一件事：**什么时候该选它**，而且七条放在一起要能相互区分。
 * 早期的文案是各写各的优点（「准确率高、速度快」同时挂在两家上），等于没给出
 * 选择依据 —— 用户看完还是不知道该点哪一张。现在的口径：
 *   · 准确率的结论是**有条件的**，条件要写出来。豆包只有在**关掉实时字幕**时
 *     才是中文最准的一档，一开字幕就掉档；Audio 3.0 反过来，开着字幕也是第一档。
 *     少了这个前提，两张卡的「最准」会互相矛盾。
 *   · 不如别家的地方照实写（千问 realtime 不及 Audio 3.0、MiMo 准确率一般），
 *     但用词留余地 —— 目录里留着它们是因为有人的账号/网络只有那一家能用。
 *   · 引用别的卡一律用**产品名**（"Audio 3.0"、"Omni Plus"），不要用「上面那个」
 *     「同上」：顺序会变，位置指代改一次顺序就错。
 *   · 这些准确率结论来自实际使用对比，不是跑分。改结论前先真用一遍。
 */
export const ASR_PROVIDERS: AsrProviderEntry[] = [
  {
    id: 'doubao',
    get label() { return t('asrProvider.doubao') },
    platform: 'doubao',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.doubaoBlurb') },
    models: [
      {
        id: 'Doubao-Seed-ASR-2.0',
        provider: 'doubao_v2',
        // 它一直支持实时字幕（走火山流式语音识别 2.0，isStreamingDisplayReady 认它）。
        // blurb 里"不开字幕时最准"是产品建议，不代表它没有这个能力。
        streaming: true,
      },
    ],
  },
  /**
   * 千问一家八个模型，**四种不同协议** —— 这张卡是 AsrModelOption.provider
   * 存在的原因。以前它们各占一张卡，界面上千问一家就是五张，用户得先懂协议差异
   * 才知道该点哪张。
   *
   * 模型顺序即推荐顺序，第一个是默认：
   *   · Audio 3.1 流式放第一 —— 最新一代，实测与 3.0 同协议、同节奏但延迟略低；
   *     开着实时字幕时这一族比豆包更准（豆包最准的用法是关掉字幕，一开就掉一档），
   *     而且不需要业务空间 ID，填了密钥就能用；
   *   · Audio 3.0 流式留作退路 —— 仍完全可用，给「3.1 上有问题」的人一个落脚点；
   *   · qwen3-asr-flash 是录完一次性出字，多语种均衡；
   *   · realtime 那个效果不及 Audio 3.x，还要业务空间 ID，所以排在后面；
   *   · 四个 Omni 是「识别+整理」一体，选它们就不用再配 AI 服务。3.8 那两个是
   *     同一代的两条协议（HTTP / realtime WS），不是新旧关系。
   *
   * ── 这里**不放**哪些百炼模型，以及为什么（2026-09-23 实测，见 dev-scripts）──
   *  · `qwen3-omni-flash` / `qwen-omni-turbo`：已从清单里删掉。官网标了「即将下线」，
   *    而且**实测已经在被缩容** —— 前者读超时，后者直接回
   *    「Too many requests ... system capacity limits」。百炼的下线机制是先逐步压
   *    QPM/TPM 再正式下线，所以这两个的表现不是偶发抖动。存量配置的落点见
   *    RETIRED_MODELS。
   *  · `qwen-audio-3.1-asr-flash-filetrans` / `-message`：filetrans 只收音频 URL
   *    （我们发的是 base64，回 `InvalidParameter: url error`）；message 在
   *    OpenAI 兼容模式下明确 `model_not_supported`，在 duplex WS 上倒是能转写，
   *    但**一条中间结果都不产出**，做不了实时字幕。
   */
  {
    id: 'qwen',
    get label() { return t('asrProvider.qwenPlatform') },
    platform: 'qwen',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.qwenPlatformBlurb') },
    models: [
      {
        // 与 3.0 走同一份 Rust 实现（asr_qwen_audio_stream.rs），模型名经
        // extra.model 传下去。实测同协议、同中间结果节奏、同样接受热词字段。
        id: 'qwen-audio-3.1-asr-flash-streaming',
        provider: 'qwen_audio_stream',
        get blurb() { return t('asrProvider.qwenAudio31StreamBlurb') },
        streaming: true,
      },
      {
        id: 'qwen-audio-3.0-asr-flash-streaming',
        provider: 'qwen_audio_stream',
        get blurb() { return t('asrProvider.qwenAudioStreamBlurb') },
        streaming: true,
      },
      {
        id: 'qwen3-asr-flash',
        provider: 'qwen',
        get blurb() { return t('asrProvider.qwenBlurb') },
      },
      {
        id: 'qwen3-asr-flash-realtime',
        provider: 'qwen_realtime',
        get blurb() { return t('asrProvider.qwenRealtimeBlurb') },
        streaming: true,
        needsWorkspaceId: true,
      },
      {
        /**
         * 最新一代 Omni，**走非实时那条路**（OpenAI 兼容 chat/completions）。
         *
         * 它和下面那个 `-realtime` 是同一代的两条协议，不是新旧关系：这个走 HTTP、
         * 地址可改；那个走 realtime WebSocket、地址固定。对 SayIt 的用法（整段发完
         * 再取文本）两者结果一样，差别在计费口径和能不能换地址。
         *
         * 排在 realtime 那个前面：HTTP 那条路能配中转站/业务空间专属域名，
         * 适用面更广。
         */
        id: 'qwen3.8-omni-flash',
        provider: 'qwen_chat_audio',
        get blurb() { return t('asrProvider.omni38Blurb') },
        omni: true,
        // HTTP 协议，地址可改 —— 百炼官方推荐迁到业务空间专属域名
        // （`{WorkspaceId}.cn-beijing.maas.aliyuncs.com`），那就得靠这一栏。
        supportsCustomUrl: true,
      },
      {
        /**
         * 同一代 Omni 的 realtime 版，走 asr_qwen_omni.rs 那条 WebSocket。
         *
         * ⚠️ 它曾经被判成「加不了」，理由是它在我们的代码路径上会被拒
         * （`Voice 'Chelsie' is not supported`）。那个结论**错在没做对照实验**：
         * 当时"带 voice"和"不发 response.create"两个变量一起变了，所以分不清是哪个
         * 起的作用。固定发 `response.create`、只变音色字段重测之后结论很干脆 ——
         * 加一个 `session.audio.output.voice` 就能用，而且 3.5 两代也接受同一个字段，
         * 一份会话形状通吃。实测脚本：`dev-scripts/probe_qwen38_omni_voice.py`。
         *
         * 所以这里没有任何特殊字段：那个音色字段是 asr_qwen_omni.rs 对所有 Omni
         * 统一发的，不是给这个模型开的后门。
         */
        id: 'qwen3.8-omni-flash-realtime',
        // 产品名就带 -realtime，所以**不需要** apiModel（别顺手补一个
        // `qwen3.8-omni-flash-realtime-realtime`）。
        provider: 'qwen_omni',
        get blurb() { return t('asrProvider.omni38RealtimeBlurb') },
        omni: true,
      },
      {
        // 接口模型名带 -realtime 后缀，产品名不带 —— 这层映射以前在
        // asrModels.ts 的 QWEN_OMNI_MODEL_MAP 里按 provider id 索引，现在跟着模型走。
        id: 'qwen3.5-omni-plus',
        apiModel: 'qwen3.5-omni-plus-realtime',
        provider: 'qwen_omni',
        get blurb() { return t('asrProvider.omniPlusBlurb') },
        omni: true,
      },
      {
        id: 'qwen3.5-omni-flash',
        apiModel: 'qwen3.5-omni-flash-realtime',
        provider: 'qwen_omni',
        get blurb() { return t('asrProvider.omniFlashBlurb') },
        omni: true,
      },
      // 上一代 Omni（qwen3-omni-flash / qwen-omni-turbo）曾经排在这里，理由是
      // 「便宜 + 让存量配置有地方落」。现在删掉了：实测它们的实时端点已经被缩容到
      // 不可用（超时 / 容量限流），留着等于在下拉里摆两个点了就坏的选项，比没有更糟。
      // 存量配置改由 RETIRED_MODELS 接到 qwen3.5-omni-flash 上。
    ],
  },
  {
    id: 'mimo',
    get label() { return t('asrProvider.mimo') },
    platform: 'mimo',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.mimoBlurb') },
    models: [{ id: 'mimo-v2.5-asr', provider: 'mimo' }],
  },
  {
    id: 'groq',
    get label() { return t('asrProvider.groq') },
    platform: 'groq',
    availability: 'global',
    get blurb() { return t('asrProvider.groqBlurb') },
    // 两个都走同一份实现（asr_groq.rs 的 multipart），只换 model 字符串。
    // turbo 放第一位：它是 large-v3 剪掉解码层的版本，快得多而准确率只差一点。
    models: [
      { id: 'whisper-large-v3-turbo', provider: 'groq_whisper', supportsCustomUrl: true },
      { id: 'whisper-large-v3', provider: 'groq_whisper', supportsCustomUrl: true },
    ],
  },
  /**
   * OpenAI 一张卡，两种实现：前四个走 `/audio/transcriptions`（HTTP multipart，
   * asr_groq.rs 那份），最后一个走 Realtime 转写会话（WebSocket，asr_openai_realtime.rs）。
   *
   * **流式那个模型在文件端点上不存在**，所以它关掉实时字幕时会回落到
   * `gpt-transcribe` —— 那层换名在 asr_groq.rs 的 OPENAI_FILE_FALLBACK 档里做，
   * 用户不会看到「模型不存在」。
   */
  {
    id: 'openai',
    get label() { return t('asrProvider.openai') },
    platform: 'openai',
    availability: 'global',
    get blurb() { return t('asrProvider.openaiBlurb') },
    models: [
      // 前四个是 HTTP，地址可改 —— 用中转站/反代接 OpenAI 很常见。
      {
        id: 'gpt-transcribe',
        provider: 'openai_transcribe',
        get blurb() { return t('asrProvider.openaiFileBlurb') },
        supportsCustomUrl: true,
      },
      { id: 'gpt-4o-transcribe', provider: 'openai_transcribe', supportsCustomUrl: true },
      { id: 'gpt-4o-mini-transcribe', provider: 'openai_transcribe', supportsCustomUrl: true },
      // 最老那版，留着给「按 whisper-1 调好了 prompt、不想动」的人
      { id: 'whisper-1', provider: 'openai_transcribe', supportsCustomUrl: true },
      {
        // 这个是 WebSocket realtime，地址改不了（中转站基本不转发它）。
        // 它关掉实时字幕时会回落到 HTTP，但那条路也不带用户地址 ——
        // 否则「我没给这个模型填地址」和「回落时却用了别处的地址」就对不上了。
        id: 'gpt-live-transcribe',
        provider: 'openai_live_transcribe',
        get blurb() { return t('asrProvider.openaiLiveBlurb') },
        streaming: true,
      },
    ],
  },
  /** Gemini 一张卡两种实现：generateContent（HTTP）与 Live API（WebSocket）。 */
  {
    id: 'google',
    get label() { return t('asrProvider.gemini') },
    platform: 'google',
    availability: 'global',
    get blurb() { return t('asrProvider.geminiBlurb') },
    models: [
      {
        // HTTP，地址可改（反代 Gemini 的中转站不少）
        id: 'gemini-3.5-transcribe',
        provider: 'gemini_transcribe',
        get blurb() { return t('asrProvider.geminiFileBlurb') },
        supportsCustomUrl: true,
      },
      {
        id: 'gemini-3.5-transcribe-live',
        provider: 'gemini_live_transcribe',
        get blurb() { return t('asrProvider.geminiLiveBlurb') },
        streaming: true,
      },
    ],
  },
  /**
   * OpenRouter 是**路由层**，不是一家模型厂商 —— 一把 key 通往多家 STT 模型，
   * 所以它是这份清单里模型选项最多的一张卡，也是唯一「换模型就等于换厂商」的一张。
   *
   * 放在最后：它多出一层中间商（价格与延迟都比直连略高），适合的场景是
   * 「不想为每家单独开账号」。已经有 OpenAI / Google key 的人直连更划算。
   */
  {
    id: 'openrouter',
    get label() { return t('asrProvider.openrouter') },
    platform: 'openrouter',
    availability: 'global',
    get blurb() { return t('asrProvider.openrouterBlurb') },
    models: OPENROUTER_MODELS,
  },
  /**
   * ── 「协议卡」：不是某一家服务商，而是「内置清单里没有你要的那家」时用的 ──
   *
   * 起因是 issue #67：内置清单穷举不完，而自建服务（whisper.cpp / faster-whisper /
   * FunASR）和聚合网关的地址每台机器都不一样，我们不可能替用户写进代码。
   *
   * **只有一张卡，协议由代码自己试出来。** 「OpenAI 兼容」在语音这块其实是两套
   * 完全不同的协议（实测见 `dev-scripts/probe_bailian_openai_audio.py`）：
   *   · `/audio/transcriptions`：multipart 上传文件，响应 `{"text": "..."}`。
   *     OpenAI 自己、Groq、硅基流动、FunASR、whisper.cpp、faster-whisper 都是这套。
   *   · `/chat/completions`：音频作为 `input_audio` 内容项塞进 messages。
   *     百炼（qwen3-asr-flash / Omni / livetranslate）走的是这套。
   *
   * 这里曾经做成两张卡、让用户自己选。否掉了：用户没办法知道自己要连的服务说哪种
   * 协议 —— 他得去翻对方文档，或者两张卡轮流试。那是把我们的实现细节推给他承担。
   * 而且名字上只能靠「（对话式）」这种括号区分，加上真正的 OpenAI 卡，列表里会有
   * 三项都以「OpenAI」开头。协议探测放进 Rust（asr_openai_compat.rs），
   * `profile.protocol` 只作为探测判不准时的手动退路。
   *
   * 放在最后：内置卡是推荐项，这张是兜底。
   */
  {
    id: 'openai_compat',
    get label() { return t('asrProvider.openaiCompat') },
    platform: 'openai_compat',
    availability: 'global',
    customEndpoint: true,
    urlPlaceholder: 'http://127.0.0.1:8000/v1',
    get blurb() { return t('asrProvider.openaiCompatBlurb') },
    // 模型名是自由文本，这里只给个常见默认值（whisper.cpp / faster-whisper
    // 的 OpenAI 兼容服务基本都认它）。
    models: [{
      id: 'whisper-1',
      provider: 'openai_compat',
      supportsCustomUrl: true,
      requiresCustomUrl: true,
    }],
  },
]

/** 这张卡有哪些模型（第一个是默认）。 */
export function asrModelsOf(entry: AsrProviderEntry): AsrModelOption[] {
  return entry.models
}

// 模型的显示名就是它的 id，所以这里没有 asrModelLabel / asrModelShortLabel ——
// 理由写在 AsrModelOption 上（原来那两个函数是为 label 字段服务的）。

/**
 * 旧 provider id → 新的（卡片 id, 模型 id）。
 *
 * **这张表是存量配置的生命线。** 改成「一张卡 = 一个平台」之后，老 profile 里
 * `provider` 存的还是旧的分发 key（`qwen_audio_stream`、`gemini_live_transcribe`…），
 * 而那些值不再是任何卡片的 id —— 没有这张表，parseAsrProfiles 会把它们**整条丢掉**，
 * 用户的全部服务配置连密钥一起消失。
 *
 * `doubao` / `aliyun` 这两个是更早的别名（registry.rs 里还认），一并映射过来。
 *
 * 上一代 Omni 那三个旧 id 也在表里 —— 它们对应的模型现在作为选项留在千问卡里
 * （走的是同一份 asr_qwen_omni.rs），所以能原地落下来。表里没有的值才丢弃。
 */
const LEGACY_PROVIDERS: Record<string, { provider: string; model: string }> = {
  doubao: { provider: 'doubao', model: 'Doubao-Seed-ASR-2.0' },
  doubao_v2: { provider: 'doubao', model: 'Doubao-Seed-ASR-2.0' },
  qwen: { provider: 'qwen', model: 'qwen3-asr-flash' },
  aliyun: { provider: 'qwen', model: 'qwen3-asr-flash' },
  qwen_audio_stream: { provider: 'qwen', model: 'qwen-audio-3.0-asr-flash-streaming' },
  qwen_realtime: { provider: 'qwen', model: 'qwen3-asr-flash-realtime' },
  qwen_omni_35_plus: { provider: 'qwen', model: 'qwen3.5-omni-plus' },
  qwen_omni_35_flash: { provider: 'qwen', model: 'qwen3.5-omni-flash' },
  // 上一代 Omni 的三个旧 id。它们对应的模型现在作为选项留在千问卡里，
  // 所以这些配置能落下来而不是被丢弃（早先没有它们，用户的卡直接消失）。
  qwen_omni_plus: { provider: 'qwen', model: 'qwen3.5-omni-plus' },
  // 这两个指向的模型已经从目录里删掉（被百炼缩容），所以落到同族还活着的那个。
  // 目标必须和 RETIRED_MODELS 一致 —— 两张表给出不同答案的话，同一个用户
  // 走迁移路径和走回落路径会得到不同的模型。
  qwen_omni_flash: { provider: 'qwen', model: 'qwen3.5-omni-flash' },
  qwen_omni_turbo: { provider: 'qwen', model: 'qwen3.5-omni-flash' },
  mimo: { provider: 'mimo', model: 'mimo-v2.5-asr' },
  groq_whisper: { provider: 'groq', model: 'whisper-large-v3-turbo' },
  openai_transcribe: { provider: 'openai', model: 'gpt-transcribe' },
  openai_live_transcribe: { provider: 'openai', model: 'gpt-live-transcribe' },
  gemini_transcribe: { provider: 'google', model: 'gemini-3.5-transcribe' },
  gemini_live_transcribe: { provider: 'google', model: 'gemini-3.5-transcribe-live' },
  openrouter_transcribe: { provider: 'openrouter', model: 'openai/gpt-transcribe' },
  // 协议卡合并前的两个 id。合并后都落到同一张卡上，模型名由用户自己填过，
  // 这里只给个兜底值 —— 真实值在 profile.model 里，迁移不会动它。
  // 协议交给 auto 重新探测：原来分成两张卡的时候，卡片 id 本身就是协议，
  // 而合并后那个信息只能靠探测拿回来。
  openai_compat_transcribe: { provider: 'openai_compat', model: 'whisper-1' },
  openai_chat_audio: { provider: 'openai_compat', model: 'qwen3-asr-flash' },
}

/**
 * 已从目录里删掉的模型 → 接替它的那个。
 *
 * **为什么不能只靠"回落到卡片默认"。** migrateLegacyProvider 的第 3 种情形本来就会
 * 把认不出的模型名回落到该卡第一项，数据不会丢。但千问卡的第一项是纯 ASR，而这里
 * 退役的两个都是 Omni（识别 + 整理一体）—— 回落过去会把用户从「不用配 AI 服务」
 * 悄悄搬到「必须另配 AI 服务」，而他不会收到任何提示，只会发现整理效果不对了。
 * 跨语义的替换要么明确指定落点，要么就不该发生。
 *
 * 所以这张表只放**同族替代**：退役的 Omni → 还活着的 Omni。找不到同族替代的模型
 * 不要往这里加，让它走回落，那至少是个诚实的默认值。
 */
const RETIRED_MODELS: Record<string, string> = {
  // 2026-09-23：官网标「即将下线」，且实测实时端点已被缩容（超时 / 容量限流）。
  'qwen3-omni-flash': 'qwen3.5-omni-flash',
  'qwen-omni-turbo': 'qwen3.5-omni-flash',
}

/**
 * 把存量条目的 provider 迁移成（卡片 id, 模型 id）。
 *
 * ── 判据必须是「provider + model 这一对是否自洽」，不能只看其中一个 ──
 * 早先写成「有 model 就是新数据」，结果把用户的卡片全弄丢了：`model` 字段是**上一个
 * 版本**就加进来的（那时它表示"同实现下选哪个模型"），所以存量数据里
 * `provider='gemini_transcribe'` 配 `model='gemini-3.5-transcribe'` 是完全正常的组合 ——
 * 判成新数据后 `findAsrProvider('gemini_transcribe')` 返回 undefined，整条被丢掉。
 *
 * 五种情形，顺序有讲究：
 *   1. provider 是卡片 id 且 model 属于这张卡 → 新数据，原样；
 *   2. provider 在迁移表里 → 按表迁移，但**用户选过的模型如果新卡也有就保留**
 *      （否则在 Groq 卡上选过 large-v3 的人会被打回 turbo）；
 *   3. provider 是卡片 id 且 model 是刚退役的模型 → 换成 RETIRED_MODELS 指定的替代；
 *   4. provider 是卡片 id 但 model 不认识（新建后没选、或模型下线）→ 回落该卡默认；
 *   5. 都不是 → 丢弃。
 *
 * 情形 3 必须排在 4 前面，否则退役的 Omni 会先被情形 4 吃掉、落到卡片默认那个
 * 纯 ASR 模型上 —— 理由见 RETIRED_MODELS。
 */
function migrateLegacyProvider(
  provider: string,
  model: string,
): { provider: string; model: string } | null {
  // 退役模型先换名，**必须在所有分支之前**。
  //
  // 踩过的坑：这段原来放在最后那个 `if (direct)` 分支里，而 `qwen` / `doubao` /
  // `mimo` 这些值**同时**是旧分发 key 和新卡片 id —— 它们会先被下面的
  // LEGACY_PROVIDERS 拦住并直接返回，于是退役映射对最需要它的那批配置
  // （千问卡上的 Omni）压根不执行。测试里表现为退役 Omni 落到了 qwen3-asr-flash。
  //
  // 换完名之后由 belongsTo 承担「替代确实还在这张卡里」的校验，所以这里不必
  // 再自己查一遍：替代要是也没了，会照常回落，不会返回一个不存在的模型名。
  const trimmed = RETIRED_MODELS[model.trim()] ?? model.trim()
  const direct = findAsrProvider(provider)
  const belongsTo = (entry: AsrProviderEntry) =>
    trimmed !== '' && asrModelsOf(entry).some((m) => m.id === trimmed)

  if (direct && belongsTo(direct)) return { provider, model: trimmed }

  const legacy = LEGACY_PROVIDERS[provider]
  if (legacy) {
    const card = findAsrProvider(legacy.provider)
    return {
      provider: legacy.provider,
      model: card && belongsTo(card) ? trimmed : legacy.model,
    }
  }

  if (direct) return { provider, model: asrModelsOf(direct)[0].id }
  return null
}

/**
 * 旧 provider id → 它现在属于哪张卡（不认识就原样返回）。
 *
 * 给「已经自动补建过哪些」那份记账用（`cloudAsr.autoCreatedProviders`）：
 * 存量里记的是旧的分发 key，不换算的话新代码认不出来，会把用户主动删掉的卡
 * 重新补回来一次。
 */
export function asrCardIdOfLegacyProvider(provider: string): string {
  return LEGACY_PROVIDERS[provider]?.provider ?? provider
}

/**
 * 把模型清单按厂商前缀分组，供下拉的 optgroup 用。
 *
 * 只有 OpenRouter 用得上：它一张卡下有 20 多个模型、来自十来家厂商，平铺成一列
 * 找起来很费劲，而 slug 的前缀天然就是厂商名。返回 null 表示「不该分组」——
 * 别家的模型名不带 `/`（`whisper-large-v3`、`gpt-transcribe`），
 * 硬分组只会得到一个名叫空串的组。
 *
 * 组内保持原清单顺序（那是「什么时候选它」的推荐顺序），组的顺序按各组第一个
 * 元素在原清单里的位置 —— 这样默认模型所在的组一定排在最前面。
 */
export function groupAsrModelsByVendor(
  models: AsrModelOption[],
): [string, AsrModelOption[]][] | null {
  if (models.length < 2 || !models.every((m) => m.id.includes('/'))) return null
  const groups: [string, AsrModelOption[]][] = []
  for (const model of models) {
    const vendor = model.id.slice(0, model.id.indexOf('/'))
    const existing = groups.find(([name]) => name === vendor)
    if (existing) existing[1].push(model)
    else groups.push([vendor, [model]])
  }
  return groups
}

export function findAsrProvider(id: string): AsrProviderEntry | undefined {
  return ASR_PROVIDERS.find((p) => p.id === id)
}

/**
 * 地区提示，**只在需要提醒时才给字**。
 *
 * `mainland_china` 刻意返回空串：内置清单里绝大多数都是国内端点，那是默认情形，
 * 每张卡上都挂一句「面向中国大陆账号」等于把噪音重复七遍，还把真正要紧的
 * 「这个要海外网络才连得上」冲淡了。availability 字段本身保留 —— 它是数据，
 * 只是这一条不值得占界面上的字。
 */
export function asrAvailabilityLabel(entry: AsrProviderEntry): string {
  // 地址由用户填的卡不谈地区：对面可能是 localhost，也可能是境外网关，
  // 挂一句「需要海外网络」只会误导。
  if (entry.customEndpoint) return ''
  switch (entry.availability) {
    case 'global': return t('asrProvider.regionGlobal')
    default: return ''
  }
}

/**
 * 这次要发往的接口地址（空 = 用实现里内置的官方地址）。
 *
 * 闸门在**选中的那个模型**上，不在卡片上：只有标了 `supportsCustomUrl` 的模型
 * （即 HTTP 协议那些）才会返回非空值。两个理由：
 *  · 同一张卡里两种协议并存 —— 千问卡的 qwen3.8-omni-flash 是 HTTP、
 *    qwen3.5-omni-plus 是 realtime WebSocket，后者改地址没有意义；
 *  · 档案里可能残留地址（用户换过供应商 / 换过模型），残值绝不能被发出去 ——
 *    那会把音频送到一个他早就不打算用的地方。
 */
export function asrEndpointUrl(profile: AsrProfile): string {
  if (!resolveAsrModelOption(profile)?.supportsCustomUrl) return ''
  return profile.apiUrl.trim()
}

/**
 * 接口地址里的主机名，用于在卡片上区分同平台的多张卡。
 *
 * 用主机名而不是整条 URL：卡片标题只有一行，`http://192.168.1.9:9000/v1` 这种
 * 会把标题挤没。解析失败就原样返回（用户可能填了一半），不抛。
 */
export function asrEndpointHost(profile: AsrProfile): string {
  const url = asrEndpointUrl(profile)
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 同一平台下有哪些卡。
 *
 * 现在是「一张卡 = 一个平台」，所以它恒返回 0 或 1 条 —— 保留这个函数是因为
 * 那条不变量值得有断言看着（见 asrProviderCatalog.test.ts）。
 */
export function providersOfPlatform(platform: AsrPlatform): AsrProviderEntry[] {
  return ASR_PROVIDERS.filter((p) => p.platform === platform)
}

// ─────────────────────────── 检测结果 ───────────────────────────

/**
 * 一次识别测试的结论。
 *
 * 存的是结论而不只是耗时：只有耗时的话，界面上能说出「多快」，说不出「行不行」。
 * 不可用也要留痕，否则用户点完测试、切走再回来，只看到一张和没测过一样的卡。
 */
export interface AsrCheck {
  ok: boolean
  /** 测试时间戳，用来判断结论是否还新鲜 */
  at: number
  /** 转写这段测试音频花了多久（毫秒），只有测通才有 */
  latencyMs?: number
  /** 测试音频时长（秒）。延迟要除以它才能横向比较，所以一起存 */
  audioSec?: number
  /** 不可用时的原因，一句话 */
  reason?: string
}

function isFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function parseCheck(raw: unknown): AsrCheck | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  if (typeof v.ok !== 'boolean') return undefined
  const at = isFiniteNumber(v.at)
  if (at === undefined) return undefined
  return {
    ok: v.ok,
    at,
    latencyMs: isFiniteNumber(v.latencyMs),
    audioSec: isFiniteNumber(v.audioSec),
    reason: typeof v.reason === 'string' && v.reason ? v.reason : undefined,
  }
}

// ─────────────────────────── 服务档案 ───────────────────────────

/**
 * 一份语音识别服务配置 = 选定的供应商 + 该平台需要的凭据。
 *
 * 凭据直接挂在档案上（而不是按平台共享），这样一张卡就是一份自洽的完整配置，
 * 也才可能同时存两个账号。重复粘密钥的问题由「新建时自动沿用同平台上一份」解决。
 */
export interface AsrProfile {
  id: string
  /** 供应商 id，必须是 ASR_PROVIDERS 里的一个 */
  provider: string
  /**
   * 用户给这张卡起的名字，可空。
   *
   * 存在的理由：同一个平台可以有多张卡（两个账号、或两个自建地址），而卡片标题
   * 只有平台名时它们长得一模一样。这里原来是自动补「密钥末 4 位」，用户一眼就把它
   * 认成「密钥被显示出来了」—— 那种区分方式不该由我们替他选，让他自己起名。
   */
  name: string
  /**
   * 自定义接口地址。
   *
   * 协议卡必填；内置卡**可选** —— 空着就用实现里的官方地址，填了就走用户的
   * （中转站 / 反代很常见，尤其 OpenAI 和 Gemini）。只对选中模型标了
   * `supportsCustomUrl` 时才会真的发出去，见 asrEndpointUrl。
   */
  apiUrl: string
  /**
   * 「OpenAI 兼容」那张卡说哪种协议。其余卡片这个值无意义（协议是写死的）。
   * 默认 `auto`，由 Rust 侧探测；两个显式值是探测判不准时的退路。
   */
  protocol: AsrCompatProtocol
  /**
   * 选定的模型 id（该卡 models 清单里的一个）。
   *
   * 新写入的条目一律显式带值，见 emptyAsrProfile 上的说明。读取时空值或不认识的值
   * 由 resolveAsrModelOption 回落到该卡默认，不会让整条配置失效。
   */
  model: string
  /** 千问 / 小米：API Key；豆包：当前控制台代次那一份密钥 */
  apiKey: string
  /** 豆包旧版控制台的 App ID */
  appId: string
  /** 豆包控制台代次 */
  console: DoubaoConsole
  /** 豆包另一代的密钥，切换代次时原样保留，不用重新粘 */
  otherKey: string
  /** 百炼业务空间 ID（流式识别需要） */
  workspaceId: string
  /** Omni 模型的 System Prompt（识别与整理一体，属于这份服务的行为） */
  omniPrompt: string
  /** 上次识别测试的结论 */
  check?: AsrCheck
}

export function makeAsrProfileId(): string {
  return `asr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 一份空白档案。provider 默认给最推荐的那张卡。
 *
 * **model 一定显式写入**，不留空串：`parseAsrProfiles` 靠「有没有 model」区分
 * 新老数据（`qwen` / `mimo` / `doubao` 这几个值既是旧分发 key 又是新卡片 id，
 * 光看 provider 分不出来）。留空会让新建的条目被当成存量数据走迁移，
 * 于是默认模型被换成迁移表里那个 —— 用户什么都没选，模型却不是默认的那个。
 */
export function emptyAsrProfile(provider = ASR_PROVIDERS[0].id): AsrProfile {
  const entry = findAsrProvider(provider)
  return {
    id: makeAsrProfileId(),
    provider,
    name: '',
    apiUrl: '',
    protocol: 'auto',
    model: entry ? asrModelsOf(entry)[0].id : '',
    apiKey: '',
    appId: '',
    console: 'new',
    otherKey: '',
    workspaceId: '',
    omniPrompt: '',
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 容错解析存储里的档案列表。
 *
 * 存储可能被手改过、也可能是更早版本写的，坏条目一律丢弃而不是让整页崩掉。
 * provider 不在内置清单里的条目也丢掉 —— 留着只会渲染出一张点不动的卡。
 */
export function parseAsrProfiles(raw: unknown): AsrProfile[] {
  return parseAsrProfilesDetailed(raw).profiles
}

/**
 * 同 parseAsrProfiles，但**把解析不出来的原始条目也交回去**。
 *
 * 存在的理由是一次真实的数据损失：解析逻辑有 bug 时，被丢掉的条目会在下一次
 * 「归一化后写回」时从磁盘上永久消失 —— 用户丢的是配置连带密钥，而密钥没有第二份。
 * 调用方（loadAsrProfiles / saveAsrProfiles）拿着 orphans 原样写回存储，
 * 这样即使解析再出错，原始 JSON 也一直躺在 db 里，改好代码就能恢复。
 */
export function parseAsrProfilesDetailed(
  raw: unknown,
): { profiles: AsrProfile[]; orphans: unknown[] } {
  if (!Array.isArray(raw)) return { profiles: [], orphans: [] }
  const out: AsrProfile[] = []
  const orphans: unknown[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      orphans.push(item)
      continue
    }
    const v = item as Record<string, unknown>
    // 存量条目的 provider 是旧的分发 key，先迁移成（卡片 id, 模型 id）。
    // 迁移不了（未知 provider）才留作 orphan —— 绝不静默删除，见上面的说明。
    const migrated = migrateLegacyProvider(str(v.provider), str(v.model))
    if (!migrated || !findAsrProvider(migrated.provider)) {
      orphans.push(item)
      continue
    }
    const { provider, model } = migrated
    const id = str(v.id) || makeAsrProfileId()
    if (seen.has(id)) {
      orphans.push(item)
      continue
    }
    seen.add(id)
    const consoleRaw = str(v.console)
    out.push({
      id,
      provider,
      name: str(v.name),
      apiUrl: str(v.apiUrl),
      protocol: parseAsrCompatProtocol(v.protocol),
      // 不在这里校验模型名：清单会变，而校验放在 resolveAsrModelOption 里，
      // 存了个已下线的名字也只会回落到默认，不至于让整条配置被丢掉
      model,
      apiKey: str(v.apiKey),
      appId: str(v.appId),
      console: consoleRaw === 'legacy' ? 'legacy' : 'new',
      otherKey: str(v.otherKey),
      workspaceId: str(v.workspaceId),
      omniPrompt: str(v.omniPrompt),
      check: parseCheck(v.check),
    })
  }
  return { profiles: out, orphans }
}

/**
 * 一份档案实际选中的那个模型（含它走哪份实现）。
 *
 * 不在清单里的值一律回落到该卡的默认模型，而不是原样用 —— 存量配置可能留着一个
 * 已经下线的模型名（服务商淘汰模型比我们改代码勤），照发只会换来一个含义模糊的 400。
 * 卡片本身不存在时返回 undefined，由调用方决定怎么处理。
 */
export function resolveAsrModelOption(profile: AsrProfile): AsrModelOption | undefined {
  const entry = findAsrProvider(profile.provider)
  if (!entry) return undefined
  const models = asrModelsOf(entry)
  const picked = profile.model.trim()
  const found = models.find((m) => m.id === picked)
  if (found) return found
  // 自定义端点的卡：模型名是用户敲的，对面挂什么模型我们无从校验，
  // 不能回落到清单里那个默认值 —— 那等于把用户填的模型悄悄换掉。
  // 只借用第一项的 provider（分发 key），模型名由 resolveAsrApiModel 用档案里的原值。
  if (entry.customEndpoint && picked) return { ...models[0], id: picked }
  return models[0]
}

/** 一份档案实际会用哪个模型（显示与存储用的那个名字）。 */
export function resolveAsrModel(profile: AsrProfile): string {
  return resolveAsrModelOption(profile)?.id ?? ''
}

/**
 * 运行时 `cloudAsr.provider` 该写什么 —— 也就是 Rust 侧的分发 key。
 *
 * **这是卡片 id 与后端实现分离之后最容易搞错的一处。** 卡片 id 是平台
 * （`qwen`），而真正决定走哪个协议的是选中模型的 provider（`qwen_audio_stream`）。
 * 写错的表现是「换了模型但行为没变」，或者更糟：发给一个不认识这个模型的端点。
 */
export function resolveAsrRuntimeProvider(profile: AsrProfile): string {
  return resolveAsrModelOption(profile)?.provider ?? ''
}

/** 运行时 `cloudAsr.model` 该写什么 —— 实际发给服务端的模型名。 */
export function resolveAsrApiModel(profile: AsrProfile): string {
  const option = resolveAsrModelOption(profile)
  if (!option) return ''
  return option.apiModel ?? option.id
}

/** 启用项归一化：指向不存在的 id 时回落到第一条 */
export function resolveActiveAsrProfile(
  profiles: AsrProfile[],
  activeId: string,
): AsrProfile | null {
  return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null
}

/**
 * 档案里的豆包字段 → lib/cloudAsrCreds 的凭据结构。
 *
 * 抽出来是因为两处都要用（算生效凭据、判断缺什么）。档案里只存「当前代次那把密钥」
 * 加「另一代那把」，映射时按代次还原成 consoleKey / accessToken。
 */
function toDoubaoCreds(profile: AsrProfile): DoubaoCredentials {
  return {
    console: profile.console,
    consoleKey: profile.console === 'new' ? profile.apiKey : profile.otherKey,
    accessToken: profile.console === 'new' ? profile.otherKey : profile.apiKey,
    appId: profile.appId,
  }
}

/**
 * 算出一份档案「本次生效的凭据」。
 *
 * 豆包新版控制台下 appId 必须是空串 —— Rust 侧就是靠它区分两代鉴权头，
 * 这条不变量的说明与测试在 lib/cloudAsrCreds.ts。
 */
export function effectiveAsrCredentials(profile: AsrProfile): { apiKey: string; appId: string } {
  if (findAsrProvider(profile.provider)?.platform === 'doubao') {
    return effectiveDoubaoCredentials(toDoubaoCreds(profile))
  }
  return { apiKey: profile.apiKey.trim(), appId: '' }
}

/**
 * 这份档案还缺什么才能用（空串 = 齐了）。文案直接可展示。
 *
 * 豆包那套直接委托 describeDoubaoMissing，不再自己抄一遍：抄的那版曾经把
 * 「还没填 API Key」写成没有空格的「还没填API Key」，而同一句话会和左下角就绪指示
 * 同屏出现，差一个空格就露馅。同一句用户可见文案只该有一个出处。
 */
export function describeAsrMissing(profile: AsrProfile): string {
  const entry = findAsrProvider(profile.provider)
  if (entry?.platform === 'doubao') {
    return describeDoubaoMissing(toDoubaoCreds(profile))
  }
  // 协议卡：地址先于密钥。没有地址这张卡压根不知道该往哪儿发，
  // 而自建服务很多是不校验密钥的，所以密钥在这里不是必填。
  if (resolveAsrModelOption(profile)?.requiresCustomUrl) {
    if (!profile.apiUrl.trim()) return t('asrProvider.missingUrl')
    return ''
  }
  return profile.apiKey.trim() ? '' : t('asrProvider.missingKey')
}

/**
 * 卡片标题。
 *
 * ⚠️ **绝不要在这里拼密钥的任何部分。** 这里原来的做法是：同平台有多张卡时补上
 * 「•• + 密钥末 4 位」当区分标记。当时的理由是两张卡只差凭据、否则长得一模一样；
 * 但用户看到的第一反应是「我的 API Key 怎么被显示出来了」—— 在一个专门用眼睛图标
 * 遮住密钥的界面里，标题上却挂着密钥的尾巴，这个自相矛盾比它解决的问题更严重。
 *
 * 现在的区分方式，按优先级：
 *  1. 用户自己起的名字（`profile.name`）—— 他最清楚这两张卡差在哪；
 *  2. 自定义端点的主机名 —— 非机密，而且正好是自建卡之间真正的差别；
 *  3. 都没有就只显示平台名。此时两张卡靠下面那行「模型」区分，
 *     模型也相同的话让用户去起个名字，我们不替他编一个。
 */
export function asrCardTitle(profile: AsrProfile, siblings: number): string {
  const named = profile.name.trim()
  if (named) return named
  const entry = findAsrProvider(profile.provider)
  const base = entry?.label ?? profile.provider
  if (siblings <= 1) return base
  const host = asrEndpointHost(profile)
  return host ? `${base} · ${host}` : base
}

// ─────────────────────────── 延迟分档 ───────────────────────────

/**
 * 为什么不直接复用 AI 服务那套 gradeLatency：口径完全不同。
 *
 * 那边测的是一次极小的 LLM 往返，1 秒就算慢。这边测的是**把一段音频转写成文字**，
 * 一段 3 秒的话花 1 秒返回是正常水平。照搬阈值会把所有 ASR 服务标成「太慢」。
 *
 * 所以按 RTF（耗时 ÷ 音频时长）分档，界面上仍显示毫秒数（用户看得懂的是这个），
 * 但结论词来自 RTF —— 这样即使将来换了测试音频，档位也不会跟着漂。
 */
export type AsrLatencyTier = 'instant' | 'fast' | 'normal' | 'slow' | 'tooSlow'

export interface AsrLatencyGrade {
  tier: AsrLatencyTier
  label: string
  /** ok = 放心用，warn = 能用但拖，bad = 不建议用于口述 */
  tone: 'ok' | 'warn' | 'bad'
}

/** RTF 分界值集中在这里，想调手感只改这一处 */
const RTF_THRESHOLDS = { instant: 0.15, fast: 0.3, normal: 0.5, slow: 0.8 } as const

export function gradeAsrLatency(latencyMs: number, audioSec: number): AsrLatencyGrade {
  // 音频时长缺失或不合理时不硬猜档位，只说「已测通」，避免给出一个凭空的结论
  if (!Number.isFinite(audioSec) || audioSec <= 0) {
    return { tier: 'normal', label: t('grade.tested'), tone: 'ok' }
  }
  const rtf = latencyMs / (audioSec * 1000)
  if (rtf < RTF_THRESHOLDS.instant) return { tier: 'instant', label: t('grade.instant'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.fast) return { tier: 'fast', label: t('grade.fast'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.normal) return { tier: 'normal', label: t('grade.normal'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.slow) return { tier: 'slow', label: t('grade.slow'), tone: 'warn' }
  return { tier: 'tooSlow', label: t('grade.tooSlow'), tone: 'bad' }
}
