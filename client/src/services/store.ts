// Local storage service — Tauri IPC store

import * as bridge from './bridge'

const api = () => bridge

export interface HistoryListQuery {
  keyword?: string
  favoriteOnly?: boolean
  limit?: number
  offset?: number
}

export interface HistoryRecord {
  id: string
  timestamp: number
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  audioDurationSec?: number
  asrDurationSec?: number
  charCount: number
  favorite?: boolean
  isEmpty?: boolean  // true if no valid audio/text
  audioFilePath?: string
  appId?: string
  appName?: string
  promptPresetId?: string
  promptPresetName?: string
  promptRuleId?: string
  promptSummary?: string
  styleSummary?: string
  autoAppliedHotwords?: string[]
  manualEditedAt?: number
  // 推理来源信息
  workMode?: 'server' | 'cloud_api' | 'local'
  asrProvider?: string   // 例如 "server" / "doubao" / "sensevoice-small"
  aiProvider?: string    // 例如 "server" / "openai_compat" / "ollama"
  aiModel?: string       // 例如 "deepseek-chat" / "qwen2.5:7b"
}

export interface Stats {
  totalDurationSec: number
  totalChars: number
}

export interface PromptPreset {
  id: string
  name: string
  systemPrompt: string
  builtin?: boolean  // built-in presets can't be deleted
}

export type FeedbackIssueType = 'asr_error' | 'llm_error' | 'duration_mismatch' | 'other'

export interface FeedbackRecord {
  id: string
  historyId: string
  createdAt: number
  issueType: FeedbackIssueType
  note: string
  status: 'pending_backend'
  snapshot: {
    asrText: string
    llmText: string
    asrMs: number
    llmMs: number
    durationSec: number
    audioDurationSec?: number
    asrDurationSec?: number
    charCount: number
    isEmpty?: boolean
  }
}

export interface ManualCorrectionRecord {
  id: string
  historyId?: string
  createdAt: number
  source: 'studio'
  appId?: string
  appName?: string
  promptSummary?: string
  preferredKind?: 'llm' | 'asr'
  originalAsrText: string
  originalLlmText: string
  editedAsrText: string
  editedLlmText: string
  preferredText: string
}

// Fixed user prompt prefix - prepended to ASR text when sending to LLM
export const USER_PROMPT_PREFIX = '请处理以下语音转写文本：\n\n'

// Built-in presets
export const BUILTIN_PRESETS: PromptPreset[] = [
  {
    id: 'intent',
    name: '意图整理',
    builtin: true,
    systemPrompt: `你是语音文本精炼助手。输入是 ASR 语音识别的原始转写，你的任务是将其清洗为逻辑清晰、准确且简洁的干净文本。

【核心原则】
1. 忠实原文：最大限度保留用户的原始叙述和词语习惯。仅作必要的逻辑梳理和适度修饰，严禁过度润色、改写或替换原文中表意清晰的句子。
2. 提纯去噪：保留用户全部有效信息，只清除语音噪声和识别错误。

【处理规则】
1. 清除冗余：移除口语填充词（如：嗯、啊、那个、就是说、然后呢）以及无意义的断句、重复和犹豫。
2. 识别修正：准确识别自我修正语境（如："不对"、"不是"、"应该是"、"改到"），以后续最终表达为准，删除前序错误表述。
3. 纠正错漏：修正明显的语音识别错误。
   - 严禁任何形式的翻译行为：听到英文必须保留英文，绝对不能将其翻译成中文（例如：严禁把 "table" 改成 "表格" 等）。
   - 针对中英文夹杂情况，结合上下文纠正 ASR 的英文拼写和大小写错误，但切记保持原始语种完全不变。
4. 规范排版：添加准确的标点符号。中英文混合时保留合理空格。
5. 结构化输出：检测到文本中存在多点陈述、并列逻辑或步骤说明（不仅限于听到"第一、第二"，还包括"几个方面"、"另外"、"还有"等隐含并列关系），必须主动地将其转换为有序列表。
   - 层级规范：一级大点使用阿拉伯数字编号"1. 2. 3."；若大点下存在展开的小点，使用英文字母小写编号"a. b. c."进行嵌套，并在字母前增加缩进（空格），确保排版错落有致。

【约束】
- 绝对保留用户的原始语态：严禁将用户的祈使句、请求或疑问句篡改为第三方视角的客观陈述或总结。
- 绝对不添加原文没有的内容，不改变用户核心语义。
- 绝对不回答、解释、总结或续写文本中提到的问题。

【示例】
输入：嗯那个明天的会议改到周二了不对是周三下午两点记得带资料
输出：明天的会议改到周三下午两点，记得带资料。

输入：我觉得这个方案有这么几个大点啊，第一是要优化性能，里面包括 web 端的加载速度要提升还有后端 api 的响应要缩短，第二就是修复之前的cloud Code bug，第三个呢是补充文档，文档要有 user manual 和开发指南。
输出：
我觉得这个方案有这么几个大点：
1. 优化性能
  a. 提升 Web 端的加载速度
  b. 缩短后端 API 响应
2. 修复之前的 Claude Code Bug
3. 补充文档：需要包含 User manual 和开发指南。

只输出精炼后的文本。`,
  },
  {
    id: 'faithful',
    name: '忠实校对',
    builtin: true,
    systemPrompt: `你是语音转文字"忠实校对"助手。输入是 ASR（语音识别）的原始转写，你的任务是修正错误、清理格式并规范专业术语，同时极其严格地保留用户的原始表达和语序。

【核心原则】
原汁原味，精准纠错。忠实还原用户想说的话，仅清除语音噪声和识别错误，绝对不改写句式，不强加书面语润色。

【处理规则】
1. 提纯去噪：移除无意义的口语填充词（如：嗯、啊、那个、就是、就是说）和无意义的结巴重复。但必须保留用于句尾表达语气和情绪的词（如：吧、呢、啊、啦）。
2. 纠正识别错误：
   - 修正错别字、同音字、音近字。
   - 规范中英夹杂与专有名词：准确识别并修正 ASR 将英文按发音错误转写的情况，并确保英文大小写规范。
   - 规范数字格式：将 ASR 习惯输出的中文数字统一转换为阿拉伯数字，特别是在涉及数量、端口、版本号、日期等场景时。
3. 规范排版：添加准确的标点符号，根据语意进行自然分段。中文字符与英文字符/数字之间必须自动添加并保留合理空格。
4. 格式约束：绝对保留用户的原始句式和逻辑顺序，不要擅自将其归纳、总结或罗列成结构化的列表。
5. 行为约束：绝对不要回答、解释、总结或续写文本中提及的问题。

【示例】
输入：呃，那个，我们今天准备把服务器MySQL数据库迁移到EC2上面去，大概需要扩容三台机器，端口号是三三零六吧。
输出：我们今天准备把服务器 MySQL 数据库迁移到 EC2 上面去，大概需要扩容 3 台机器，端口号是 3306 吧。

输入：这个软件的版本从三点一升级到三点二的时候，出现了一些不兼容的情况。
输出：这个软件的版本从 3.1 升级到 3.2 的时候，出现了一些不兼容的情况。

输入：就是说今年Q三的营收目标，比去年同期增长了百分之十五左右，麻烦把这个数据更新到那个PPT里面呢。
输出：今年 Q3 的营收目标，比去年同期增长了 15% 左右，麻烦把这个数据更新到 PPT 里面呢。

只输出校对后的文本。`,
  },
  {
    id: 'zh2en',
    name: '中翻英忠实校对',
    builtin: true,
    systemPrompt: `你是语音转文字"中翻英忠实校对"助手。输入是中文 ASR（语音识别）的原始转写，你的任务是先在理解层面修正中文识别错误、过滤口语废话，然后将其忠实地翻译为地道、专业的英文。

【核心原则】
原汁原味，精准翻译。忠实还原用户表达的真实核心语义与语气，清除语音噪声，绝对不改变原意，不强加总结，不改变陈述顺序。

【处理规则】
1. 提纯与意译过滤：忽略中文无意义的口语填充词（如：嗯、啊、那个、就是、就是说、然后）和结巴重复。在翻译时，需体现出原句结尾的语气词（如：吧、呢）所带有的委婉、疑问或确认的语气。
2. 纠错与专业术语：
   - 翻译前自动修正中文错别字和同音字。
   - 确保 IT/技术名词与商业缩写使用标准的英文表达和正确的大小写（例如：MySQL, EC2, AWS, PPT, HR）。
3. 规范数字格式：输入中的中文数字及表述（如：三、三三零六、三点一、百分之十五、十一月一号、下午两点半、Q三），在英文输出中必须统一转换为标准的阿拉伯数字和符号（如：3, 3306, 3.1, 15%, November 1st, 2:30 PM, Q3）。
4. 格式约束：绝对保留用户的原始句式和逻辑顺序，保持自然流畅的英文段落。绝对不要擅自分解、归纳或罗列成结构化的列表。
5. 行为约束：绝对不要回答、解释、总结或续写文本中提及的问题。

【示例】
输入：那个，我们今天准备把服务器MySQL数据库迁移到EC2上面去，大概需要扩容三台机器，端口号是三三零六吧。
输出：We are planning to migrate the server's MySQL database to EC2 today. We will probably need to scale up by 3 machines, and the port number is 3306, right?

输入：这个软件的版本从三点一升级到三点二的时候，出现了一些不兼容的情况。
输出：When this software version was upgraded from 3.1 to 3.2, some incompatibilities occurred.

输入：那个，明天下午两点半的部门例会，我们改到五层的一号会议室吧，大家记得准时参加。
输出：Let's move tomorrow afternoon's 2:30 department regular meeting to Meeting Room 1 on the 5th floor. Everyone please remember to attend on time.

输入：就是说今年Q三的营收目标，比去年同期增长了百分之十五左右，麻烦把这个数据更新到那个PPT里面呢。
输出：The Q3 revenue target this year has grown by about 15% compared to the same period last year. Could you please update this data in the PPT?

输入：呃张总说那个新的报销流程，从十一月一号开始执行，然后大家把发票整理好统一交给HR的那个王静。
输出：Mr. Zhang said the new reimbursement process will be implemented starting November 1st, so everyone please organize your invoices and hand them over to Wang Jing in HR.

只输出翻译和校对后的英文文本。`,
  },
]


export async function getHistory(): Promise<HistoryRecord[]> {
  return listHistory()
}

export async function listHistory(query: HistoryListQuery = {}): Promise<HistoryRecord[]> {
  try {
    const records = await api().historyList(query)
    return (records as HistoryRecord[]) || []
  } catch (err) {
    console.error('[store] listHistory FAILED:', err)
    return []
  }
}

export async function countHistory(query: Omit<HistoryListQuery, 'limit' | 'offset'> = {}): Promise<number> {
  try {
    const count = await api().historyCount(query)
    return count
  } catch (err) {
    console.error('[store] countHistory FAILED:', err)
    return 0
  }
}

export async function addHistory(record: HistoryRecord): Promise<void> {
  await api().historyAdd(record)
}

export async function deleteHistory(id: string): Promise<void> {
  await api().historyDelete(id)
}

export async function updateHistoryRecord(id: string, patch: Partial<HistoryRecord>): Promise<void> {
  await api().historyUpdate(id, patch as Record<string, unknown>)
}

export async function setHistoryFavorite(id: string, favorite: boolean): Promise<void> {
  await api().historySetFavorite(id, favorite)
}

export async function getFavoriteHistory(): Promise<HistoryRecord[]> {
  return listHistory({ favoriteOnly: true })
}

export async function getFeedbackQueue(): Promise<FeedbackRecord[]> {
  return ((await api().storeGet('feedbackQueue')) as FeedbackRecord[]) || []
}

export async function addFeedback(record: FeedbackRecord): Promise<void> {
  const queue = await getFeedbackQueue()
  queue.unshift(record)
  await api().storeSet('feedbackQueue', queue)
}

export async function getManualCorrections(): Promise<ManualCorrectionRecord[]> {
  return ((await api().storeGet('manualCorrections')) as ManualCorrectionRecord[]) || []
}

export async function addManualCorrection(record: ManualCorrectionRecord): Promise<void> {
  const corrections = await getManualCorrections()
  corrections.unshift(record)
  await api().storeSet('manualCorrections', corrections.slice(0, 200))
}

export async function getStats(): Promise<Stats> {
  try {
    const raw = await api().storeGet('stats')
    return (raw as Stats) || { totalDurationSec: 0, totalChars: 0 }
  } catch (err) {
    console.error('[store] getStats FAILED:', err)
    return { totalDurationSec: 0, totalChars: 0 }
  }
}

import { getDefault } from './defaults'

export async function getSetting<T>(key: string, fallback?: T): Promise<T> {
  const defaultValue = getDefault(key, fallback) as T
  const client = api()
  if (!client?.storeGet) {
    console.warn('[store] getSetting called before bridge is ready:', key)
    return defaultValue
  }
  const val = await client.storeGet(key)
  if (val === null || val === undefined) return defaultValue
  // 运行时类型校验：如果 defaultValue 有明确类型，检查返回值类型是否匹配
  if (defaultValue !== null && defaultValue !== undefined) {
    const expectedType = typeof defaultValue
    if (expectedType === 'string' || expectedType === 'number' || expectedType === 'boolean') {
      if (typeof val !== expectedType) return defaultValue
    }
  }
  return val as T
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await api().storeSet(key, value)
}

// Prompt presets

export async function getPromptPresets(): Promise<PromptPreset[]> {
  const custom = ((await api().storeGet('promptPresets')) as PromptPreset[]) || []

  const builtins = BUILTIN_PRESETS.map((bp) => {
    const override = custom.find((c) => c.id === bp.id)
    return override ? { ...override, builtin: true } : bp
  })

  const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id))
  const userCreated = custom.filter((c) => !builtinIds.has(c.id))

  return [...builtins, ...userCreated]
}

export async function getActivePresetId(): Promise<string> {
  return ((await api().storeGet('activePresetId')) as string) || 'intent'
}

export async function setActivePresetId(id: string): Promise<void> {
  await api().storeSet('activePresetId', id)
}

export async function getActivePreset(): Promise<PromptPreset> {
  const id = await getActivePresetId()
  const all = await getPromptPresets()
  return all.find((p) => p.id === id) || BUILTIN_PRESETS[0]
}

export async function savePromptPreset(preset: PromptPreset): Promise<void> {
  const custom = ((await api().storeGet('promptPresets')) as PromptPreset[]) || []
  const idx = custom.findIndex((p) => p.id === preset.id)

  const toSave = { ...preset }
  delete toSave.builtin

  if (idx >= 0) {
    custom[idx] = toSave
  } else {
    custom.push(toSave)
  }
  await api().storeSet('promptPresets', custom)
}

export async function deletePromptPreset(id: string): Promise<void> {
  const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id))
  if (builtinIds.has(id)) return

  const custom = ((await api().storeGet('promptPresets')) as PromptPreset[]) || []
  await api().storeSet('promptPresets', custom.filter((p) => p.id !== id))

  const activeId = await getActivePresetId()
  if (activeId === id) {
    await setActivePresetId('intent')
  }
}



