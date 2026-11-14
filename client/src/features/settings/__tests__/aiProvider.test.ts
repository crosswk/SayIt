import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  aiProvidersForDisplay,
  blankProfile,
  checkAiKeyFormat,
  checkApiUrl,
  extractTestReply,
  formatCheckedAt,
  formatLatency,
  gradeLatency,
  isCheckFresh,
  isProfileComplete,
  keyAfterProviderSwitch,
  migrateLegacyProfiles,
  parseLegacyLatencies,
  parseProfiles,
  profileSubtitle,
  profileTitle,
  preferredAiProviderValue,
  resolveActiveProfile,
  upgradeRetiredAiModel,
  upgradeRetiredAiModels,
  type AiProfile,
  type LegacyProviderData,
} from '../aiProviderCatalog'
import { setLocale } from '@/i18n'

/**
 * 这组断言守住「AI 服务」页最容易回归的几件事：
 * 1. 供应商清单是唯一真相 —— 每家都必须有默认地址和至少一个候选模型，
 *    否则选中它就会落到"两个空框 + 两个灰按钮 + 零说明"的死角。
 * 2. 格式校验只做几乎不会误报的判断 —— 对合法密钥报警的代价高于漏报。
 * 3. 服务列表的读取与启用项解析永不抛异常 —— 这个值会经过导入导出和手改数据库，
 *    一条脏数据不该让整页白屏，启用项失效也不该变成"什么都没启用"。
 */
describe('AI_PROVIDERS 清单', () => {
  it('每家都有默认地址和至少一个候选模型', () => {
    for (const p of AI_PROVIDERS) {
      expect(p.defaultUrl, `${p.value} 缺默认地址`).toMatch(/^https?:\/\//)
      expect(p.defaultModels.length, `${p.value} 缺候选模型`).toBeGreaterThan(0)
      for (const m of p.defaultModels) expect(m.trim()).not.toBe('')
    }
  })

  it('value 唯一', () => {
    const values = AI_PROVIDERS.map((p) => p.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it('只有 Ollama 是免密钥的本机服务', () => {
    expect(AI_PROVIDERS.filter((p) => p.keyless).map((p) => p.value)).toEqual(['ollama'])
  })
})

describe('地区相关的供应商默认值', () => {
  afterEach(() => setLocale('zh-CN'))

  it('英文界面优先 OpenRouter', () => {
    setLocale('en')
    expect(preferredAiProviderValue()).toBe('openrouter')
    expect(aiProvidersForDisplay()[0].value).toBe('openrouter')
    expect(blankProfile().provider).toBe('openrouter')
  })

  it('中文界面保持 DeepSeek 优先', () => {
    setLocale('zh-CN')
    expect(preferredAiProviderValue()).toBe('deepseek')
    expect(aiProvidersForDisplay()[0].value).toBe('deepseek')
    expect(blankProfile().provider).toBe('deepseek')
  })
})

describe('checkAiKeyFormat', () => {
  it('空密钥不报警', () => {
    expect(checkAiKeyFormat('deepseek', '')).toBe('')
  })

  it('粘贴带进空白字符时报警', () => {
    expect(checkAiKeyFormat('deepseek', 'sk-abc def')).toContain('空格')
    expect(checkAiKeyFormat('doubao', 'abc\ndef')).toContain('空格')
  })

  it('DeepSeek / 千问 缺 sk- 前缀时报警', () => {
    expect(checkAiKeyFormat('deepseek', 'abcdef')).toContain('sk-')
    expect(checkAiKeyFormat('qwen', 'abcdef')).toContain('sk-')
  })

  it('不再对长度做断言——供应商改长度不该让合法密钥报警', () => {
    expect(checkAiKeyFormat('deepseek', 'sk-' + 'a'.repeat(64))).toBe('')
    expect(checkAiKeyFormat('deepseek', 'sk-abc')).toBe('')
    // 豆包的 key 不是 UUID 也不报警
    expect(checkAiKeyFormat('doubao', 'not-a-uuid-at-all')).toBe('')
  })

  it('没有专门规则的供应商只查空白字符', () => {
    expect(checkAiKeyFormat('mimo', 'whatever-key')).toBe('')
    expect(checkAiKeyFormat('openai_compat', 'anything')).toBe('')
  })
})

describe('checkApiUrl', () => {
  it('空地址不报警（由提交时统一处理）', () => {
    expect(checkApiUrl('')).toBe('')
  })

  it('缺协议前缀时报警', () => {
    expect(checkApiUrl('api.deepseek.com')).toContain('http')
  })

  it('接受 http 与 https', () => {
    expect(checkApiUrl('https://api.deepseek.com')).toBe('')
    expect(checkApiUrl('http://127.0.0.1:11434')).toBe('')
  })

  it('非法网址报警', () => {
    expect(checkApiUrl('https://')).toContain('合法')
  })
})

describe('extractTestReply', () => {
  const backendDetail = [
    '耗时: 1240ms',
    '模型: deepseek-v4-flash',
    '发送: system="只回复「连接正常」四个字，不要输出任何其他内容。" user="测试"',
    '回复: 连接正常',
  ].join('\n')

  it('只取「回复」，不把内部测试提示词带出来', () => {
    expect(extractTestReply(backendDetail)).toBe('连接正常')
    expect(extractTestReply(backendDetail)).not.toContain('system=')
  })

  it('没有回复行时返回空串', () => {
    expect(extractTestReply('耗时: 5ms')).toBe('')
    expect(extractTestReply(undefined)).toBe('')
  })
})

describe('formatLatency', () => {
  it('1 秒以内用 ms，超过用秒', () => {
    expect(formatLatency(840)).toBe('840ms')
    expect(formatLatency(1240)).toBe('1.2s')
  })
})

describe('parseLegacyLatencies', () => {
  it('解析 model=ms 串', () => {
    expect(parseLegacyLatencies('deepseek-v4-flash=1240,qwen-plus=2380')).toEqual({
      'deepseek-v4-flash': 1240,
      'qwen-plus': 2380,
    })
  })

  it('忽略损坏的条目，绝不抛异常', () => {
    expect(parseLegacyLatencies('a=1,,broken,b=x,c=3')).toEqual({ a: 1, c: 3 })
    expect(parseLegacyLatencies('')).toEqual({})
  })
})

function profile(patch: Partial<AiProfile> = {}): AiProfile {
  return {
    id: 'p1',
    provider: 'deepseek',
    apiUrl: 'https://api.deepseek.com',
    apiKey: 'sk-key',
    model: 'deepseek-v4-flash',
    ...patch,
  }
}

describe('parseProfiles', () => {
  it('非数组一律当空列表（导入了坏文件、手改坏了数据库）', () => {
    expect(parseProfiles(null)).toEqual([])
    expect(parseProfiles('[]')).toEqual([])
    expect(parseProfiles({ profiles: [] })).toEqual([])
  })

  it('丢掉不是对象的条目，保留能救的', () => {
    const result = parseProfiles([profile(), 'junk', null, 42])
    expect(result).toHaveLength(1)
    expect(result[0].model).toBe('deepseek-v4-flash')
  })

  it('缺字段补空串、缺供应商回落到第一家', () => {
    const [entry] = parseProfiles([{ id: 'x' }])
    expect(entry).toEqual({
      id: 'x',
      provider: AI_PROVIDERS[0].value,
      apiUrl: '',
      apiKey: '',
      model: '',
      latencyMs: undefined,
    })
  })

  it('id 缺失或重复都要修掉：单选和编辑都靠 id 定位，重复会让你点 A 改到 B', () => {
    const ids = parseProfiles([{ model: 'a' }, { model: 'b' }, { id: 'same' }, { id: 'same' }])
      .map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('读回检测结论；ok 不是布尔值就当没测过', () => {
    const ok = parseProfiles([profile({ check: { ok: true, at: 1000, latencyMs: 1200 } })])[0].check
    expect(ok).toEqual({ ok: true, at: 1000, latencyMs: 1200, reason: undefined })

    const failed = parseProfiles([profile({ check: { ok: false, at: 1000, reason: '密钥被拒绝' } })])[0].check
    expect(failed?.ok).toBe(false)
    expect(failed?.reason).toBe('密钥被拒绝')

    expect(parseProfiles([{ ...profile(), check: { latencyMs: 1200 } }])[0].check).toBeUndefined()
    expect(parseProfiles([{ ...profile(), check: 'ok' }])[0].check).toBeUndefined()
  })

  it('更早版本平铺的 latencyMs 升级成"测通过"的结论（老版本只有测通才写这个数）', () => {
    const upgraded = parseProfiles([{ ...profile(), check: undefined, latencyMs: 1200 }])[0].check
    expect(upgraded).toEqual({ ok: true, latencyMs: 1200 })
    // 没有 at：那次是什么时候测的没人知道，界面上就不该声称"刚测过"
    expect(upgraded?.at).toBeUndefined()
  })

  it('脏的耗时不进结论', () => {
    expect(parseProfiles([{ ...profile(), latencyMs: 'fast' }])[0].check).toBeUndefined()
    expect(parseProfiles([{ ...profile(), latencyMs: Number.NaN }])[0].check).toBeUndefined()
  })
})

describe('gradeLatency', () => {
  it('五档，按口述场景的手感切：200 / 500 / 1000 / 2000', () => {
    expect(gradeLatency(0).label).toBe('极速')
    expect(gradeLatency(199).label).toBe('极速')
    expect(gradeLatency(200).label).toBe('很快')
    expect(gradeLatency(499).label).toBe('很快')
    expect(gradeLatency(500).label).toBe('正常')
    expect(gradeLatency(999).label).toBe('正常')
    expect(gradeLatency(1000).label).toBe('偏慢')
    expect(gradeLatency(1999).label).toBe('偏慢')
    expect(gradeLatency(2000).label).toBe('太慢')
  })

  it('每一档都有词：极速也要说出来，用户才知道这个数好不好', () => {
    for (const ms of [80, 300, 700, 1500, 3000]) {
      expect(gradeLatency(ms).label).not.toBe('')
    }
  })

  it('颜色分三档，2 秒以上才升到 bad（那是"别用"，不只是"慢"）', () => {
    expect(gradeLatency(150).tone).toBe('ok')
    expect(gradeLatency(980).tone).toBe('ok')
    expect(gradeLatency(1400).tone).toBe('warn')
    expect(gradeLatency(2000).tone).toBe('bad')
    expect(gradeLatency(9000).tone).toBe('bad')
  })
})

describe('isCheckFresh', () => {
  const now = new Date('2026-08-03T12:00:00Z').getTime()

  it('保鲜期内才算新鲜——过期的结论不该继续挂绿灯', () => {
    expect(isCheckFresh({ ok: true, at: now - 60 * 1000 }, now)).toBe(true)
    expect(isCheckFresh({ ok: true, at: now - 23 * 3600 * 1000 }, now)).toBe(true)
    expect(isCheckFresh({ ok: true, at: now - 25 * 3600 * 1000 }, now)).toBe(false)
    expect(isCheckFresh({ ok: true, at: now - 3 * 24 * 3600 * 1000 }, now)).toBe(false)
  })

  it('没测过、或不知道什么时候测的，都不算新鲜', () => {
    expect(isCheckFresh(undefined, now)).toBe(false)
    expect(isCheckFresh({ ok: true, latencyMs: 300 }, now)).toBe(false)
  })
})

describe('formatCheckedAt', () => {
  const now = new Date('2026-08-03T12:00:00Z').getTime()

  // 断言"选了哪个粒度"，不写死具体文案：相对时间现在交给 Intl.RelativeTimeFormat
  // 渲染（英文的单复数没法用一条模板覆盖），所以文案随语言与 CLDR 走，不该锁死。
  const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

  it('按最粗的合适粒度说"多久之前"', () => {
    expect(formatCheckedAt(now - 30 * 1000, now)).toBe('刚刚')
    expect(formatCheckedAt(now - 5 * 60 * 1000, now)).toBe(rtf.format(-5, 'minute'))
    expect(formatCheckedAt(now - 3 * 3600 * 1000, now)).toBe(rtf.format(-3, 'hour'))
    expect(formatCheckedAt(now - 50 * 3600 * 1000, now)).toBe(rtf.format(-2, 'day'))
  })

  it('时钟往回跳时不说"负几分钟前"', () => {
    expect(formatCheckedAt(now + 60 * 1000, now)).toBe('刚刚')
  })
})

describe('resolveActiveProfile', () => {
  it('id 失效时回落到第一条，而不是"什么都没启用"', () => {
    const list = [profile({ id: 'a' }), profile({ id: 'b' })]
    expect(resolveActiveProfile(list, 'b')?.id).toBe('b')
    expect(resolveActiveProfile(list, '已删掉的 id')?.id).toBe('a')
    expect(resolveActiveProfile(list, '')?.id).toBe('a')
  })

  it('空列表返回 null', () => {
    expect(resolveActiveProfile([], 'a')).toBeNull()
  })
})

describe('一行的标题与副标题', () => {
  it('没填模型时也有字，否则那一行看着像坏了', () => {
    expect(profileTitle(profile({ model: '  ' }))).toBe('未填写模型')
  })

  it('默认地址不重复念，自定义端点才显示主机名', () => {
    expect(profileSubtitle(profile())).toBe('DeepSeek')
    expect(profileSubtitle(profile({ provider: 'openai_compat', apiUrl: 'http://127.0.0.1:8000/v1' })))
      .toBe('OpenAI 兼容 · 127.0.0.1:8000')
  })

  it('两个不同端点的 OpenAI 兼容在列表里能区分开——这正是旧结构做不到的事', () => {
    const a = profile({ id: 'a', provider: 'openai_compat', apiUrl: 'https://api.openai.com', model: 'gpt-4o-mini' })
    const b = profile({ id: 'b', provider: 'openai_compat', apiUrl: 'http://192.168.1.9:8000/v1', model: 'gpt-4o-mini' })
    expect(profileSubtitle(a)).not.toBe(profileSubtitle(b))
  })
})

describe('isProfileComplete', () => {
  it('免密钥的 Ollama 不要求密钥，其余都要', () => {
    expect(isProfileComplete(profile({ apiKey: '' }))).toBe(false)
    expect(isProfileComplete(profile({ provider: 'ollama', apiKey: '', apiUrl: 'http://127.0.0.1:11434' }))).toBe(true)
  })

  it('缺地址或缺模型都算没填完', () => {
    expect(isProfileComplete(profile({ apiUrl: '' }))).toBe(false)
    expect(isProfileComplete(profile({ model: ' ' }))).toBe(false)
    expect(isProfileComplete(profile())).toBe(true)
  })
})

describe('migrateLegacyProfiles', () => {
  const legacy: LegacyProviderData[] = [
    {
      provider: 'deepseek',
      apiUrl: 'https://api.deepseek.com',
      apiKey: 'sk-ds',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-chat'],
      latencies: { 'deepseek-v4-flash': 1200 },
    },
    // 没填密钥的一家不该被迁成"看着能用其实打不通"的服务
    { provider: 'qwen', apiUrl: '', apiKey: '', model: '', models: [], latencies: {} },
  ]

  it('每个候选模型各成一条，带上原来的地址、密钥；有耗时的算测通过一次', () => {
    const { profiles } = migrateLegacyProfiles(legacy, 'deepseek', 'deepseek-chat')
    expect(profiles.map((p) => p.model)).toEqual(['deepseek-v4-flash', 'deepseek-chat'])
    expect(profiles.every((p) => p.apiKey === 'sk-ds')).toBe(true)
    expect(profiles[0].check).toEqual({ ok: true, latencyMs: 1200 })
    expect(profiles[1].check).toBeUndefined()
  })

  it('老的「当前供应商 + 当前模型」成为启用项', () => {
    const { profiles, activeId } = migrateLegacyProfiles(legacy, 'deepseek', 'deepseek-chat')
    expect(resolveActiveProfile(profiles, activeId)?.model).toBe('deepseek-chat')
  })

  it('没填完的供应商直接跳过', () => {
    const { profiles } = migrateLegacyProfiles(legacy, 'deepseek', '')
    expect(profiles.some((p) => p.provider === 'qwen')).toBe(false)
  })

  it('新用户（什么都没配过）迁出空列表，不是一堆空壳', () => {
    const blank = AI_PROVIDERS.map((p) => ({
      provider: p.value, apiUrl: '', apiKey: '', model: '', models: [], latencies: {},
    }))
    const { profiles, activeId } = migrateLegacyProfiles(blank, '', '')
    expect(profiles).toEqual([])
    expect(activeId).toBe('')
  })

  it('id 是确定性的：重复迁移不会产生两份', () => {
    const first = migrateLegacyProfiles(legacy, 'deepseek', '')
    const second = migrateLegacyProfiles(legacy, 'deepseek', '')
    expect(first.profiles.map((p) => p.id)).toEqual(second.profiles.map((p) => p.id))
  })

  /**
   * 老结构摊平出来的就是这张表里的旧名（deepseek-v4-flash + deepseek-chat），
   * 换名之后两条变成同一份服务，只能留一条，而且要留启用中的那条。
   */
  it('摊平之后再换名：两条并成一条 deepseek-flash，留下的是启用项', () => {
    const migrated = migrateLegacyProfiles(legacy, 'deepseek', 'deepseek-chat')
    const { profiles, mergedInto } = upgradeRetiredAiModels(migrated.profiles, migrated.activeId)
    expect(profiles.map((p) => p.model)).toEqual(['deepseek-flash'])
    expect(profiles[0].id).toBe(migrated.activeId)
    expect(mergedInto).toEqual({ 'legacy-deepseek-deepseek-v4-flash': migrated.activeId })
  })
})

describe('keyAfterProviderSwitch', () => {
  const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4'
  const DEEPSEEK_URL = 'https://api.deepseek.com'
  const saved: AiProfile[] = [
    profile({ id: 'ds', provider: 'deepseek', apiUrl: DEEPSEEK_URL, apiKey: 'sk-deepseek' }),
    profile({ id: 'zp', provider: 'zhipu', apiUrl: ZHIPU_URL, apiKey: 'zhipu-key', model: 'GLM-5.3-Flash' }),
  ]
  const fromZhipu = { fromProvider: 'zhipu', fromUrl: ZHIPU_URL, toUrl: DEEPSEEK_URL, profiles: saved }

  /**
   * 用户实际踩到的那次：启用的是智谱，点「新建」带上了智谱的密钥，改选 DeepSeek 后
   * 地址和模型换了、密钥没换，存下来一张装着智谱密钥的 DeepSeek 卡。
   */
  it('新建时带过来的上一家密钥，换供应商后换成新供应商配过的那把', () => {
    expect(keyAfterProviderSwitch({ ...fromZhipu, key: 'zhipu-key', toSavedKey: 'sk-deepseek' })).toBe('sk-deepseek')
  })

  it('新供应商没配过就清空，不留上一家的密钥', () => {
    expect(keyAfterProviderSwitch({ ...fromZhipu, key: 'zhipu-key', toSavedKey: '' })).toBe('')
  })

  it('用户自己粘的密钥（哪份配置里都没有）不动', () => {
    expect(keyAfterProviderSwitch({ ...fromZhipu, key: 'sk-typed-by-user', toSavedKey: 'sk-deepseek' }))
      .toBe('sk-typed-by-user')
  })

  it('密钥框空着时带上新供应商配过的那把', () => {
    expect(keyAfterProviderSwitch({ ...fromZhipu, key: '  ', toSavedKey: 'sk-deepseek' })).toBe('sk-deepseek')
    expect(keyAfterProviderSwitch({ ...fromZhipu, key: '', toSavedKey: '' })).toBe('')
  })

  /** 「OpenAI 兼容」本来就填的 DeepSeek 地址，换成 DeepSeek 卡后还是同一台服务器、同一把能用的密钥。 */
  it('地址没换到别的服务器时密钥不动', () => {
    const compat = profile({ id: 'oc', provider: 'openai_compat', apiUrl: `${DEEPSEEK_URL}/v1`, apiKey: 'sk-same' })
    expect(keyAfterProviderSwitch({
      key: 'sk-same',
      fromProvider: 'openai_compat',
      fromUrl: `${DEEPSEEK_URL}/v1`,
      toUrl: `${DEEPSEEK_URL}/v1`,
      toSavedKey: '',
      profiles: [compat],
    })).toBe('sk-same')
    // 只是写法不同（是否带 /v1）也算同一台
    expect(keyAfterProviderSwitch({
      key: 'sk-same',
      fromProvider: 'openai_compat',
      fromUrl: `${DEEPSEEK_URL}/v1`,
      toUrl: DEEPSEEK_URL,
      toSavedKey: 'sk-other',
      profiles: [compat],
    })).toBe('sk-same')
  })
})

describe('已下线模型名的迁移', () => {
  it('DeepSeek 官方地址上的旧名换成 deepseek-flash', () => {
    for (const old of [
      'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner', ' DeepSeek-Chat ',
    ]) {
      expect(upgradeRetiredAiModel('deepseek', 'https://api.deepseek.com', old), old).toBe('deepseek-flash')
    }
    // 地址写到 /v1 也是官方地址；DeepSeek 卡地址空着时按默认地址算
    expect(upgradeRetiredAiModel('deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat')).toBe('deepseek-flash')
    expect(upgradeRetiredAiModel('deepseek', '', 'deepseek-chat')).toBe('deepseek-flash')
    // 「OpenAI 兼容」卡填的是官方地址，同样换
    expect(upgradeRetiredAiModel('openai_compat', 'https://api.deepseek.com', 'deepseek-v4-flash')).toBe('deepseek-flash')
  })

  /** 中转站上的模型名是对方定的，换了可能就打不通了。 */
  it('中转站、别家供应商、还在用的名字一律不动', () => {
    expect(upgradeRetiredAiModel('deepseek', 'https://relay.example.com/v1', 'deepseek-chat')).toBe('deepseek-chat')
    expect(upgradeRetiredAiModel('openai_compat', 'https://api.siliconflow.cn/v1', 'deepseek-v4-flash'))
      .toBe('deepseek-v4-flash')
    expect(upgradeRetiredAiModel('openrouter', 'https://openrouter.ai/api/v1', 'deepseek-chat')).toBe('deepseek-chat')
    // 「OpenAI 兼容」卡没填地址时不知道对面是谁
    expect(upgradeRetiredAiModel('openai_compat', '', 'deepseek-chat')).toBe('deepseek-chat')
    expect(upgradeRetiredAiModel('deepseek', 'https://api.deepseek.com', 'deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(upgradeRetiredAiModel('deepseek', 'https://api.deepseek.com', 'deepseek-flash')).toBe('deepseek-flash')
    expect(upgradeRetiredAiModel('deepseek', 'not a url', 'deepseek-chat')).toBe('deepseek-chat')
  })

  it('没有要换的：changed 为假，原数组原样返回', () => {
    const list = [profile({ model: 'deepseek-flash' }), profile({ id: 'p2', provider: 'qwen', model: 'qwen-plus' })]
    const result = upgradeRetiredAiModels(list)
    expect(result.changed).toBe(false)
    expect(result.profiles).toBe(list)
    expect(result.mergedInto).toEqual({})
  })

  it('只换名、不重复时，条数、顺序、检测结果都不变', () => {
    const check = { ok: true, at: 1000, latencyMs: 900 }
    const list = [
      profile({ id: 'a', model: 'deepseek-v4-flash', check }),
      profile({ id: 'b', provider: 'qwen', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode', model: 'qwen-plus' }),
    ]
    const { profiles, changed, mergedInto } = upgradeRetiredAiModels(list)
    expect(changed).toBe(true)
    expect(profiles.map((p) => [p.id, p.model])).toEqual([['a', 'deepseek-flash'], ['b', 'qwen-plus']])
    expect(profiles[0].check).toEqual(check)
    expect(mergedInto).toEqual({})
  })

  it('密钥不同的两条不算重复，各自保留', () => {
    const list = [
      profile({ id: 'a', model: 'deepseek-chat', apiKey: 'sk-one' }),
      profile({ id: 'b', model: 'deepseek-v4-flash', apiKey: 'sk-two' }),
    ]
    expect(upgradeRetiredAiModels(list).profiles.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('换名前就重复的两条是用户自己建的，不动', () => {
    const list = [profile({ id: 'a', model: 'deepseek-flash' }), profile({ id: 'b', model: 'deepseek-flash' })]
    expect(upgradeRetiredAiModels(list).changed).toBe(false)
  })

  it('并掉的 id 一路追到最后留下的那条', () => {
    // a 先留下、b 并进 a；c 是启用项，把 a 顶掉 —— b 必须指向 c，不能指向已经不在列表里的 a
    const list = [
      profile({ id: 'a', model: 'deepseek-chat' }),
      profile({ id: 'b', model: 'deepseek-v4-flash' }),
      profile({ id: 'c', model: 'deepseek-reasoner' }),
    ]
    const { profiles, mergedInto } = upgradeRetiredAiModels(list, 'c')
    expect(profiles.map((p) => p.id)).toEqual(['c'])
    expect(mergedInto).toEqual({ a: 'c', b: 'c' })
  })
})
