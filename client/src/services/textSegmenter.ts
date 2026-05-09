/**
 * 纯 ASR 文本智能分段
 *
 * 仅在极速模式（无 AI 校对）下使用。
 * LLM 校对后的文本已经有自然分段，不需要再处理。
 *
 * 核心逻辑：在句末标点之后，检测话题转换信号来决定是否插入换行。
 * 不以字数为主要依据，而是以语义转换为驱动。
 */

// 话题转换词（出现在句末标点之后，表示新话题开始）
// 按优先级排列，长词优先匹配
const TOPIC_SHIFT_PHRASES = [
  // 序号类
  '第一个', '第二个', '第三个', '第四个', '第五个',
  '第一点', '第二点', '第三点',
  '第一,', '第二,', '第三,',
  '第一，', '第二，', '第三，',
  '首先', '其次',
  // 转折/递进类
  '另外呢', '另外,', '另外，', '另外就是', '另外我',
  '还有就是', '还有一个', '还有呢',
  '再就是', '再一个',
  '此外',
  '接下来',
  '最后呢', '最后,', '最后，', '最后就是',
  // 总结类
  '总之', '总的来说',
]

// 语气词开头模式：句末标点后跟 "嗯，/呃，/嗯" + 转换信号
// 这类需要前段足够长（≥ 80 字）才触发，避免误切口头禅
const FILLER_THEN_SHIFT = [
  '嗯，所以', '嗯，我觉得', '嗯，我发现',
  '嗯，现在', '嗯，目前', '嗯，如果',
  '嗯，这样', '嗯，还有', '嗯，另外',
  '呃，所以', '呃，我觉得', '呃，然后',
]

// 句末标点
const SENTENCE_END_RE = /[。？！]/

/**
 * 对纯 ASR 输出的文本进行智能分段，插入换行符。
 *
 * @param text - ASR 原始文本（一整段无换行）
 * @returns 分段后的文本（用 \n\n 分隔段落）
 */
export function segmentAsrText(text: string): string {
  if (!text || text.length < 40) return text

  const segments: string[] = []
  let currentStart = 0
  let i = 0

  while (i < text.length) {
    // 找到句末标点
    if (!SENTENCE_END_RE.test(text[i])) {
      i++
      continue
    }

    // 找到了句末标点，位置 i
    const afterPunc = i + 1
    if (afterPunc >= text.length) {
      // 文本结束，不需要切
      i++
      continue
    }

    const currentLen = afterPunc - currentStart
    const remaining = text.slice(afterPunc)

    // 检查 1：直接话题转换词（前段 ≥ 20 字即可触发）
    if (currentLen >= 20 && startsWithAny(remaining, TOPIC_SHIFT_PHRASES)) {
      segments.push(text.slice(currentStart, afterPunc))
      currentStart = afterPunc
      i = afterPunc
      continue
    }

    // 检查 2：语气词 + 转换信号（前段 ≥ 60 字才触发，避免误切）
    if (currentLen >= 60 && startsWithAny(remaining, FILLER_THEN_SHIFT)) {
      segments.push(text.slice(currentStart, afterPunc))
      currentStart = afterPunc
      i = afterPunc
      continue
    }

    // 检查 3：兜底——超过 250 字在句末标点处强制切
    if (currentLen >= 250) {
      segments.push(text.slice(currentStart, afterPunc))
      currentStart = afterPunc
      i = afterPunc
      continue
    }

    i++
  }

  // 收尾：剩余文本作为最后一段
  if (currentStart < text.length) {
    segments.push(text.slice(currentStart))
  }

  return segments.join('\n\n')
}

function startsWithAny(text: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) return true
  }
  return false
}
