import { describe, it, expect } from 'vitest'
import { isStreamingDisplayReady } from '@/lib/asrModels'
import {
  ASR_PLATFORMS,
  ASR_PROVIDERS,
  asrAvailabilityLabel,
  asrCardTitle,
  asrEndpointUrl,
  parseAsrCompatProtocol,
  asrModelsOf,
  describeAsrMissing,
  effectiveAsrCredentials,
  emptyAsrProfile,
  findAsrProvider,
  gradeAsrLatency,
  groupAsrModelsByVendor,

  parseAsrProfiles,
  parseAsrProfilesDetailed,
  providersOfPlatform,
  resolveActiveAsrProfile,
  resolveAsrApiModel,
  resolveAsrModel,
  resolveAsrModelOption,
  resolveAsrRuntimeProvider,
  type AsrModelOption,
  type AsrProfile,
} from '../asrProviderCatalog'

function profile(over: Partial<AsrProfile> = {}): AsrProfile {
  return { ...emptyAsrProfile(), ...over }
}

describe('ASR_PROVIDERS 结构性不变量', () => {
  it('id 唯一', () => {
    const ids = ASR_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每张卡都有标题、一句定位、至少一个模型', () => {
    for (const p of ASR_PROVIDERS) {
      expect(p.label.trim()).not.toBe('')
      expect(p.blurb.trim()).not.toBe('')
      expect(['mainland_china', 'global']).toContain(p.availability)
      expect(asrModelsOf(p).length).toBeGreaterThan(0)
    }
  })

  /**
   * 一张卡 = 一个平台，而且 id 就等于 platform。
   *
   * 这是这次重构的核心不变量：界面按平台归拢（用户认的是「千问」，不是
   * 「qwen_audio_stream」），协议差异下沉到模型的 provider 字段。
   */
  it('一张卡对应一个平台，id 等于 platform', () => {
    for (const p of ASR_PROVIDERS) {
      expect(p.id).toBe(p.platform)
      expect(providersOfPlatform(p.platform)).toHaveLength(1)
    }
  })

  /**
   * 每个模型都要指明走哪份实现，而且那个 provider 必须是 Rust registry.rs 认识的。
   *
   * 这份清单是**手抄**的对照表 —— 加模型时如果忘了在 registry.rs 的两处 match 里
   * 登记，运行时会得到 "ASR provider not implemented"，而那时候用户已经配好了。
   */
  it('每个模型的 provider 都在 Rust 侧登记过', () => {
    const registered = new Set([
      'doubao_v2', 'qwen', 'qwen_realtime', 'qwen_audio_stream', 'qwen_omni', 'mimo',
      'groq_whisper', 'openai_transcribe', 'openai_live_transcribe',
      'gemini_transcribe', 'gemini_live_transcribe', 'openrouter_transcribe',
      // chat/completions + input_audio 那一套（asr_openai_chat_audio.rs）
      'qwen_chat_audio', 'openai_chat_audio', 'openai_chat_audio_standard',
      // /audio/transcriptions、地址由用户填（asr_groq.rs 的 OPENAI_COMPAT 档）
      'openai_compat_transcribe',
      // 协议卡的分发层：探测出协议后再转给上面两组之一（asr_openai_compat.rs）
      'openai_compat',
    ])
    for (const p of ASR_PROVIDERS) {
      for (const model of asrModelsOf(p)) {
        expect(model.provider.trim()).not.toBe('')
        expect(registered.has(model.provider)).toBe(true)
      }
    }
  })

  /**
   * 千问那张卡是「一张卡多种协议」的样板。现在是五种实现 ——
   * qwen3.8-omni-flash 走的是非实时的 chat/completions（`qwen_chat_audio`），
   * 与另外几个 Omni 的 realtime WebSocket 不是一套。
   */
  it('千问一张卡覆盖它的五种协议实现', () => {
    const providers = asrModelsOf(findAsrProvider('qwen')!).map((m) => m.provider)
    expect(new Set(providers)).toEqual(
      new Set(['qwen_audio_stream', 'qwen', 'qwen_realtime', 'qwen_omni', 'qwen_chat_audio']),
    )
  })

  // 这条断言变过两次，记下来免得再绕回去：
  //   v1「每一家都是 mainland_china」—— 只是把当时的事实写死，加海外供应商时它拦的是新功能；
  //   v2「每种地区都有展示文案」—— 于是七张卡上各挂一句「面向中国大陆账号」，是纯噪音；
  //   现在：国内是默认情形，不给字；只有需要海外账号/网络的才提醒。
  //   v3 追加：地址由用户填的「协议卡」也不给字 —— 对面可能是 localhost，
  //   挂一句「需要海外网络」只会误导。
  it('只有海外供应商才给地区提示，国内的和协议卡都不占字', () => {
    for (const p of ASR_PROVIDERS) {
      const label = asrAvailabilityLabel(p).trim()
      if (p.customEndpoint) expect(label).toBe('')
      else if (p.availability === 'global') expect(label).not.toBe('')
      else expect(label).toBe('')
    }
    // 至少还有一家是海外的，否则上面那半条断言等于没跑
    expect(ASR_PROVIDERS.some((p) => p.availability === 'global')).toBe(true)
  })

  it('平台都在 ASR_PLATFORMS 里有定义', () => {
    for (const p of ASR_PROVIDERS) expect(ASR_PLATFORMS[p.platform]).toBeTruthy()
  })

  it('模型 id 在卡内唯一、不为空', () => {
    for (const p of ASR_PROVIDERS) {
      const ids = asrModelsOf(p).map((m) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(id.trim()).not.toBe('')
    }
  })

  /**
   * OpenRouter 的 slug 必须带厂商前缀（`openai/whisper-1` 而不是 `whisper-1`）。
   *
   * 少了前缀是 404 model not found —— 一个只在真调用时才暴露、而且报错指向
   * 「模型不存在」而不是「你写错了格式」的错误。目录是这些 slug 的唯一出处，
   * 所以在这里挡住。
   */
  it('OpenRouter 的每个模型 slug 都带厂商前缀', () => {
    const entry = findAsrProvider('openrouter')!
    expect(entry.platform).toBe('openrouter')
    const slugs = asrModelsOf(entry).map((m) => m.id)
    expect(slugs.length).toBeGreaterThan(15)
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9-]+\/.+/)
    }
    // 清单是从 /api/v1/models 原样抄的，抽查几个「展示名推不出来」的
    expect(slugs).toContain('openai/whisper-large-v3-turbo')
    expect(slugs).toContain('qwen/qwen3-asr-flash-2026-02-10')
    expect(slugs).toContain('x-ai/grok-stt-1.0')
    expect(slugs).toContain('meta/muse-voice-transcribe-1.0')
  })

  it('用户反馈缺的两个模型都在清单里', () => {
    expect(asrModelsOf(findAsrProvider('groq')!).map((m) => m.id)).toContain('whisper-large-v3')
    expect(asrModelsOf(findAsrProvider('openai')!).map((m) => m.id)).toContain('gpt-transcribe')
  })

  /**
   * 模型上标了 streaming 的，必须真的有流式实现（isStreamingDisplayReady 认它）；
   * 反过来也必须成立。
   *
   * 两边都查是因为它们**是两份独立的清单**：目录里的 streaming 只是给人看的标记，
   * 运行时闸门只认 asrModels.ts 那份。只加目录不加闸门的话，卡片上写着支持实时字幕、
   * 实际永远走一次性路径 —— 不报错，字幕就是不出来。
   *
   * 判据用**模型的 provider**，因为闸门认的就是它。
   */
  it('模型的 streaming 标记与运行时闸门一致', () => {
    let streamingCount = 0
    for (const p of ASR_PROVIDERS) {
      for (const model of asrModelsOf(p)) {
        const workspace = model.needsWorkspaceId ? 'ws-test' : undefined
        expect(isStreamingDisplayReady(model.provider, workspace)).toBe(Boolean(model.streaming))
        if (model.streaming) streamingCount += 1
      }
    }
    // 至少有一个标了 streaming，否则上面那条等于没跑
    expect(streamingCount).toBeGreaterThan(0)
  })

  /**
   * 「文件转写」与「实时字幕」现在是同一张卡里的两个模型，各走各的实现。
   *
   * 流式模型在文件端点上根本不存在（gpt-live-transcribe 之于 /audio/transcriptions、
   * gemini-3.5-transcribe-live 之于 generateContent），所以关掉实时字幕回落时
   * Rust 侧会把模型名换掉（asr_groq 的 honors_selected_model、asr_gemini 的
   * LIVE_PROVIDER 判断）。这条钉住两者确实是不同的模型 + 不同的实现。
   */
  it('每家的文件模型与流式模型各走各的实现', () => {
    for (const cardId of ['openai', 'google']) {
      const models = asrModelsOf(findAsrProvider(cardId)!)
      const file = models.find((m) => !m.streaming)!
      const live = models.find((m) => m.streaming)!
      expect(file.id).not.toBe(live.id)
      expect(file.provider).not.toBe(live.provider)
    }
  })

  /**
   * 卡片标题不该再出现「（qwen3.5-omni-plus，ASR+AI）」这种**模型名括号串** ——
   * 模型名有自己的一行。
   *
   * 判据钉的是「括号里不能是模型名」，不是「不许有括号」：两张协议卡的名字里
   * 「（对话式）」是在区分两套同名协议，那是标题必须承担的信息。
   */
  it('标题的括号里不出现模型名', () => {
    const allModelIds = ASR_PROVIDERS.flatMap((p) => asrModelsOf(p)).map((m) => m.id)
    for (const p of ASR_PROVIDERS) {
      for (const id of allModelIds) {
        expect(p.label).not.toContain(id)
      }
    }
  })

  /** 卡片顺序就是推荐顺序，前两名钉住 */
  it('推荐顺序：豆包第一，千问第二', () => {
    expect(ASR_PROVIDERS.slice(0, 2).map((p) => p.id)).toEqual(['doubao', 'qwen'])
  })

  /**
   * 只有 qwen3-asr-flash-realtime 需要业务空间 ID。
   * Qwen-Audio-ASR-Flash-Streaming 的 3.1 与 3.0 都用通用域名就能跑（实测），
   * 照抄 needsWorkspaceId 会让用户以为不填就用不了 —— 这条钉住这个区别。
   */
  it('只有 qwen_realtime 那个模型需要业务空间 ID', () => {
    const needing = ASR_PROVIDERS.flatMap((p) => asrModelsOf(p))
      .filter((m) => m.needsWorkspaceId)
      .map((m) => m.id)
    expect(needing).toEqual(['qwen3-asr-flash-realtime'])
  })

  /**
   * 走 realtime 那条路的 Omni：**发出去的模型名必须带 `-realtime`**。
   *
   * 断言的是 resolveAsrApiModel 的结果，不是「每个都得有 apiModel」——
   * 后者曾经成立（那时产品名都不带后缀，靠 apiModel 补），但
   * qwen3.8-omni-flash-realtime 的产品名本身就带，给它配 apiModel 只会得到
   * `...-realtime-realtime`。把断言钉在「实际发什么」上，两种情形都覆盖，
   * 也不会因为下次加了个本来就带后缀的模型而红。
   */
  it('走 realtime 的 Omni，发出去的模型名都带 -realtime', () => {
    const realtimeOmni = asrModelsOf(findAsrProvider('qwen')!)
      .filter((m) => m.omni && m.provider === 'qwen_omni')
    expect(realtimeOmni.map((m) => m.id)).toEqual([
      'qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus', 'qwen3.5-omni-flash',
    ])
    for (const model of realtimeOmni) {
      const sent = resolveAsrApiModel(profile({ provider: 'qwen', model: model.id }))
      expect(sent).toMatch(/-realtime$/)
      // 后缀只能有一份
      expect(sent.endsWith('-realtime-realtime')).toBe(false)
    }
  })

  /**
   * 3.8 那两条是**同一代的两条协议**，不是新旧关系。这条钉住它们各走各的实现。
   *
   * ⚠️ 这里的结论被推翻过两次，别按旧理由改回去：
   *  1. 最早认为「服务端没有 qwen3.8-omni-flash-realtime」——
   *     2026-09-23 复测它存在了；
   *  2. 接着认为「它在我们的代码路径上过不去」（`response.create` 时报
   *     `Voice 'Chelsie' is not supported`）—— 这个现象是真的，但**结论错了**：
   *     当时的对照实验里"带 voice"和"不发 response.create"两个变量一起变了。
   *     固定发 response.create、只变音色字段重测后，加一个
   *     `session.audio.output.voice` 就能用（3.5 两代也接受同一个字段）。
   *     那个字段现在由 asr_qwen_omni.rs 对所有 Omni 统一发送。
   */
  it('3.8 的两个 Omni 各走各的协议', () => {
    const models = asrModelsOf(findAsrProvider('qwen')!)

    const http = models.find((m) => m.id === 'qwen3.8-omni-flash')
    expect(http).toBeTruthy()
    expect(http!.provider).toBe('qwen_chat_audio')
    expect(http!.apiModel).toBeUndefined()
    expect(http!.omni).toBe(true)
    // 它没有实时字幕能力，别顺手标上 streaming
    expect(http!.streaming).toBeUndefined()
    // HTTP 那条路才允许改地址
    expect(http!.supportsCustomUrl).toBe(true)

    const ws = models.find((m) => m.id === 'qwen3.8-omni-flash-realtime')
    expect(ws).toBeTruthy()
    expect(ws!.provider).toBe('qwen_omni')
    // 产品名已经带 -realtime，补 apiModel 会变成 -realtime-realtime
    expect(ws!.apiModel).toBeUndefined()
    expect(ws!.omni).toBe(true)
    expect(ws!.streaming).toBeUndefined()
    // realtime WebSocket 改地址没有意义，而且那几份实现压根不读 extra.baseUrl
    expect(ws!.supportsCustomUrl).toBeUndefined()
    expect(asrEndpointUrl(profile({
      provider: 'qwen', model: 'qwen3.8-omni-flash-realtime', apiUrl: 'https://evil.example/v1',
    }))).toBe('')
  })

  /**
   * 「协议卡」的不变量：必须有地址占位示例、必须只给一个默认模型。
   *
   * 占位示例是这类卡唯一的填写线索（我们说不出对面是谁），少了它用户只能猜。
   */
  it('协议卡只有一张，有地址占位示例，且地址必填', () => {
    const custom = ASR_PROVIDERS.filter((p) => p.customEndpoint)
    // 刻意只留一张：曾经按协议分成两张让用户自己选，但用户没办法知道对面说哪种协议。
    // 合并之后协议由 Rust 侧探测（asr_openai_compat.rs）。
    expect(custom.map((p) => p.id)).toEqual(['openai_compat'])
    for (const p of custom) {
      expect(p.urlPlaceholder?.trim()).toBeTruthy()
      expect(asrModelsOf(p)).toHaveLength(1)
      for (const model of asrModelsOf(p)) {
        expect(model.supportsCustomUrl).toBe(true)
        expect(model.requiresCustomUrl).toBe(true)
      }
    }
  })

  /**
   * 「能不能改地址」是**协议**的属性，所以必须挂在模型上、不能挂在卡片上。
   *
   * 千问那张卡就是反例的来源：`qwen3.8-omni-flash` 是 HTTP（能改），
   * `qwen3.5-omni-plus` 是 realtime WebSocket（改不了）。挂在卡片上表达不了这种混合，
   * 而弄错的后果是「界面上让我填了地址，实际发的还是官方地址」——静默不一致。
   */
  it('只有 HTTP 协议的模型才允许改地址，WebSocket 的一律不给', () => {
    // 这几个 provider 走 WebSocket，地址改不了
    const websocketProviders = new Set([
      'doubao_v2', 'qwen_audio_stream', 'qwen_realtime', 'qwen_omni',
      'openai_live_transcribe', 'gemini_live_transcribe',
    ])
    for (const entry of ASR_PROVIDERS) {
      for (const model of asrModelsOf(entry)) {
        if (websocketProviders.has(model.provider)) {
          expect(model.supportsCustomUrl).toBeFalsy()
        }
      }
    }
    // 而 HTTP 那些必须开着，否则用中转站的用户接不上
    const qwenModels = asrModelsOf(findAsrProvider('qwen')!)
    expect(qwenModels.find((m) => m.id === 'qwen3.8-omni-flash')!.supportsCustomUrl).toBe(true)
    expect(qwenModels.find((m) => m.id === 'qwen3.5-omni-plus')!.supportsCustomUrl).toBeFalsy()
    for (const id of ['gpt-transcribe', 'whisper-1']) {
      expect(asrModelsOf(findAsrProvider('openai')!).find((m) => m.id === id)!.supportsCustomUrl)
        .toBe(true)
    }
    expect(asrModelsOf(findAsrProvider('openai')!)
      .find((m) => m.id === 'gpt-live-transcribe')!.supportsCustomUrl).toBeFalsy()
  })

  /** requiresCustomUrl 只能出现在协议卡上：内置卡的地址是可选覆盖，不是必填。 */
  it('内置卡的地址是可选的，不是必填', () => {
    for (const entry of ASR_PROVIDERS) {
      if (entry.customEndpoint) continue
      for (const model of asrModelsOf(entry)) {
        expect(model.requiresCustomUrl).toBeFalsy()
      }
    }
  })

  /**
   * 模型下拉里必须能看到**真实 ID**，不能只有中文短名。
   *
   * 短名说明这是什么，真实 ID 才是能拿去对服务商文档、能在日志和账单里搜到的
   * 那个东西 —— 只给短名的话用户根本对不上号。
   */
  /**
   * 每个模型的显示名就是它的真实 ID —— 清单里**不允许**再出现中文短名。
   *
   * 这条钉的是一次真实的困惑：短名本来是「一张卡 = 一个模型」时代的卡片标题
   * （「千问 ASR 一次性」靠「一次性」跟流式那张卡对比），归拢成一卡一平台之后它们
   * 成了卡内的模型名，用户在「模型」那一栏看到的就是一个不像模型的词。
   * 真实 ID 既一眼认得出，又能拿去对服务商文档和账单。
   */
  it('模型清单里只用真实模型 ID，不带中文短名', () => {
    for (const entry of ASR_PROVIDERS) {
      for (const option of asrModelsOf(entry)) {
        expect(option.id.trim()).not.toBe('')
        // 真实模型 ID 不含中日韩字符；出现了就说明有人又把短名写回来了
        expect(option.id).not.toMatch(/[\u4e00-\u9fff]/)
      }
    }
  })

  it('findAsrProvider 查得到也查不崩', () => {
    expect(findAsrProvider('doubao')?.platform).toBe('doubao')
    expect(findAsrProvider('nope')).toBeUndefined()
  })
})

describe('groupAsrModelsByVendor', () => {
  const opt = (id: string): AsrModelOption => ({ id, provider: 'openrouter_transcribe' })

  it('带厂商前缀时按厂商分组，组内保持原顺序', () => {
    const groups = groupAsrModelsByVendor(
      ['openai/gpt-transcribe', 'qwen/a', 'qwen/b', 'openai/whisper-1'].map(opt),
    )!
    // openai 组排第一，因为默认模型在里面；同组的 whisper-1 归并进来
    expect(groups.map(([vendor, models]) => [vendor, models.map((m) => m.id)])).toEqual([
      ['openai', ['openai/gpt-transcribe', 'openai/whisper-1']],
      ['qwen', ['qwen/a', 'qwen/b']],
    ])
  })

  /**
   * 不带前缀的一律不分组。直连那几张卡的模型名是 `whisper-large-v3` 这种裸名，
   * 硬分组会得到一个名叫空串的 optgroup。
   */
  it('模型名不带前缀、或只有一个时不分组', () => {
    expect(groupAsrModelsByVendor(['whisper-large-v3-turbo', 'whisper-large-v3'].map(opt))).toBeNull()
    expect(groupAsrModelsByVendor(['gpt-transcribe', 'openai/whisper-1'].map(opt))).toBeNull()
    expect(groupAsrModelsByVendor([opt('openai/gpt-transcribe')])).toBeNull()
    expect(groupAsrModelsByVendor([])).toBeNull()
  })

  it('目录里只有 OpenRouter 那张卡会分组', () => {
    const grouped = ASR_PROVIDERS
      .filter((p) => groupAsrModelsByVendor(asrModelsOf(p)) !== null)
      .map((p) => p.id)
    expect(grouped).toEqual(['openrouter'])
  })

  /** 默认模型所在的组必须排在最前面，否则下拉打开时要往下翻才看到推荐项 */
  it('默认模型所在的组排最前', () => {
    const models = asrModelsOf(findAsrProvider('openrouter')!)
    const groups = groupAsrModelsByVendor(models)!
    expect(groups[0][1][0].id).toBe(models[0].id)
  })
})

describe('parseAsrProfiles 容错', () => {
  it('非数组一律当空列表', () => {
    expect(parseAsrProfiles(null)).toEqual([])
    expect(parseAsrProfiles({})).toEqual([])
    expect(parseAsrProfiles('x')).toEqual([])
  })

  it('丢掉供应商不在内置清单里的条目', () => {
    // 留着只会渲染出一张点不动的卡
    const r = parseAsrProfiles([
      { id: 'a', provider: 'doubao_v2' },
      { id: 'b', provider: 'gpt-4-asr' },
      { id: 'c' },
    ])
    expect(r.map((p) => p.id)).toEqual(['a'])
  })

  it('丢掉重复 id', () => {
    const r = parseAsrProfiles([
      { id: 'a', provider: 'doubao_v2' },
      { id: 'a', provider: 'qwen' },
    ])
    expect(r).toHaveLength(1)
  })

  it('缺字段补成空串，不会渲染出 undefined', () => {
    const [p] = parseAsrProfiles([{ id: 'a', provider: 'qwen' }])
    expect(p.apiKey).toBe('')
    expect(p.appId).toBe('')
    expect(p.workspaceId).toBe('')
    expect(p.omniPrompt).toBe('')
    expect(p.console).toBe('new')
    // 老配置没有 model 字段，会按 provider 迁移出对应的那个模型
    expect(p.provider).toBe('qwen')
    expect(p.model).toBe('qwen3-asr-flash')
  })

  /**
   * **存量配置的迁移是这次重构最要紧的一条。**
   *
   * 改成「一张卡 = 一个平台」后，老 profile 里 provider 存的还是旧分发 key
   * （`qwen_audio_stream`、`gemini_live_transcribe`…），那些值不再是任何卡片的 id。
   * 没有迁移，parseAsrProfiles 会把它们整条丢掉 —— 用户的服务配置连密钥一起消失。
   */
  it('存量条目按旧 provider 迁移成（卡片, 模型），密钥不丢', () => {
    const legacy = [
      { id: 'a', provider: 'qwen_audio_stream', apiKey: 'sk-qwen' },
      { id: 'b', provider: 'doubao_v2', apiKey: 'KEY', appId: '123', console: 'legacy' },
      { id: 'c', provider: 'gemini_live_transcribe', apiKey: 'AIza' },
      { id: 'd', provider: 'openai_transcribe', apiKey: 'sk-oa' },
      { id: 'e', provider: 'groq_whisper', apiKey: 'gsk' },
      { id: 'f', provider: 'openrouter_transcribe', apiKey: 'sk-or' },
      // 更早的别名也要认
      { id: 'g', provider: 'aliyun', apiKey: 'sk-old' },
    ]
    const out = parseAsrProfiles(legacy)
    expect(out.map((p) => [p.provider, p.model])).toEqual([
      ['qwen', 'qwen-audio-3.0-asr-flash-streaming'],
      ['doubao', 'Doubao-Seed-ASR-2.0'],
      ['google', 'gemini-3.5-transcribe-live'],
      ['openai', 'gpt-transcribe'],
      ['groq', 'whisper-large-v3-turbo'],
      ['openrouter', 'openai/gpt-transcribe'],
      ['qwen', 'qwen3-asr-flash'],
    ])
    // 密钥与豆包那套代次字段都要原样带过来
    expect(out[0].apiKey).toBe('sk-qwen')
    expect(out[1].appId).toBe('123')
    expect(out[1].console).toBe('legacy')
  })

  /** 已经是新格式的条目（带 model）不该被迁移逻辑改动 */
  it('新格式条目原样保留', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'qwen', model: 'qwen3.5-omni-flash', apiKey: 'k' },
    ])
    expect(out[0].provider).toBe('qwen')
    expect(out[0].model).toBe('qwen3.5-omni-flash')
  })

  /**
   * **这条是那次"卡片全没了"的回归测试。**
   *
   * `model` 字段是上一个版本就加进来的（那时它表示"同实现下选哪个模型"），所以存量里
   * `provider='gemini_transcribe'` + `model='gemini-3.5-transcribe'` 是完全正常的组合。
   * 迁移判据一度写成「有 model 就是新数据」，于是这类条目被判成新格式、
   * `findAsrProvider('gemini_transcribe')` 返回 undefined、整条被丢掉 ——
   * 用户打开设置页发现自己配的卡连密钥一起消失了。
   */
  it('旧 provider 配着旧 model 的条目不能被丢掉', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'gemini_transcribe', model: 'gemini-3.5-transcribe', apiKey: 'AIza' },
      { id: 'b', provider: 'openai_live_transcribe', model: 'gpt-live-transcribe', apiKey: 'sk' },
      { id: 'c', provider: 'openrouter_transcribe', model: 'openai/gpt-transcribe', apiKey: 'or' },
    ])
    expect(out).toHaveLength(3)
    expect(out.map((p) => [p.provider, p.model])).toEqual([
      ['google', 'gemini-3.5-transcribe'],
      ['openai', 'gpt-live-transcribe'],
      ['openrouter', 'openai/gpt-transcribe'],
    ])
    expect(out[0].apiKey).toBe('AIza')
  })

  /** 用户在旧卡上选过的模型，只要新卡也有就保留 —— 不该被打回默认 */
  it('迁移时保留用户选过的模型', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'groq_whisper', model: 'whisper-large-v3', apiKey: 'gsk' },
      { id: 'b', provider: 'openai_transcribe', model: 'whisper-1', apiKey: 'sk' },
    ])
    expect(out.map((p) => [p.provider, p.model])).toEqual([
      ['groq', 'whisper-large-v3'],
      ['openai', 'whisper-1'],
    ])
  })

  /**
   * 上一代 Omni 的旧 id 也要能落下来。
   *
   * 它们指向的模型本身已经从目录里删掉（被百炼缩容），但这些卡**不能**丢，也不能
   * 落到卡片默认那个纯 ASR 模型上 —— 那会把用户从「不用配 AI 服务」悄悄搬到
   * 「必须另配 AI 服务」。所以两个都落到同族还活着的 qwen3.5-omni-flash。
   */
  it('上一代 Omni 的旧 provider 迁到同族还活着的模型', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'qwen_omni_turbo', apiKey: 'k' },
      { id: 'b', provider: 'qwen_omni_flash', apiKey: 'k' },
      { id: 'c', provider: 'qwen_omni_plus', apiKey: 'k' },
    ])
    expect(out.map((p) => [p.provider, p.model])).toEqual([
      ['qwen', 'qwen3.5-omni-flash'],
      ['qwen', 'qwen3.5-omni-flash'],
      ['qwen', 'qwen3.5-omni-plus'],
    ])
    // 迁完必须还是 Omni（识别+整理一体），否则这条迁移就没有意义
    for (const profile of out) {
      expect(resolveAsrModelOption(profile)!.omni).toBe(true)
    }
  })

  /**
   * 已经是「新数据形态」的退役模型也要接住。
   *
   * 这是上一条覆盖不到的另一半：`provider` 已经迁成卡片 id `qwen`、`model` 里存着
   * 退役的模型名。这种条目走的是 migrateLegacyProvider 的回落分支，而回落到卡片
   * 默认会得到一个**纯 ASR** 模型 —— Omni 用户的整理能力会无声消失。
   */
  it('新数据形态里的退役 Omni 也落到同族替代', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'qwen', model: 'qwen3-omni-flash', apiKey: 'k' },
      { id: 'b', provider: 'qwen', model: 'qwen-omni-turbo', apiKey: 'k' },
    ])
    expect(out.map((p) => p.model)).toEqual([
      'qwen3.5-omni-flash', 'qwen3.5-omni-flash',
    ])
    for (const profile of out) {
      expect(resolveAsrModelOption(profile)!.omni).toBe(true)
    }
  })

  /**
   * 认不出的模型名不丢条目，但**落点取决于 provider 值走的是哪条分支**。
   *
   * `qwen` 同时是旧分发 key 和卡片 id，所以它先命中 LEGACY_PROVIDERS，落到那张表
   * 指定的 qwen3-asr-flash，而不是卡片第一项（3.1 流式）。这不是 bug：对存量数据
   * 来说「provider 是 qwen」本来就等于「用 qwen3-asr-flash 那个模型」。
   *
   * 这条钉在这里是因为它反过来解释了 RETIRED_MODELS 为什么必须在所有分支之前
   * 执行 —— 放在后面就会被这条 LEGACY 分支抢先返回。
   */
  it('认不出的模型名不丢条目，落到 LEGACY 表指定的那个', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'qwen', model: 'qwen-something-that-never-existed', apiKey: 'k' },
    ])
    expect(out.map((p) => p.model)).toEqual(['qwen3-asr-flash'])
  })

  /** 纯卡片 id（不在 LEGACY 表里）配认不出的模型名，才走「回落到卡片默认」 */
  it('不在迁移表里的卡片 id 才回落到卡片默认', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'openrouter', model: 'nope/does-not-exist', apiKey: 'k' },
    ])
    expect(out.map((p) => p.model)).toEqual(['openai/gpt-transcribe'])
  })

  /** 真正认不出来的不进列表：provider 既不是卡片 id 也不在迁移表里 */
  it('完全认不出的 provider 不进列表', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'some_removed_vendor', model: 'x', apiKey: 'k' },
      { id: 'b', provider: 'qwen', model: 'qwen3-asr-flash', apiKey: 'k' },
    ])
    expect(out.map((p) => p.id)).toEqual(['b'])
  })

  /**
   * **但它不能从磁盘上消失。**
   *
   * 这是那次数据损失的第二道防线：解析不出来的条目要原样交回给调用方，
   * 由 saveAsrProfiles 拼回存储。否则「解析失败」会在下一次归一化写回时
   * 变成「永久删除」—— 用户丢的是配置连带密钥，而密钥没有第二份。
   */
  it('解析不出来的条目原样交回，不丢', () => {
    const raw = [
      { id: 'a', provider: 'some_removed_vendor', model: 'x', apiKey: 'secret1' },
      { id: 'b', provider: 'qwen', model: 'qwen3-asr-flash', apiKey: 'k' },
      'not an object',
      { id: 'b', provider: 'qwen', model: 'qwen3-asr-flash' }, // 重复 id
    ]
    const { profiles, orphans } = parseAsrProfilesDetailed(raw)
    expect(profiles.map((p) => p.id)).toEqual(['b'])
    // 三种落选原因都要留痕：认不出的 provider、非对象、重复 id
    expect(orphans).toHaveLength(3)
    expect(orphans[0]).toBe(raw[0])
    expect(orphans[1]).toBe(raw[2])
    expect(orphans[2]).toBe(raw[3])
  })

  it('全都能解析时 orphans 为空', () => {
    const { orphans } = parseAsrProfilesDetailed([
      { id: 'a', provider: 'qwen', model: 'qwen3-asr-flash' },
      { id: 'b', provider: 'gemini_transcribe', model: 'gemini-3.5-transcribe' },
    ])
    expect(orphans).toEqual([])
  })

  /** provider 是卡片 id 但 model 不认识（新建没选 / 模型下线）→ 回落该卡默认 */
  it('模型名不认识时回落到该卡默认，条目不丢', () => {
    const out = parseAsrProfiles([
      { id: 'a', provider: 'google', model: 'gemini-9-nonexistent', apiKey: 'k' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].model).toBe('gemini-3.5-transcribe')
  })

  it('console 只认 new / legacy，其它值回落到 new', () => {
    expect(parseAsrProfiles([{ id: 'a', provider: 'doubao_v2', console: 'legacy' }])[0].console).toBe('legacy')
    expect(parseAsrProfiles([{ id: 'a', provider: 'doubao_v2', console: 'garbage' }])[0].console).toBe('new')
  })

  it('坏的检测结论被丢掉，好的保留', () => {
    const r = parseAsrProfiles([
      { id: 'a', provider: 'qwen', check: { ok: true, at: 100, latencyMs: 800, audioSec: 3 } },
      { id: 'b', provider: 'qwen', check: { ok: true } },
      { id: 'c', provider: 'qwen', check: 'nope' },
    ])
    expect(r[0].check).toEqual({ ok: true, at: 100, latencyMs: 800, audioSec: 3, reason: undefined })
    expect(r[1].check).toBeUndefined()
    expect(r[2].check).toBeUndefined()
  })

  it('没有 id 时自动补一个，不会整条丢掉', () => {
    const r = parseAsrProfiles([{ provider: 'qwen', apiKey: 'sk-1' }])
    expect(r).toHaveLength(1)
    expect(r[0].id).not.toBe('')
  })
})

describe('resolveActiveAsrProfile', () => {
  it('指向不存在的 id 时回落到第一条', () => {
    const list = [profile({ id: 'a' }), profile({ id: 'b' })]
    expect(resolveActiveAsrProfile(list, 'zzz')?.id).toBe('a')
    expect(resolveActiveAsrProfile(list, 'b')?.id).toBe('b')
  })

  it('空列表返回 null', () => {
    expect(resolveActiveAsrProfile([], 'a')).toBeNull()
  })
})

describe('resolveAsrModel', () => {
  it('没选过就用该卡的默认模型', () => {
    expect(resolveAsrModel(profile({ provider: 'groq', model: '' }))).toBe('whisper-large-v3-turbo')
    expect(resolveAsrModel(profile({ provider: 'groq', model: '  ' }))).toBe('whisper-large-v3-turbo')
    expect(resolveAsrModel(profile({ provider: 'openai', model: '' }))).toBe('gpt-transcribe')
  })

  it('选过就用选的那个', () => {
    expect(resolveAsrModel(profile({ provider: 'groq', model: 'whisper-large-v3' })))
      .toBe('whisper-large-v3')
    expect(resolveAsrModel(profile({ provider: 'openai', model: 'whisper-1' })))
      .toBe('whisper-1')
  })

  /**
   * 不在清单里的一律回落，不原样发出去。
   *
   * 两种来路：服务商下线了某个模型（他们淘汰模型比我们改代码勤），
   * 或者用户先在 Groq 卡上选了 whisper-large-v3、再把供应商换成 OpenAI。
   * 照发只会换来一个含义模糊的 400，而用户完全不知道自己发了什么。
   */
  it('模型不属于这张卡时回落到默认', () => {
    expect(resolveAsrModel(profile({ provider: 'openai', model: 'whisper-large-v3' })))
      .toBe('gpt-transcribe')
    expect(resolveAsrModel(profile({ provider: 'groq', model: 'gpt-transcribe' })))
      .toBe('whisper-large-v3-turbo')
    expect(resolveAsrModel(profile({ provider: 'doubao', model: 'whatever' })))
      .toBe('Doubao-Seed-ASR-2.0')
  })
})

/**
 * 运行时那两个键 —— **这是卡片 id 与后端实现分离之后最容易搞错的地方。**
 *
 * `cloudAsr.provider` 必须是选中模型的 provider（Rust 的分发 key），不是卡片 id；
 * 写成卡片 id 的话 Rust 会报 "ASR provider not implemented"。
 * `cloudAsr.model` 必须是 apiModel（Omni 那两个带 -realtime 后缀）。
 */
describe('运行时键解析', () => {
  it('provider 取选中模型的实现，不是卡片 id', () => {
    expect(resolveAsrRuntimeProvider(profile({ provider: 'qwen', model: 'qwen3-asr-flash' })))
      .toBe('qwen')
    expect(resolveAsrRuntimeProvider(
      profile({ provider: 'qwen', model: 'qwen-audio-3.0-asr-flash-streaming' }),
    )).toBe('qwen_audio_stream')
    expect(resolveAsrRuntimeProvider(
      profile({ provider: 'qwen', model: 'qwen3-asr-flash-realtime' }),
    )).toBe('qwen_realtime')
    expect(resolveAsrRuntimeProvider(profile({ provider: 'qwen', model: 'qwen3.5-omni-plus' })))
      .toBe('qwen_omni')
    // 同一张 OpenAI 卡，两个模型走两份实现
    expect(resolveAsrRuntimeProvider(profile({ provider: 'openai', model: 'gpt-transcribe' })))
      .toBe('openai_transcribe')
    expect(resolveAsrRuntimeProvider(profile({ provider: 'openai', model: 'gpt-live-transcribe' })))
      .toBe('openai_live_transcribe')
  })

  it('model 取 apiModel —— Omni 的接口名带 -realtime 后缀', () => {
    expect(resolveAsrApiModel(profile({ provider: 'qwen', model: 'qwen3.5-omni-plus' })))
      .toBe('qwen3.5-omni-plus-realtime')
    expect(resolveAsrApiModel(profile({ provider: 'qwen', model: 'qwen3.5-omni-flash' })))
      .toBe('qwen3.5-omni-flash-realtime')
    // 没有 apiModel 的就用 id 本身
    expect(resolveAsrApiModel(profile({ provider: 'groq', model: 'whisper-large-v3' })))
      .toBe('whisper-large-v3')
  })

  it('卡片不存在时给空串，不抛', () => {
    expect(resolveAsrRuntimeProvider(profile({ provider: 'nope', model: 'x' }))).toBe('')
    expect(resolveAsrApiModel(profile({ provider: 'nope', model: 'x' }))).toBe('')
  })
})

describe('effectiveAsrCredentials', () => {
  // 核心不变量：Rust 侧靠 app_id 空不空来选两代鉴权头
  it('豆包新版控制台必须把 appId 清空', () => {
    const p = profile({
      provider: 'doubao', console: 'new', apiKey: 'APPKEY', otherKey: 'TOKEN', appId: '1234567890',
    })
    expect(effectiveAsrCredentials(p)).toEqual({ apiKey: 'APPKEY', appId: '' })
  })

  it('豆包旧版控制台用 Access Token + App ID', () => {
    const p = profile({
      provider: 'doubao', console: 'legacy', apiKey: 'TOKEN', otherKey: 'APPKEY', appId: '1234567890',
    })
    expect(effectiveAsrCredentials(p)).toEqual({ apiKey: 'TOKEN', appId: '1234567890' })
  })

  it('非豆包平台不带 appId', () => {
    const p = profile({ provider: 'qwen', apiKey: ' sk-1 ', appId: '999' })
    expect(effectiveAsrCredentials(p)).toEqual({ apiKey: 'sk-1', appId: '' })
  })
})

describe('describeAsrMissing', () => {
  it('豆包新版只要密钥', () => {
    expect(describeAsrMissing(profile({ provider: 'doubao', console: 'new' }))).toBe('还没填 API Key')
    expect(describeAsrMissing(profile({ provider: 'doubao', console: 'new', apiKey: 'k' }))).toBe('')
  })

  it('豆包旧版两个都要，且先报密钥', () => {
    expect(describeAsrMissing(profile({ provider: 'doubao', console: 'legacy' }))).toBe('还没填 Access Token')
    expect(describeAsrMissing(profile({ provider: 'doubao', console: 'legacy', apiKey: 't' }))).toBe('还没填 App ID')
    expect(describeAsrMissing(profile({ provider: 'doubao', console: 'legacy', apiKey: 't', appId: '1' }))).toBe('')
  })

  it('其它平台只要 API Key', () => {
    expect(describeAsrMissing(profile({ provider: 'mimo' }))).toBe('还没填 API Key')
    expect(describeAsrMissing(profile({ provider: 'mimo', apiKey: 'k' }))).toBe('')
  })
})

describe('asrEndpointUrl', () => {
  /**
   * ⚠️ 这一组守的是「音频不会被发到用户没打算用的地址」。
   *
   * 闸门必须看**选中的模型**，不能看卡片：档案里的 apiUrl 会残留（换过供应商、
   * 换过模型都会留下），而残值一旦被发出去，音频就去了一个用户早就不用的地方。
   */
  it('模型不支持改地址时，残留的 apiUrl 一律不发出去', () => {
    // qwen3.5-omni-plus 是 realtime WebSocket，地址改不了
    const ws = profile({
      provider: 'qwen',
      model: 'qwen3.5-omni-plus',
      apiUrl: 'http://leftover.example/v1',
    })
    expect(asrEndpointUrl(ws)).toBe('')

    // 同一张卡换成 HTTP 的那个模型，同一个地址就该生效了
    const http = { ...ws, model: 'qwen3.8-omni-flash' }
    expect(asrEndpointUrl(http)).toBe('http://leftover.example/v1')
  })

  it('地址留空时返回空串，让后端用官方地址', () => {
    const p = profile({ provider: 'openai', model: 'gpt-transcribe', apiUrl: '   ' })
    expect(asrEndpointUrl(p)).toBe('')
  })

  it('内置卡填了地址就生效 —— 中转站 / 反代要靠这个', () => {
    const p = profile({
      provider: 'openai',
      model: 'gpt-transcribe',
      apiUrl: 'https://relay.example/v1',
    })
    expect(asrEndpointUrl(p)).toBe('https://relay.example/v1')
  })
})

describe('parseAsrCompatProtocol', () => {
  it('只认三个显式值，其余一律当自动', () => {
    expect(parseAsrCompatProtocol('transcriptions')).toBe('transcriptions')
    expect(parseAsrCompatProtocol('chat')).toBe('chat')
    expect(parseAsrCompatProtocol('chat_standard')).toBe('chat_standard')
    for (const junk of ['auto', '', 'nope', undefined, null, 42, {}]) {
      expect(parseAsrCompatProtocol(junk)).toBe('auto')
    }
  })
})

describe('asrCardTitle', () => {
  /**
   * ⚠️ 这一组的核心是**标题里绝不能出现密钥的任何部分**。
   *
   * 这里原来的做法是同平台多张卡时补「•• + 密钥末 4 位」。用户看到的第一反应是
   * 「我的 API Key 怎么被显示出来了」——在一个专门用眼睛图标遮住密钥的界面里，
   * 标题上却挂着密钥尾巴，这个自相矛盾比它解决的问题更严重。
   * 把它改回去，这组测试会红。
   */
  it('绝不把密钥的任何片段拼进标题', () => {
    const key = 'sk-abcdef1234'
    const p = profile({ provider: 'qwen', apiKey: key })
    for (const siblings of [1, 2, 5]) {
      const title = asrCardTitle(p, siblings)
      expect(title).not.toContain('1234')
      expect(title).not.toContain(key.slice(-4))
      expect(title).not.toContain('••')
    }
  })

  it('用户起了名字就用名字', () => {
    expect(asrCardTitle(profile({ provider: 'qwen', name: '公司账号' }), 2)).toBe('公司账号')
    // 只有一张卡时也用，名字是用户的选择、不是区分手段
    expect(asrCardTitle(profile({ provider: 'qwen', name: '公司账号' }), 1)).toBe('公司账号')
    // 纯空白当没填
    expect(asrCardTitle(profile({ provider: 'qwen', name: '   ' }), 1))
      .toBe(findAsrProvider('qwen')!.label)
  })

  it('没起名字时只显示平台名', () => {
    expect(asrCardTitle(profile({ provider: 'qwen' }), 1)).toBe(findAsrProvider('qwen')!.label)
    expect(asrCardTitle(profile({ provider: 'qwen' }), 3)).toBe(findAsrProvider('qwen')!.label)
  })

  /** 自建卡之间真正的差别是「连的是哪台」，主机名非机密，拿它区分正好。 */
  it('自定义端点的多张卡用主机名区分', () => {
    const p = profile({ provider: 'openai_compat', apiUrl: 'http://192.168.1.9:9000/v1' })
    expect(asrCardTitle(p, 2)).toContain('192.168.1.9:9000')
    // 只有一张卡时不加后缀，标题保持干净
    expect(asrCardTitle(p, 1)).toBe(findAsrProvider('openai_compat')!.label)
  })

  /** 内置卡即使档案里残留了 apiUrl 也不能显示它 —— 那个值不会被使用。 */
  it('内置卡不显示残留的 apiUrl', () => {
    const p = profile({ provider: 'qwen', apiUrl: 'http://leftover.example/v1' })
    expect(asrCardTitle(p, 2)).not.toContain('leftover')
  })
})

describe('gradeAsrLatency', () => {
  // 口径是 RTF，不是绝对毫秒。3 秒音频花 1 秒是正常水平，
  // 若照搬 AI 服务那套「1 秒就算慢」的阈值，所有 ASR 都会被标成太慢。
  it('3 秒音频花 1 秒算正常，不算慢', () => {
    expect(gradeAsrLatency(1000, 3).tone).toBe('ok')
    expect(gradeAsrLatency(1000, 3).label).toBe('正常')
  })

  it('按 RTF 分档', () => {
    expect(gradeAsrLatency(300, 3).label).toBe('极速')
    expect(gradeAsrLatency(700, 3).label).toBe('很快')
    expect(gradeAsrLatency(1200, 3).label).toBe('正常')
    expect(gradeAsrLatency(2000, 3).label).toBe('偏慢')
    expect(gradeAsrLatency(3000, 3).label).toBe('太慢')
  })

  it('同样的毫秒数，音频越长档位越好', () => {
    // 刻意不取边界值：阈值是「小于」，1500/10s 正好等于 0.15 会落进 fast 而非 instant
    expect(gradeAsrLatency(1000, 2).tier).toBe('slow')
    expect(gradeAsrLatency(1000, 10).tier).toBe('instant')
  })

  it('阈值是「小于」，边界值落进下一档', () => {
    expect(gradeAsrLatency(150, 1).tier).toBe('fast')
    expect(gradeAsrLatency(149, 1).tier).toBe('instant')
  })

  it('只有太慢才给 bad —— 红色留给「不可用」', () => {
    expect(gradeAsrLatency(2000, 3).tone).toBe('warn')
    expect(gradeAsrLatency(9000, 3).tone).toBe('bad')
  })

  it('音频时长缺失时不硬猜档位', () => {
    expect(gradeAsrLatency(1000, 0).label).toBe('已测通')
    expect(gradeAsrLatency(1000, NaN).label).toBe('已测通')
  })
})
