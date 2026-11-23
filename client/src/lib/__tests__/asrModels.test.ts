import { describe, it, expect } from 'vitest'
import {
  buildAsrExtra,
  isIntegratedAsrProvider,
  isQwenOmniProvider,
  isStreamingDisplayCapable,
  isStreamingDisplayReady,
  resolveQwenOmniModel,
  resolveAsrDisplayModel,
} from '../asrModels'

describe('isQwenOmniProvider', () => {
  it('识别 Qwen Omni 系列', () => {
    expect(isQwenOmniProvider('qwen_omni_plus')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_35_plus')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_35_flash')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_flash')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_turbo')).toBe(true)
  })

  it('非 Omni 返回 false', () => {
    expect(isQwenOmniProvider('doubao_v2')).toBe(false)
    expect(isQwenOmniProvider('qwen')).toBe(false)
    expect(isQwenOmniProvider('')).toBe(false)
  })
})

describe('isIntegratedAsrProvider', () => {
  /**
   * qwen3.8-omni-flash 的回归测试。它走 HTTP，运行时 key 是 qwen_chat_audio。
   * 以前录音链路拿 isQwenOmniProvider 判「按不按 Omni 处理」，于是它被漏掉：
   * System Prompt 发不出去，AI 策略也不走 integrated_asr。
   */
  it('HTTP 的 Omni 也算，哪怕它不以 qwen_omni 开头', () => {
    expect(isIntegratedAsrProvider('qwen_chat_audio')).toBe(true)
    expect(isQwenOmniProvider('qwen_chat_audio')).toBe(false)
  })

  it('realtime 的 Omni 与旧运行时键都算', () => {
    for (const provider of [
      'qwen_omni', 'qwen_omni_plus', 'qwen_omni_35_plus', 'qwen_omni_35_flash', 'qwen_omni_flash', 'qwen_omni_turbo',
    ]) {
      expect(isIntegratedAsrProvider(provider)).toBe(true)
    }
  })

  // openai_chat_audio 是「OpenAI 兼容」卡的对话协议：模型名由用户填，对面是谁不知道，
  // 不能因为协议相同就当成 Omni、把客户端 AI 跳过去
  it('普通识别不算', () => {
    for (const provider of [
      'qwen', 'qwen_audio_stream', 'qwen_realtime', 'doubao_v2', 'groq_whisper',
      'openai_chat_audio', 'openai_chat_audio_standard', 'openai_compat', '',
    ]) {
      expect(isIntegratedAsrProvider(provider)).toBe(false)
    }
  })
})

describe('resolveQwenOmniModel', () => {
  it('返回正确的模型 ID', () => {
    expect(resolveQwenOmniModel('qwen_omni_35_plus')).toBe('qwen3.5-omni-plus-realtime')
    expect(resolveQwenOmniModel('qwen_omni_35_flash')).toBe('qwen3.5-omni-flash-realtime')
  })

  /**
   * 两个退役运行时键必须仍然解析出**某个还活着的** Omni，不能变成 undefined。
   *
   * undefined 会让 buildAsrExtra 不带 model 字段，于是落点交给 Rust 侧的
   * DEFAULT_MODEL 去定 —— 两处各自演进就会漂，而漂了没人会发现。
   * 落点也必须和 asrProviderCatalog 的 RETIRED_MODELS 一致。
   */
  it('退役的运行时键落到同族还活着的模型', () => {
    expect(resolveQwenOmniModel('qwen_omni_flash')).toBe('qwen3.5-omni-flash-realtime')
    expect(resolveQwenOmniModel('qwen_omni_turbo')).toBe('qwen3.5-omni-flash-realtime')
  })

  it('非 Omni 返回 undefined', () => {
    expect(resolveQwenOmniModel('doubao_v2')).toBeUndefined()
    expect(resolveQwenOmniModel('qwen')).toBeUndefined()
  })
})

describe('resolveAsrDisplayModel', () => {
  it('映射已知供应商', () => {
    expect(resolveAsrDisplayModel('doubao_v2')).toBe('Doubao-Seed-ASR-2.0')
    expect(resolveAsrDisplayModel('qwen')).toBe('qwen3-asr-flash')
    expect(resolveAsrDisplayModel('mimo')).toBe('mimo-v2.5-asr')
    expect(resolveAsrDisplayModel('qwen_omni_35_plus')).toBe('qwen3.5-omni-plus-realtime')
  })

  it('未知供应商返回原始 key', () => {
    expect(resolveAsrDisplayModel('custom_provider')).toBe('custom_provider')
  })

  it('空字符串返回 unknown', () => {
    expect(resolveAsrDisplayModel('')).toBe('unknown')
  })

  // 用户选了同一家的另一个模型时，显示必须跟着走 —— 否则历史记录、诊断、
  // 识别测试三处都会报该服务的默认模型，看着像"我选的没生效"
  it('选定的模型优先于默认表', () => {
    expect(resolveAsrDisplayModel('groq_whisper')).toBe('whisper-large-v3-turbo')
    expect(resolveAsrDisplayModel('groq_whisper', 'whisper-large-v3')).toBe('whisper-large-v3')
    expect(resolveAsrDisplayModel('openai_transcribe')).toBe('gpt-transcribe')
    expect(resolveAsrDisplayModel('openai_transcribe', 'gpt-4o-mini-transcribe'))
      .toBe('gpt-4o-mini-transcribe')
  })

  it('空白的选定值不算选过', () => {
    expect(resolveAsrDisplayModel('groq_whisper', '')).toBe('whisper-large-v3-turbo')
    expect(resolveAsrDisplayModel('groq_whisper', '   ')).toBe('whisper-large-v3-turbo')
  })
})

describe('流式实时字幕判据', () => {
  // isStreamingDisplayReady 是运行时**唯一**的闸门（CloudAPIProvider 拿它决定走不走
  // WebSocket）。光在服务目录里给一条加 streaming: true 是没有任何效果的 ——
  // 这组断言就是那份契约。
  it('有流式实现的几家都就绪，一次性那几家一律不就绪', () => {
    for (const provider of [
      'doubao_v2', 'qwen_audio_stream', 'openai_live_transcribe', 'gemini_live_transcribe',
      'xai_stt',
    ]) {
      expect(isStreamingDisplayCapable(provider)).toBe(true)
      expect(isStreamingDisplayReady(provider)).toBe(true)
    }
    // 这几个是一次性 HTTP，它们的流式版本是各自单独的一张卡
    for (const provider of [
      'qwen', 'mimo', 'groq_whisper', 'openai_transcribe', 'gemini_transcribe', 'qwen_omni_35_plus', '',
    ]) {
      expect(isStreamingDisplayCapable(provider)).toBe(false)
      expect(isStreamingDisplayReady(provider)).toBe(false)
    }
  })

  // qwen_realtime 走地域专属端点，没有业务空间 ID 连不上 —— 这条前置条件只属于它，
  // 别照抄给 qwen_audio_stream（那个用通用域名，实测不需要）。
  it('只有 qwen_realtime 要业务空间 ID 才算就绪', () => {
    expect(isStreamingDisplayCapable('qwen_realtime')).toBe(true)
    expect(isStreamingDisplayReady('qwen_realtime')).toBe(false)
    expect(isStreamingDisplayReady('qwen_realtime', '  ')).toBe(false)
    expect(isStreamingDisplayReady('qwen_realtime', 'ws-abc')).toBe(true)
    // 别家给了 workspaceId 也不影响判定
    expect(isStreamingDisplayReady('qwen_audio_stream')).toBe(true)
    expect(isStreamingDisplayReady('gemini_live_transcribe', '')).toBe(true)
  })
})

describe('buildAsrExtra', () => {
  it('普通服务：选过模型才带 extra', () => {
    expect(buildAsrExtra('groq_whisper')).toBeUndefined()
    expect(buildAsrExtra('groq_whisper', { model: '' })).toBeUndefined()
    expect(buildAsrExtra('groq_whisper', { model: '  ' })).toBeUndefined()
    expect(buildAsrExtra('groq_whisper', { model: 'whisper-large-v3' }))
      .toEqual({ model: 'whisper-large-v3' })
  })

  /**
   * ⚠️ 这条是一次静默 bug 的回归测试。
   *
   * 「一张卡 = 一个平台」之后，运行时 provider 变成了平台级的 `qwen_omni`，模型由
   * 调用方（resolveAsrApiModel）解析好再传进来。而老实现看到 provider 以 `qwen_omni`
   * 开头就去查 QWEN_OMNI_MODEL_MAP —— 表里没有 `qwen_omni` 这个键，于是
   * `extra.model` 是 undefined，后端回落到它自己的默认模型。
   * 表现是**下拉里选哪个 Omni 都跑同一个**，而界面显示一切正常。
   *
   * 老测试用的是旧 id（`qwen_omni_35_plus`，表里有），所以它一直是绿的 ——
   * 断言钉在了已经不存在的调用形态上。
   */
  it('传进来的模型必须被采纳，哪怕 provider 是 qwen_omni', () => {
    expect(buildAsrExtra('qwen_omni', { model: 'qwen3.5-omni-plus-realtime' }))
      .toEqual({ model: 'qwen3.5-omni-plus-realtime' })
    expect(buildAsrExtra('qwen_omni', {
      model: 'qwen3.5-omni-flash-realtime',
      instructions: '照原样转写',
    })).toEqual({ model: 'qwen3.5-omni-flash-realtime', instructions: '照原样转写' })
  })

  /** 存量运行时键里 provider 还是旧的那几个时，模型名仍要能从老表反查出来。 */
  it('没传模型时，旧 provider id 还能从老表兜底', () => {
    expect(buildAsrExtra('qwen_omni_35_plus'))
      .toEqual({ model: 'qwen3.5-omni-plus-realtime' })
    // 退役键兜底出来的是替代模型，不是它原来那个（见 QWEN_OMNI_MODEL_MAP 的注释）
    expect(buildAsrExtra('qwen_omni_turbo'))
      .toEqual({ model: 'qwen3.5-omni-flash-realtime' })
  })

  it('自定义端点：地址会带进 extra', () => {
    expect(buildAsrExtra('openai_compat_transcribe', {
      model: 'whisper-1',
      baseUrl: 'http://127.0.0.1:8000/v1',
    })).toEqual({ model: 'whisper-1', baseUrl: 'http://127.0.0.1:8000/v1' })
    // 空地址不进 extra，让后端用它内置的默认值
    expect(buildAsrExtra('groq_whisper', { model: 'whisper-large-v3', baseUrl: '  ' }))
      .toEqual({ model: 'whisper-large-v3' })
  })
})
