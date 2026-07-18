// 文本后处理 — 不依赖 AI 的客户端文本规范化
//
// 提供三类可开关的处理：
//   1. 数字规范化（A 档，尽力而为）：百分之 / 小数点 / 分之 / 含位值词的结构化整数
//   2. 去除句末标点
//   3. 标点符号替换为空格
//
// 处理顺序在 applyTextTransforms 中固定：数字规范化 → 用户替换规则 → 去句末标点 → 标点转空格。
// 数字规范化必须在标点处理之前（小数点依赖「点」，标点转空格会吃掉标点）。

import { getSetting, setSetting } from './store'
import { applyTextReplacements } from './textReplacement'
import { segmentAsrText } from './textSegmenter'

// ── 中文数字字符表 ──
const CN_DIGITS: Record<string, number> = {
  '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '幺': 1,
}
const CN_SMALL_UNITS: Record<string, number> = { '十': 10, '百': 100, '千': 1000 }
const CN_BIG_UNITS: Record<string, number> = { '万': 10000, '亿': 100000000 }

/** 所有中文数字字符（含单位） */
const NUM_CHARS = '零〇一二两三四五六七八九十百千万亿幺'
/** 纯数字字符（不含单位），用于小数部分逐位读取 */
const DIGIT_CHARS = '零〇一二两三四五六七八九幺'
/** 位值单位字符 */
const UNIT_CHARS = '十百千万亿'

/**
 * 连续单位词构成的固定词/成语黑名单：这些通过了「长度≥2 且含单位」的过滤，
 * 但语义上不是数字，需排除。多数含单位的成语（千方百计、十全十美等）因为
 * 单位与非数字字符交替出现、拆分后单位单独成段（长度<2）已被自动跳过，
 * 这里只列举「多个单位/数字连续」的高频误伤词。可按需扩充。
 */
const INTEGER_BLACKLIST = new Set([
  '千万', '万一', '万万', '千千万万', '亿万', '万千', '十万八千',
])

/** 解析一段中文整数为数值；无法解析返回 null。支持口语省略（三千二=3200、一万五=15000）。 */
function parseChineseInteger(s: string): number | null {
  if (!s) return null
  let total = 0
  let section = 0
  let number = 0
  let lastUnit = 0 // 最近一次使用的单位量级（大小单位皆计）
  let sawZero = false
  let hadAny = false

  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch]
      if (ch === '零' || ch === '〇') sawZero = true
      hadAny = true
    } else if (ch in CN_SMALL_UNITS) {
      const unit = CN_SMALL_UNITS[ch]
      if (number === 0) number = 1 // 「十五」→ 十 隐含 1
      section += number * unit
      number = 0
      lastUnit = unit
      hadAny = true
    } else if (ch in CN_BIG_UNITS) {
      const unit = CN_BIG_UNITS[ch]
      section += number
      total += section * unit
      section = 0
      number = 0
      lastUnit = unit
      sawZero = false
      hadAny = true
    } else {
      return null
    }
  }

  if (!hadAny) return null
  // 口语省略的末位数字：无「零」时按下一量级缩放（三千二=3200、一万五=15000、两百五=250）
  if (number !== 0 && lastUnit >= 10 && !sawZero) {
    section += number * (lastUnit / 10)
    number = 0
  }
  return total + section + number
}

/** 解析可能带小数点的中文数字表达为字符串；失败返回 null。 */
function parseNumberExpr(s: string): string | null {
  const dotIdx = s.indexOf('点')
  if (dotIdx === -1) {
    const n = parseChineseInteger(s)
    return n === null ? null : String(n)
  }
  const intPart = s.slice(0, dotIdx)
  const decPart = s.slice(dotIdx + 1)
  if (!decPart) return null
  const intVal = intPart ? parseChineseInteger(intPart) : 0
  if (intVal === null) return null
  let dec = ''
  for (const ch of decPart) {
    if (ch in CN_DIGITS) dec += String(CN_DIGITS[ch])
    else return null
  }
  return `${intVal}.${dec}`
}

function containsUnit(s: string): boolean {
  for (const ch of s) if (UNIT_CHARS.includes(ch)) return true
  return false
}

/** 若替换处紧跟在英文字母之后，前面补一个空格（如 GPT五点四 → GPT 5.4）。 */
function maybeSpace(str: string, offset: number, replacement: string): string {
  const prev = offset > 0 ? str[offset - 1] : ''
  return /[A-Za-z]/.test(prev) ? ' ' + replacement : replacement
}

/**
 * 中文数字 → 阿拉伯数字（A 档：有明确信号才转，尽力而为）。
 * 覆盖：百分之 / 小数点（数字点数字）/ 分之 / 含位值词的结构化整数。
 * 刻意不转「孤立单字数字」和「无位值词的逐位串」（如 一二三、三三零六），
 * 避免误伤成语、口语与号码。复杂/歧义场景建议开 AI 整理。
 */
export function convertChineseNumbers(text: string): string {
  if (!text) return text
  let result = text

  // 1. 百分之X → X%
  result = result.replace(
    new RegExp(`百分之([${NUM_CHARS}点]+)`, 'g'),
    (m: string, expr: string, offset: number, str: string) => {
      const val = parseNumberExpr(expr)
      return val === null ? m : maybeSpace(str, offset, `${val}%`)
    },
  )

  // 2. X分之Y → Y/X
  result = result.replace(
    new RegExp(`([${NUM_CHARS}]+)分之([${NUM_CHARS}]+)`, 'g'),
    (m: string, a: string, b: string) => {
      const av = parseChineseInteger(a)
      const bv = parseChineseInteger(b)
      return av === null || bv === null ? m : `${bv}/${av}`
    },
  )

  // 3. 小数 / 多段点分数字：数字点数字(点数字)* → N.N 或 N.N.N
  //    单段是普通小数（三点一四 → 3.14）；多段是版本号等（零点一点零 → 0.1.0），每段逐位读。
  result = result.replace(
    new RegExp(`([${NUM_CHARS}]+)((?:点[${DIGIT_CHARS}]+)+)`, 'g'),
    (m: string, intp: string, rest: string, offset: number, str: string) => {
      const intVal = parseChineseInteger(intp)
      if (intVal === null) return m
      const groups = rest.split('点').filter((g: string) => g.length > 0)
      let out = String(intVal)
      for (const g of groups) {
        let dec = ''
        for (const ch of g) dec += String(CN_DIGITS[ch])
        out += `.${dec}`
      }
      return maybeSpace(str, offset, out)
    },
  )

  // 4. 结构化整数：长度≥2、含位值词、非黑名单
  result = result.replace(
    new RegExp(`[${NUM_CHARS}]+`, 'g'),
    (m: string, offset: number, str: string) => {
      if (m.length < 2 || !containsUnit(m) || INTEGER_BLACKLIST.has(m)) return m
      const val = parseChineseInteger(m)
      return val === null ? m : maybeSpace(str, offset, String(val))
    },
  )

  return result
}

/**
 * 还原被 ASR 拆开加空格的「无空格热词」（如豆包把热词 "SayIt" 识别成 "Say It"）。
 *
 * 仅处理不含空格、纯 ASCII 字母/数字的热词（中文不会被加空格）。对每个热词构造
 * 大小写敏感、字符间允许空白、两端带词边界的正则；命中后若与热词不同（即确实被
 * 拆开过）就合并还原成热词原形。
 *
 * 大小写敏感 + 词边界是为了避免误伤：普通小写短语（如句子里的 "say it"）不会被
 * 改成 "SayIt"，"Say Item" 也不会被错并成 "SayItem"。
 */
export function restoreHotwordSpacing(text: string, hotwords: string[]): string {
  if (!text || !hotwords || hotwords.length === 0) return text
  const targets = hotwords
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && /^[A-Za-z0-9]+$/.test(w) && /[A-Za-z]/.test(w))
  if (targets.length === 0) return text
  // 长词优先，避免短词先命中影响更长的热词
  targets.sort((a, b) => b.length - a.length)
  let result = text
  for (const hw of targets) {
    const inner = hw.split('').join('\\s*')
    // 大小写不敏感匹配（豆包可能把 "SayIt" 识别成 "Say it"，尾字母小写），
    // 但要求首字符大小写与热词一致，避免把普通小写短语（如 "say it"）误并成热词。
    const re = new RegExp(`\\b${inner}\\b`, 'gi')
    result = result.replace(re, (m) => {
      if (m === hw) return m
      // 连写命中（无内部空格，如 "typeless"/"sayit"）→ 直接还原成热词原样（含大小写）。
      // 带空格命中（如 "Say it"）→ 仅当首字母大小写一致才还原，避免把普通句子里的
      // 小写短语（如 "say it"）误并成热词。
      if (/\s/.test(m) && m[0] !== hw[0]) return m
      return hw
    })
  }
  return result
}

/** 去除每行末尾的标点符号（及尾随空白）。 */
export function stripTrailingPunctuation(text: string): string {
  if (!text) return text
  return text
    .split('\n')
    .map((line) => line.replace(/[。．.，,、；;：:！!？?…⋯～~—－\s]+$/u, ''))
    .join('\n')
}

/**
 * 将所有标点符号替换为空格，并折叠多余空格（保留换行）。
 * 保留数字间的小数点（3.14）、百分号（15%）和斜杠（2/5），避免破坏数字规范化的产物。
 */
export function replacePunctuationWithSpace(text: string): string {
  if (!text) return text
  let result = text.replace(
    /(?<!\d)\.(?!\d)|[，。、；：！？…⋯""''‘’“”（）《》〈〉「」『』【】—－~～·!?,;:"'`()\[\]{}<>_=+|\\@#^&*-]/gu,
    ' ',
  )
  result = result.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim()
  return result
}

// ── 设置持久化 ──

export interface TextPostProcessOptions {
  /** 智能分段（仅在关闭 AI 整理的极速模式下生效），默认开启 */
  autoSegment: boolean
  /** 数字规范化 */
  normalizeNumbers: boolean
  /** 去除句末标点 */
  stripTrailingPunctuation: boolean
  /** 标点符号替换为空格 */
  punctuationToSpace: boolean
}

const STORAGE_KEY = 'textPostProcess'

export const DEFAULT_POST_PROCESS: TextPostProcessOptions = {
  autoSegment: true,
  normalizeNumbers: false,
  stripTrailingPunctuation: false,
  punctuationToSpace: false,
}

export async function getTextPostProcessOptions(): Promise<TextPostProcessOptions> {
  const saved = await getSetting<Partial<TextPostProcessOptions>>(STORAGE_KEY, {})
  return { ...DEFAULT_POST_PROCESS, ...(saved || {}) }
}

export async function saveTextPostProcessOptions(opts: TextPostProcessOptions): Promise<void> {
  await setSetting(STORAGE_KEY, opts)
}

export interface ApplyTransformsOptions {
  /**
   * 文本是纯 ASR 结果、可参与智能分段（极速模式）。
   * 为 true 且用户开启自动分段时，先做智能分段再执行其它处理。
   */
  segmentable?: boolean
}

/**
 * 统一入口：智能分段 → 数字规范化 → 用户替换规则 → 去句末标点 → 标点转空格。
 * 替代原先直接调用 segmentAsrText + applyTextReplacements 的位置（是其超集）。
 */
export async function applyTextTransforms(
  text: string,
  options: ApplyTransformsOptions = {},
): Promise<string> {
  if (!text) return text
  const opts = await getTextPostProcessOptions()
  let result = text
  if (options.segmentable && opts.autoSegment) result = segmentAsrText(result)
  if (opts.normalizeNumbers) result = convertChineseNumbers(result)
  result = await applyTextReplacements(result)
  if (opts.stripTrailingPunctuation) result = stripTrailingPunctuation(result)
  if (opts.punctuationToSpace) result = replacePunctuationWithSpace(result)
  return result
}
