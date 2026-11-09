import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({ t: (key: string) => key }))

import {
  BUILTIN_SETS,
  extractBuiltinSetExtraWords,
  normalizeBuiltinSetWords,
} from '../model'

const defaults = BUILTIN_SETS.ai.words

describe('user words added to a builtin set', () => {
  it('survive a reload, while words dropped from the builtin list are still cleaned up', () => {
    // 存盘时：一个当前默认词、一个已被新版移出默认表的旧词、一个用户加的词
    const inMemory = { ai: [defaults[0], 'RetiredDefault', 'MyTerm'] }
    // 'RetiredDefault' 在内存里也不是默认词，所以会被当成用户词写进 extras ——
    // 这里模拟的是旧版本存下来的数据：旧词只在 builtinSetWords 里，extras 里没有它
    const storedWords = { ai: [defaults[0], 'RetiredDefault'] }
    const storedExtras = { ai: ['MyTerm'] }

    const loaded = normalizeBuiltinSetWords(storedWords, storedExtras)
    expect(loaded.ai).toEqual([defaults[0], 'MyTerm'])
    expect(extractBuiltinSetExtraWords(inMemory)).toEqual({ ai: ['RetiredDefault', 'MyTerm'] })
  })

  it('falls back to all defaults when only user words were ever saved', () => {
    const loaded = normalizeBuiltinSetWords({}, { ai: ['MyTerm'] })
    expect(loaded.ai).toEqual([...new Set(defaults), 'MyTerm'])
  })

  it('keeps the old behaviour when there are no user words', () => {
    expect(normalizeBuiltinSetWords(undefined)).toEqual({})
    expect(normalizeBuiltinSetWords({ ai: [defaults[1]] }, {})).toEqual({ ai: [defaults[1]] })
    expect(extractBuiltinSetExtraWords({ ai: [...defaults] })).toEqual({})
  })
})
