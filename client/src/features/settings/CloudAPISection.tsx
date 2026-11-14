// 云 API 模式配置面板 —— 一张卡 = 一份语音识别服务配置
//
// 结构与「AI 服务」页对齐（同一套卡片、同一套弹窗、同一套状态语义）：可以新建多份，
// 同一家也能存多份（两个百炼账号、两套豆包密钥），点一张即启用。
//
// 与 AI 服务的唯一实质差别：供应商从内置清单里选，不能填任意地址 —— 每家 ASR 的协议
// 都要一份专门的 Rust 实现，不像 AI 整理那边只要 OpenAI 兼容端点就能接。
//
// 「同平台重复粘密钥」不靠把凭据提到平台级来解决（那样一张卡就不再是一份完整配置、
// 也没法存两个账号），而是照 AI 服务的做法：新建时自动沿用同平台上一份的密钥，
// 并在界面上说明它从哪来。

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { CheckCircle2, ExternalLink, Info, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback, FormatHint, type FeedbackTone } from '@/components/ui/feedback'
import { Modal } from '@/components/ui/modal'
import { PasswordInput } from '@/components/ui/password-input'
import { Segmented } from '@/components/ui/segmented'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { refreshModeStatus } from '@/stores/modeStatus'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { buildAsrExtra } from '@/lib/asrModels'
import { describeProviderError } from '@/lib/errorMessages'
import { doubaoKeyLabel } from '@/lib/cloudAsrCreds'
import {
  ASR_PLATFORMS,
  ASR_PROVIDERS,
  asrAvailabilityLabel,
  asrModelsOf,
  describeAsrMissing,
  effectiveAsrCredentials,
  emptyAsrProfile,
  findAsrProvider,
  gradeAsrLatency,
  groupAsrModelsByVendor,
  ASR_COMPAT_PROTOCOLS,
  asrCardTitle,
  asrEndpointHost,
  asrEndpointUrl,
  parseAsrCompatProtocol,
  resolveAsrApiModel,
  resolveAsrModel,
  resolveAsrModelOption,
  resolveAsrRuntimeProvider,
  type AsrCheck,
  type AsrProfile,
} from './asrProviderCatalog'
import { loadAsrProfiles, saveAsrProfiles } from './asrProfileStore'
import { formatCheckedAt, formatLatency, isCheckFresh } from './aiProviderCatalog'
import { getLocale, t, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

const DOC_URL = 'https://my.feishu.cn/wiki/V4vLw2UfDiWcATkK2dyckhvynzc'

const DOUBAO_CONSOLE_OPTIONS = [
  { value: 'new', labelKey: 'asr.console.new' },
  { value: 'legacy', labelKey: 'asr.console.legacy' },
] as const

// ⚠️ 下面两段是**发给模型的 System Prompt**，不是界面文案，所以刻意保持中文、
// 不进 locale 文件。Prompt 的语种取决于用户说什么话，不取决于界面语言 ——
// 直译成英文会让中文口述的整理质量下降。英文 Prompt 集是独立的一件事，见
// dev-docs/i18n-todo.md 的 P2-5。只有下面 PRESETS 的 label 是界面文案，要翻。
// i18n-allow-start: 发给中文语音模型的产品 Prompt，不随界面语言切换
const DEFAULT_OMNI_PROMPT = '你是一个语音转文字助手。请将用户的语音内容准确转写为文字，保持原意，适当添加标点符号，不要添加任何额外的解释或评论。'

const OMNI_PROMPT_POLISH = `你是语音文本精炼助手。输入是 ASR 语音识别的原始转写，你的任务是清洗为可直接使用的干净文本。
核心原则：保留用户全部有效信息，只清除语音噪声和识别错误。
处理规则：
1. 移除口语填充词（嗯、啊、那个、就是说、然后呢）和无意义的重复、犹豫。
2. 识别自我修正——"不对"、"不是"、"应该是"、"改到"后以最终表达为准，删除前序错误。
3. 修正明显的语音识别错误：同音字、音近字、专有名词、英文大小写、数字和时间。
4. 添加标点符号，必要时分段。中英文混合保留合理空格。
5. 检测到"第一/第二/首先/然后"等结构化表达时，输出为有序列表。
约束：不添加原文没有的内容，不改变用户核心语义；不回答、解释、总结或续写文本中提到的问题。
只输出精炼后的文本。`
// i18n-allow-end

const OMNI_PROMPT_PRESETS = [
  { value: DEFAULT_OMNI_PROMPT, labelKey: 'asr.omniPreset.faithful' },
  { value: OMNI_PROMPT_POLISH, labelKey: 'asr.omniPreset.polish' },
] as const satisfies readonly { value: string; labelKey: TranslationKey }[]

const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'
const selectClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-2 text-sm transition-colors focus:border-input-focus-border'
const linkClass = 'inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 decoration-primary/40 transition-colors hover:decoration-primary'
const cardIconButtonClass = 'pointer-events-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
const helpIconClass = 'h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground'

interface Notice {
  tone: FeedbackTone
  message: string
  detail?: string
}

/**
 * 一次识别测试的结果。`check` 无论成败都要写回卡片 —— 失败也得让卡上显示「不可用」，
 * 而不是停在「未测试」让人以为没测过。
 */
type AsrTestOutcome =
  | { ok: true; check: AsrCheck; text: string; latencyMs: number; audioSec: number }
  | { ok: false; check: AsrCheck; message: string; detail?: string }

/**
 * 把内置测试音频准备成后端要的裸 PCM（base64）。
 * 从测试逻辑里单独拆出来，是为了让批量测试**只准备一次**给 N 张卡共用。
 */
async function prepareTestPcm(): Promise<{ pcmB64: string; audioSec: number }> {
  const wavB64 = await invoke<string>('get_test_audio_b64')
  const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0))
  const pcmBytes = wavBytes.slice(44) // 去掉 44 字节 WAV 头，后端要的是裸 PCM
  const audioSec = pcmBytes.length / 2 / 16000
  let pcmB64 = ''
  const chunk = 8192
  for (let i = 0; i < pcmBytes.length; i += chunk) {
    pcmB64 += String.fromCharCode(...pcmBytes.subarray(i, Math.min(i + chunk, pcmBytes.length)))
  }
  return { pcmB64: btoa(pcmB64), audioSec }
}

/**
 * 真跑一次识别并把结果收成 outcome。
 *
 * 刻意不碰任何 state、也不写存储：单张测试与「测试全部」共用它，各自决定怎么落盘、
 * 怎么提示。message 里不带供应商名字，由调用方按自己的语境加前缀。
 */
async function runAsrTest(
  profile: AsrProfile,
  audio: { pcmB64: string; audioSec: number },
): Promise<AsrTestOutcome> {
  const entry = findAsrProvider(profile.provider)
  if (!entry) {
    return { ok: false, check: { ok: false, at: Date.now(), reason: t('asr.err.unknownProvider') }, message: t('asr.err.unknownProvider') }
  }
  try {
    const creds = effectiveAsrCredentials(profile)
    // 测的是这张卡自己的配置（可能还没启用），所以 provider 与模型都从档案解析、
    // 不读运行时键。**provider 必须取选中模型的那个**（卡片 id 是平台，不是分发 key）。
    const runtimeProvider = resolveAsrRuntimeProvider(profile)
    const extra = buildAsrExtra(runtimeProvider, {
      model: resolveAsrApiModel(profile),
      // 指令只给 omni 那类模型 —— 千问卡上的 omniPrompt 即使选了非 omni 模型
      // 也可能有值，无条件带上会把它发给一个根本不读它的实现。
      instructions: resolveAsrModelOption(profile)?.omni ? profile.omniPrompt : '',
      baseUrl: asrEndpointUrl(profile),
      protocol: profile.protocol,
    })
    const start = performance.now()
    const r = await invoke<{ text: string; elapsed_ms: number }>('cloud_transcribe', {
      request: {
        audio_b64: audio.pcmB64,
        sample_rate: 16000,
        asr_config: {
          provider: runtimeProvider,
          api_key: creds.apiKey,
          app_id: creds.appId,
          ...(extra && { extra }),
        },
      },
    })
    const latencyMs = Math.round(performance.now() - start)
    const text = r.text.trim()
    if (!text) {
      // 连通了但一个字都没出：多半是资源没开通或额度问题，不能算可用
      return {
        ok: false,
        check: { ok: false, at: Date.now(), reason: t('asr.err.emptyText') },
        message: t('asr.msg.emptyText'),
      }
    }
    return {
      ok: true,
      check: { ok: true, at: Date.now(), latencyMs, audioSec: audio.audioSec },
      text,
      latencyMs,
      audioSec: audio.audioSec,
    }
  } catch (err) {
    const friendly = describeProviderError(err)
    return {
      ok: false,
      check: { ok: false, at: Date.now(), reason: friendly.message },
      message: t('asr.msg.testFailed', { message: friendly.message }),
      detail: friendly.detail,
    }
  }
}

// 卡片标题的规则（含「为什么这里绝不能出现密钥」）在 asrCardTitle 里。

export default function CloudAPISection() {
  useT()
  const [profiles, setProfiles] = useState<AsrProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [testingId, setTestingId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState('')
  /** 「测试全部」的进度；null = 没在批量测试 */
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  /** 批量测试是并发的，所以「正在测哪张」是一组而不是一张 */
  const [testingIds, setTestingIds] = useState<string[]>([])

  /** 正在编辑的那份（新建也走这里）。null = 弹窗关着 */
  const [draft, setDraft] = useState<AsrProfile | null>(null)
  const [draftIsNew, setDraftIsNew] = useState(false)
  const [draftBaseline, setDraftBaseline] = useState('')
  const [saving, setSaving] = useState(false)

  const busy = testingId !== '' || saving || batch !== null
  /** 这张卡正在测吗 —— 单张测试和并发批量测试都要算上 */
  const isTesting = (id: string) => testingId === id || testingIds.includes(id)
  const draftEntry = draft ? findAsrProvider(draft.provider) : undefined
  const draftPlatform = draftEntry?.platform ?? 'doubao'
  const draftIsDoubao = draftPlatform === 'doubao'
  const draftDirty = draft !== null && JSON.stringify(draft) !== draftBaseline
  /**
   * 密钥是不是从同平台上一份带过来的。
   * 用「当前值是否还等于那份的密钥」判断：用户一改成别的，这句提示自己就消失。
   */
  const draftKeyInherited = draft !== null
    && draftIsNew
    && draft.apiKey.trim() !== ''
    && lastProfileOfPlatform(draft.provider, draft.id)?.apiKey === draft.apiKey

  useEffect(() => {
    void load()
    return () => setEngineDraftDirty(false)
  }, [])

  async function load() {
    const state = await loadAsrProfiles()
    setProfiles(state.profiles)
    setActiveId(state.activeId)
    setLoaded(true)
  }

  /** 同平台最近一份配置，用来在新建时沿用密钥 */
  function lastProfileOfPlatform(providerId: string, excludeId?: string): AsrProfile | undefined {
    const platform = findAsrProvider(providerId)?.platform
    if (!platform) return undefined
    return [...profiles]
      .reverse()
      .find((p) => p.id !== excludeId && findAsrProvider(p.provider)?.platform === platform)
  }

  async function persist(next: AsrProfile[], nextActiveId: string) {
    setProfiles(next)
    setActiveId(nextActiveId)
    await saveAsrProfiles({ profiles: next, activeId: nextActiveId })
    void refreshModeStatus()
  }

  async function handleActivate(id: string) {
    if (id === activeId) return
    setNotice(null)
    await persist(profiles, id)
  }

  // ─────────────────────── 测试 ───────────────────────

  /**
   * 用内置测试音频真跑一次识别。
   *
   * 为什么不用更便宜的 test_asr_connection：那个只做握手鉴权，握手过了识别仍可能失败
   * （资源没开通、额度用尽），而且它测不出耗时。这一页要回答「哪个更快」，
   * 就得测真实转写。代价是一次真实计费调用，页面上写明了。
   */
  async function handleTest(profile: AsrProfile) {
    if (busy) return
    const entry = findAsrProvider(profile.provider)
    if (!entry) return
    const missing = describeAsrMissing(profile)
    if (missing) {
      setNotice({ tone: 'warning', message: t('asr.msg.missingBeforeTest', { label: entry.label, missing }) })
      return
    }
    setTestingId(profile.id)
    setNotice(null)
    try {
      const outcome = await runAsrTest(profile, await prepareTestPcm())
      await persist(
        profiles.map((p) => (p.id === profile.id ? { ...p, check: outcome.check } : p)),
        activeId,
      )
      if (!outcome.ok) {
        setNotice({ tone: 'error', message: `${entry.label} ${outcome.message}`, detail: outcome.detail })
        return
      }
      const grade = gradeAsrLatency(outcome.latencyMs, outcome.audioSec)
      setNotice({
        tone: grade.tone === 'bad' ? 'warning' : 'success',
        message: t('asr.msg.testOk', { label: entry.label, sec: outcome.audioSec.toFixed(1), latency: formatLatency(outcome.latencyMs), grade: grade.label }),
        detail: t('asr.msg.testDetail', { text: outcome.text }),
      })
    } catch (err) {
      // 只有准备测试音频这一步会漏到这里；识别本身的失败由 runAsrTest 收成 outcome
      const friendly = describeProviderError(err)
      setNotice({ tone: 'error', message: t('asr.msg.testCrashed', { label: entry.label, message: friendly.message }), detail: friendly.detail })
    } finally {
      setTestingId('')
    }
  }

  /**
   * 一键测试全部：**并发**真跑一次识别，一次点击直接开始（没有二次确认）。
   *
   * ⚠️ 并发的代价，改回串行前先想清楚：卡上的耗时是用来横向比较「哪个更快」的，
   * 并发跑出来的数字互相污染 —— 同平台的卡尤其明显（千问那几个变体共用一把百炼
   * 密钥，打的是同一个服务），还可能撞上限流被记成「不可用」。所以批量结果里会
   * 注明这批耗时不宜横向比较；要拿准数字，用卡上的单张测试。
   *
   * 另外两个决定：
   *  · **一次性落盘**，不逐张写。并发下每个回调拿到的都是同一份旧 profiles，
   *    逐张 persist 会互相覆盖，只剩最后一个的结论。代价是中途关页面这批就没了 ——
   *    并发之后整批只等最慢那张，这个窗口很短。
   *  · **跳过没配完的**，不给它们写「不可用」。它们缺的是密钥而不是可用性，
   *    写进结论只会污染卡片状态；跳过几张会在结果里说明。
   */
  async function handleTestAll() {
    if (busy) return
    const targets = profiles.filter((p) => !describeAsrMissing(p))
    const skipped = profiles.length - targets.length
    if (targets.length === 0) {
      setNotice({
        tone: 'warning',
        message: t('asr.msg.nothingToTest'),
      })
      return
    }

    setNotice(null)
    setBatch({ done: 0, total: targets.length })
    setTestingIds(targets.map((p) => p.id))

    try {
      // 测试音频只准备一次，N 张卡共用
      const audio = await prepareTestPcm()
      let done = 0
      const results = await Promise.all(targets.map(async (target) => {
        const outcome = await runAsrTest(target, audio)
        // 每张自己测完就把图标停下、进度加一，不用等整批结束
        done += 1
        setBatch({ done, total: targets.length })
        setTestingIds((prev) => prev.filter((id) => id !== target.id))
        return { target, outcome }
      }))

      const checks = new Map(results.map((r) => [r.target.id, r.outcome.check]))
      await persist(
        profiles.map((p) => {
          const check = checks.get(p.id)
          return check ? { ...p, check } : p
        }),
        activeId,
      )

      let okCount = 0
      let failCount = 0
      const lines = results.map(({ target, outcome }) => {
        const label = findAsrProvider(target.provider)?.label ?? target.provider
        if (outcome.ok) {
          okCount += 1
          const grade = gradeAsrLatency(outcome.latencyMs, outcome.audioSec)
          return t('asr.msg.batchLine', { label, latency: formatLatency(outcome.latencyMs), grade: grade.label })
        }
        failCount += 1
        return `${label}: ${outcome.message}`
      })

      const parts = [t('asr.msg.batchOk', { count: okCount })]
      if (failCount > 0) parts.push(t('asr.msg.batchFail', { count: failCount }))
      if (skipped > 0) parts.push(t('asr.msg.batchSkipped', { count: skipped }))
      if (targets.length > 1) {
        lines.push('', t('asr.msg.batchNote'))
      }
      setNotice({
        tone: failCount > 0 ? 'warning' : 'success',
        // 连接词也走 locale：中文用「，」，英文用「, 」
        message: t('asr.msg.batchDone', { parts: parts.join(t('asr.listSeparator')) }),
        detail: lines.join('\n'),
      })
    } catch (err) {
      // 只有准备测试音频这一步会漏到这里；识别本身的失败由 runAsrTest 收成 outcome
      const friendly = describeProviderError(err)
      setNotice({ tone: 'error', message: t('asr.msg.batchCrashed', { message: friendly.message }), detail: friendly.detail })
    } finally {
      setTestingIds([])
      setBatch(null)
    }
  }

  // ─────────────────────── 新建 / 编辑 ───────────────────────

  function openEditor(profile: AsrProfile, isNew: boolean) {
    setDraft(profile)
    setDraftIsNew(isNew)
    setDraftBaseline(JSON.stringify(profile))
    setNotice(null)
  }

  function handleNew() {
    const fresh = emptyAsrProfile()
    // 同平台已有配置时把密钥带过来：最常见的一次操作是「同一个账号、换个模型再存一份」，
    // 否则又要回控制台复制粘贴一遍
    const prev = lastProfileOfPlatform(fresh.provider, fresh.id)
    if (prev) {
      fresh.apiKey = prev.apiKey
      fresh.otherKey = prev.otherKey
      fresh.appId = prev.appId
      fresh.console = prev.console
      fresh.workspaceId = prev.workspaceId
    }
    fresh.omniPrompt = DEFAULT_OMNI_PROMPT
    openEditor(fresh, true)
  }

  function closeEditor() {
    if (saving) return
    setDraft(null)
    setEngineDraftDirty(false)
  }

  function patchDraft(next: Partial<AsrProfile>) {
    if (!draft) return
    const merged = { ...draft, ...next }
    setDraft(merged)
    setEngineDraftDirty(JSON.stringify(merged) !== draftBaseline)
  }

  /** 换供应商：跨平台时清掉不属于新平台的凭据，并沿用新平台已有的密钥 */
  function handleDraftProvider(providerId: string) {
    if (!draft) return
    const nextPlatform = findAsrProvider(providerId)?.platform
    const prevPlatform = findAsrProvider(draft.provider)?.platform
    // 换卡就回到新卡的默认模型。**显式写入而不是留空** —— 空串会被 parseAsrProfiles
    // 当成存量数据走迁移（见那边的判据说明）。
    const nextModel = asrModelsOf(findAsrProvider(providerId)!)[0].id
    if (nextPlatform === prevPlatform) {
      patchDraft({ provider: providerId, model: nextModel })
      return
    }
    // 平台变了，旧密钥对新家没有意义 —— 留着只会被当成"已配置"而实际发不出去
    const prev = lastProfileOfPlatform(providerId, draft.id)
    patchDraft({
      provider: providerId,
      model: nextModel,
      apiKey: prev?.apiKey ?? '',
      otherKey: prev?.otherKey ?? '',
      appId: prev?.appId ?? '',
      console: prev?.console ?? 'new',
      workspaceId: prev?.workspaceId ?? '',
    })
  }

  /** 切换豆包控制台代次：把当前密钥留给这一代，取出另一代的填进来 */
  function switchConsole(next: string) {
    if (!draft || (next !== 'new' && next !== 'legacy')) return
    if (next === draft.console) return
    patchDraft({ console: next, apiKey: draft.otherKey, otherKey: draft.apiKey })
  }

  async function handleSaveDraft() {
    if (!draft || saving) return
    setSaving(true)
    try {
      // 改过凭据就把旧结论作废：否则卡上那枚用旧 key 测出来的「可用」还挂着，
      // 等于拿过期结论替新配置作保
      const before = profiles.find((p) => p.id === draft.id)
      const credsChanged = !before
        || JSON.stringify(effectiveAsrCredentials(before)) !== JSON.stringify(effectiveAsrCredentials(draft))
      const saved: AsrProfile = { ...draft, check: credsChanged ? undefined : before?.check }

      const next = draftIsNew
        ? [...profiles, saved]
        : profiles.map((p) => (p.id === saved.id ? saved : p))
      // 新建的那份直接启用：用户刚配好它，多半就是想用它
      await persist(next, draftIsNew ? saved.id : activeId)

      setDraft(null)
      setEngineDraftDirty(false)
      const missing = describeAsrMissing(saved)
      setNotice(missing
        ? { tone: 'warning', message: t('asr.msg.savedWithMissing', { missing }) }
        : { tone: 'success', message: t('asr.msg.saved') })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    const next = profiles.filter((p) => p.id !== id)
    // 删掉的正好是启用中的那份时，让 resolveActiveAsrProfile 回落到第一条
    await persist(next, id === activeId ? (next[0]?.id ?? '') : activeId)
    setPendingDeleteId('')
    setNotice(null)
  }

  // ─────────────────────── 卡片 ───────────────────────

  interface CardStatus {
    label: string
    tone: 'neutral' | 'ok' | 'warn' | 'bad'
    spoken: string
    hint: string
    /**
     * 这张卡还缺配置。
     * 单独一个标志而不是复用 tone === 'warn'：延迟「偏慢」也是 warn，
     * 但那不需要用户去填任何东西，按钮不必常驻。
     */
    needsSetup?: boolean
  }

  function describeCard(profile: AsrProfile): CardStatus {
    if (isTesting(profile.id)) {
      return { label: t('asr.status.testing'), tone: 'neutral', spoken: t('asr.status.testingSpoken'), hint: t('asr.status.testingHint') }
    }
    const missing = describeAsrMissing(profile)
    if (missing) {
      return { label: t('asr.status.needsSetup'), tone: 'warn', spoken: missing, hint: missing, needsSetup: true }
    }
    // 业务空间 ID 是**模型级**要求（千问那五个里只有 realtime 那个要），
    // 按卡片判会让选了别的模型的用户也被要求填
    if (resolveAsrModelOption(profile)?.needsWorkspaceId && !profile.workspaceId.trim()) {
      return {
        label: t('asr.status.missingWorkspace'),
        tone: 'warn',
        spoken: t('asr.status.missingWorkspaceSpoken'),
        hint: t('asr.status.missingWorkspaceHint'),
        needsSetup: true,
      }
    }
    const check = profile.check
    if (!check) {
      return { label: t('asr.status.untested'), tone: 'neutral', spoken: t('asr.status.untestedSpoken'), hint: t('asr.status.untestedHint') }
    }
    if (!check.ok) {
      const reason = check.reason ?? t('common.unknownReason')
      return {
        label: t('asr.status.unavailable'),
        tone: 'bad',
        spoken: t('asr.status.unavailableSpoken', { reason }),
        hint: t('asr.status.unavailableHint', { when: formatCheckedAt(check.at), reason }),
      }
    }
    const fresh = isCheckFresh(check)
    const ms = check.latencyMs
    if (ms === undefined) {
      return { label: t('asr.status.available'), tone: fresh ? 'ok' : 'neutral', spoken: t('asr.status.available'), hint: t('asr.status.availableHint', { when: formatCheckedAt(check.at) }) }
    }
    const grade = gradeAsrLatency(ms, check.audioSec ?? 0)
    return {
      label: formatLatency(ms),
      // 结论过期就把颜色收回中性：绿色只代表「刚刚验过，可以信」
      tone: fresh ? grade.tone : 'neutral',
      spoken: t('asr.status.availableSpoken', { grade: grade.label, latency: formatLatency(ms) }),
      hint: t('asr.status.availableDetailHint', {
        when: formatCheckedAt(check.at),
        sec: (check.audioSec ?? 0).toFixed(1),
        latency: formatLatency(ms),
        grade: grade.label,
        stale: fresh ? '' : t('asr.staleSuffix'),
      }),
    }
  }

  const chipToneClass: Record<CardStatus['tone'], string> = {
    neutral: 'bg-muted text-muted-foreground',
    ok: 'bg-success/10 text-success-strong',
    warn: 'bg-warning/10 text-warning-strong',
    bad: 'bg-destructive/10 text-destructive',
  }

  function renderCard(profile: AsrProfile) {
    const entry = findAsrProvider(profile.provider)
    if (!entry) return null
    const isActive = profile.id === activeId
    const status = describeCard(profile)
    const siblings = profiles.filter((p) => p.provider === profile.provider).length
    const title = asrCardTitle(profile, siblings)
    const availability = asrAvailabilityLabel(entry)
    // 卡上那行小字必须是**这张卡真正会用的**模型，不是目录里的默认值 ——
    // 否则选了 whisper-large-v3 的卡看上去还写着 turbo。
    //
    // 显示**真实模型 ID**，不再显示短名。短名是「一张卡 = 一个模型」时代留下的，
    // 那时它们是卡片标题（「千问 ASR 一次性」靠「一次性」跟流式那张卡对比）。
    // 挪进卡内当模型名之后，前缀重复、对比对象也没了，用户看到的是一个
    // 既不像模型也说不清是什么的词。真实 ID 反而一眼认得出，也能拿去对文档和账单。
    const option = resolveAsrModelOption(profile)
    const model = option ? option.id : resolveAsrModel(profile)
    // 自定义端点的卡再补一个主机名：那种卡之间真正的差别是「连的是哪台」
    const host = asrEndpointHost(profile)
    const modelLine = host ? `${model} · ${host}` : model
    return (
      <div
        key={profile.id}
        className={cn(
          'group relative rounded-lg border p-2.5 transition-colors',
          isActive ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
        )}
      >
        {/* 铺满整卡的单选按钮：卡上还有自己的图标按钮，不能把整张卡做成 <button>
            （按钮套按钮，读屏和键盘都会错） */}
        <button
          type="button"
          role="radio"
          aria-checked={isActive}
          aria-label={t('common.cardStatusAria', { title, subtitle: model, status: status.spoken })}
          onClick={() => void handleActivate(profile.id)}
          className="absolute inset-0 rounded-lg"
        />
        <div className="flex items-center gap-1.5">
          {isActive && (
            <Tooltip className="pointer-events-auto relative z-10 shrink-0" content={t('common.inUse')}>
              <CheckCircle2 className="h-4 w-4 shrink-0 cursor-help text-success-strong" aria-label={t('common.inUse')} />
            </Tooltip>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</span>
          <Tooltip className="pointer-events-auto relative z-10 shrink-0" variant="light" content={status.hint}>
            <span className={cn('cursor-help rounded-full px-2 py-0.5 text-[11px] font-medium', chipToneClass[status.tone])}>
              {status.label}
            </span>
          </Tooltip>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          {/* title 给完整模型 ID：卡上显示的是短名，鼠标悬停能看到真名 */}
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={modelLine}>
            {modelLine}
          </span>
          {/* 待配置的卡片按钮常驻：它正在等用户去填东西，把唯一的入口藏进 hover
              等于让人对着一张没有可点之处的卡发呆。配好之后回到 hover 显隐 */}
          <div
            className={cn(
              'pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
              status.needsSetup ? 'opacity-100' : 'opacity-0',
            )}
          >
            <Tooltip className="pointer-events-auto" content={t('common.test')}>
              <button
                type="button"
                onClick={() => void handleTest(profile)}
                disabled={busy}
                aria-label={t('asr.testAria', { title })}
                className={cardIconButtonClass}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isTesting(profile.id) && 'animate-spin')} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content={t('common.edit')}>
              <button
                type="button"
                onClick={() => openEditor({ ...profile }, false)}
                aria-label={t('asr.editAria', { title })}
                className={cardIconButtonClass}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content={t('common.delete')}>
              <button
                type="button"
                onClick={() => setPendingDeleteId(profile.id)}
                disabled={busy}
                aria-label={t('asr.deleteAria', { title })}
                className={cardIconButtonClass}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
        </div>
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
          {entry.blurb}
          {/* 地区提示多数供应商为空（见 asrAvailabilityLabel），条件渲染避免留一个空 span 和多余空格 */}
          {availability !== '' && <> <span className="font-medium">{availability}</span></>}
        </p>
      </div>
    )
  }

  // ─────────────────────── 弹窗 ───────────────────────

  function renderEditor() {
    if (!draft) return null
    const platformInfo = ASR_PLATFORMS[draftPlatform]
    const draftEntry = findAsrProvider(draft.provider)
    const draftAvailability = draftEntry ? asrAvailabilityLabel(draftEntry) : ''
    const draftModels = draftEntry ? asrModelsOf(draftEntry) : []
    const draftModelGroups = groupAsrModelsByVendor(draftModels)
    // 业务空间 ID、System Prompt 这些都是**模型级**条件，要按选中的那个模型算
    const draftModelOption = resolveAsrModelOption(draft)
    const keyLabel = draftIsDoubao ? doubaoKeyLabel(draft.console) : 'API Key'
    return (
      <Modal
        title={draftIsNew ? t('asr.editorNew') : t('asr.editorEdit')}
        onClose={closeEditor}
        locked={saving}
        showCloseButton
        panelClassName="w-[520px]"
      >
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="asr-provider" className="mb-1 block text-sm text-muted-foreground">{t('asr.provider')}</label>
            <select
              id="asr-provider"
              value={draft.provider}
              onChange={(e) => handleDraftProvider(e.target.value)}
              className={selectClass}
            >
              {/* 平铺，**不按「内置 / 自己填地址」分组**。曾经分成两个 optgroup，
                  用户否掉了：在他看来这些都是「一个能用的语音识别服务」，分组等于把
                  我们的实现差异摆到选择界面上。要填什么由下面那几栏各自说明
                  （地址栏和协议栏本来就只在需要时出现）。 */}
              {ASR_PROVIDERS.map((p) => {
                const models = asrModelsOf(p)
                // 多模型的只列平台名（模型由下面那个下拉选）；**单模型的直接把模型名
                // 带出来** —— 那种情况下下面的模型下拉根本不渲染，不带的话用户在这一步
                // 完全看不到自己要用的是哪个模型。协议卡除外：它那一个模型只是默认值，
                // 真正用哪个由用户自己填。
                const showModel = models.length === 1 && !p.customEndpoint
                return (
                  <option key={p.id} value={p.id}>
                    {showModel ? `${p.label} · ${models[0].id}` : p.label}
                  </option>
                )
              })}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {draftEntry?.blurb}
              {draftAvailability !== '' && <> <span className="font-medium">{draftAvailability}</span></>}
            </p>
          </div>

          {/* 卡片名称。可空，留空就显示平台名。
              这一栏是为了取代「自动在标题后面补密钥末 4 位」那个做法 —— 同平台两张卡
              到底差在哪，用户比我们清楚，而我们那个区分方式让人以为密钥泄露了。 */}
          <div>
            <label htmlFor="asr-name" className="mb-1 block text-sm text-muted-foreground">
              {t('asr.cardName')}
            </label>
            <input
              id="asr-name"
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
              placeholder={draftEntry?.label ?? ''}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('asr.cardNameHint')}</p>
          </div>

          {/* 接口地址。**按选中的模型决定要不要显示**，不是按卡片 ——
              同一张卡里可以既有 HTTP 模型（能改地址）又有 WebSocket 模型（改不了），
              千问那张卡就是。协议卡是必填，内置卡是可选覆盖（中转站 / 反代）。 */}
          {draftModelOption?.supportsCustomUrl && (
            <div>
              <label htmlFor="asr-api-url" className="mb-1 block text-sm text-muted-foreground">
                {draftModelOption.requiresCustomUrl ? t('asr.apiUrl') : t('asr.apiUrlOptional')}
              </label>
              <input
                id="asr-api-url"
                type="url"
                inputMode="url"
                value={draft.apiUrl}
                onChange={(e) => patchDraft({ apiUrl: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
                placeholder={draftEntry?.urlPlaceholder ?? ''}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {draftModelOption.requiresCustomUrl ? t('asr.apiUrlHint') : t('asr.apiUrlOptionalHint')}
              </p>
            </div>
          )}

          {/* 协议：只有协议卡需要，而且默认「自动」。
              摆在这里而不是藏进高级设置，是因为自动探测判不准时用户得找得到它；
              但默认值让绝大多数人不必碰它。 */}
          {draftEntry?.customEndpoint && (
            <div>
              <label htmlFor="asr-protocol" className="mb-1 block text-sm text-muted-foreground">
                {t('asr.protocol')}
              </label>
              <select
                id="asr-protocol"
                value={draft.protocol}
                onChange={(e) => patchDraft({ protocol: parseAsrCompatProtocol(e.target.value) })}
                className={selectClass}
              >
                {ASR_COMPAT_PROTOCOLS.map((value) => (
                  <option key={value} value={value}>{t(`asr.protocol.${value}`)}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">{t('asr.protocolHint')}</p>
            </div>
          )}

          {/* 协议卡的模型是**自由文本**：对面挂什么模型我们无从知道，
              给个下拉等于替用户瞎猜。占位符给的是常见默认值。 */}
          {draftEntry?.customEndpoint && (
            <div>
              <label htmlFor="asr-model-text" className="mb-1 block text-sm text-muted-foreground">
                {t('asr.model')}
              </label>
              <input
                id="asr-model-text"
                value={draft.model}
                onChange={(e) => patchDraft({ model: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
                placeholder={draftModels[0]?.id ?? ''}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('asr.modelFreeTextHint')}</p>
            </div>
          )}

          {/* 模型下拉。**只有一个模型时不渲染** —— 摆一个点开只有一项的下拉，
              等于让用户以为这里有得选。多数服务换模型 = 换服务条目（协议都不一样），
              真正有多个模型的只有走同一个端点的那几家。
              OpenRouter 有 20 多个、来自十来家厂商，所以按厂商分组（optgroup）；
              别家的模型名不带厂商前缀，groupAsrModelsByVendor 会返回 null 走平铺。 */}
          {draftModels.length > 1 && (
            <div>
              <label htmlFor="asr-model" className="mb-1 block text-sm text-muted-foreground">{t('asr.model')}</label>
              <select
                id="asr-model"
                value={resolveAsrModel(draft)}
                onChange={(e) => patchDraft({ model: e.target.value })}
                className={selectClass}
              >
                {draftModelGroups
                  ? draftModelGroups.map(([vendor, models]) => (
                    <optgroup key={vendor} label={vendor}>
                      {models.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.id === draftModels[0].id
                            ? t('asr.modelDefaultOption', { model: option.id })
                            : option.id}
                        </option>
                      ))}
                    </optgroup>
                  ))
                  : draftModels.map((option, index) => (
                    <option key={option.id} value={option.id}>
                      {index === 0
                        ? t('asr.modelDefaultOption', { model: option.id })
                        : option.id}
                    </option>
                  ))}
              </select>
              {/* 选中模型自己的一句定位优先 —— 真正要帮用户做的决定是「在这一家里面
                  选哪个」，而那五个千问模型的差别比千问和豆包的差别还大。
                  模型没写 blurb 时退回讲整张卡的那句话。 */}
              <p className="mt-1 text-xs text-muted-foreground">
                {draftModelOption?.blurb
                  ?? (draftModelGroups ? t('asr.modelHintRouted') : t('asr.modelHint'))}
              </p>
            </div>
          )}

          {draftIsDoubao && (
            <div>
              <label className="mb-1.5 block text-sm text-muted-foreground">{t('asr.consoleVersion')}</label>
              <Segmented
                label={t('asr.consoleVersionLabel')}
                size="sm"
                value={draft.console}
                // 常量表存的是 key，到这里才翻成当前语言
                options={DOUBAO_CONSOLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                onChange={switchConsole}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {draft.console === 'new'
                  ? t('asr.consoleNewHint')
                  : t('asr.consoleLegacyHint')}
              </p>
            </div>
          )}

          {draftIsDoubao && draft.console === 'legacy' && (
            <div>
              <label htmlFor="asr-app-id" className="mb-1 block text-sm text-muted-foreground">App ID</label>
              <input
                id="asr-app-id"
                value={draft.appId}
                onChange={(e) => patchDraft({ appId: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
                placeholder={t('asr.appIdPlaceholder')}
                className={inputClass}
              />
              {draft.appId.trim() && !/^\d+$/.test(draft.appId.trim()) && (
                <FormatHint text={t('asr.hint.appId')} />
              )}
            </div>
          )}

          {/* data-modal-autofocus：弹窗打开时焦点落在密钥上（这才是要干的事），
              而不是第一个可聚焦元素 */}
          <div data-modal-autofocus>
            <label htmlFor="asr-api-key" className="mb-1 block text-sm text-muted-foreground">{keyLabel}</label>
            <PasswordInput
              id="asr-api-key"
              label={keyLabel}
              value={draft.apiKey}
              onChange={(v) => patchDraft({ apiKey: v })}
              onSubmit={() => void handleSaveDraft()}
              placeholder={t('asr.keyPlaceholder', { platform: platformInfo.label, keyLabel })}
              className={inputClass}
            />
            {/\s/.test(draft.apiKey) && (
              <FormatHint text={t('asr.hint.key')} />
            )}
            {draftPlatform === 'qwen' && draft.apiKey.trim() && !/^sk-/.test(draft.apiKey.trim()) && (
              <FormatHint text={t('asr.hint.bailianKey')} />
            )}
            {/* 最常见的填错是从 AI 服务那边复制了别家的密钥（智谱、豆包的都不是 sk- 开头），
                不提示的话只能等测试报「密钥被拒绝」才发现 */}
            {draftPlatform === 'deepseek' && draft.apiKey.trim() && !/^sk-/.test(draft.apiKey.trim()) && (
              <FormatHint text={t('asr.hint.deepseekKey')} />
            )}
            {/* 密钥不是凭空出现的：说一句它从哪来，免得用户以为自己看错了 */}
            {draftKeyInherited && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('asr.keyReused')}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              <button type="button" onClick={() => void shellOpen(platformInfo.consoleUrl)} className={linkClass}>
                {t('asr.openConsole', { platform: platformInfo.label })}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </button>
              {/* 配置文档只对豆包显示。别的平台都是「去控制台复制一把 API Key」，
                  上面那个控制台链接已经足够；只有豆包要在新旧两代控制台之间做选择
                  （新版只给 API Key，旧版还要 Access Token + App ID），光看界面讲不清，
                  确实需要一篇文档。给所有平台都挂上等于让用户为一件不复杂的事去读文档。
                  英文文档发布前，这个链接只对中文界面显示。 */}
              {draftPlatform === 'doubao' && getLocale() === 'zh-CN' && (
                <button type="button" onClick={() => void shellOpen(DOC_URL)} className={linkClass}>
                  {t('asr.howToGetKey')}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </button>
              )}
            </div>
          </div>

          {draftModelOption?.needsWorkspaceId && (
            <div>
              <label htmlFor="qwen-workspace-id" className="mb-1 block text-sm text-muted-foreground">
                {t('asr.workspaceId')}
              </label>
              <PasswordInput
                id="qwen-workspace-id"
                label={t('asr.workspaceId')}
                value={draft.workspaceId}
                onChange={(v) => patchDraft({ workspaceId: v })}
                placeholder={t('asr.workspacePlaceholder')}
                className={inputClass}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('asr.workspaceHint')}
              </p>
            </div>
          )}

          {/* Omni 是「识别 + 整理」一体的模型，System Prompt 决定它整理成什么样，
              属于这份服务自己的行为，所以放在这份配置里 */}
          {draftModelOption?.omni && (
            <div>
              <label htmlFor="omni-system-prompt" className="mb-1.5 block text-sm text-muted-foreground">
                System Prompt
              </label>
              <Segmented
                className="mb-1.5"
                label={t('asr.systemPromptPreset')}
                size="sm"
                value={draft.omniPrompt}
                options={OMNI_PROMPT_PRESETS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                onChange={(v) => patchDraft({ omniPrompt: v })}
              />
              <textarea
                id="omni-system-prompt"
                value={draft.omniPrompt}
                onChange={(e) => patchDraft({ omniPrompt: e.target.value })}
                placeholder={DEFAULT_OMNI_PROMPT}
                rows={2}
                className="w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm transition-colors focus:border-input-focus-border"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('asr.omniNote')}
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={closeEditor} disabled={saving}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={() => void handleSaveDraft()} disabled={saving || !draftDirty}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  const pendingDelete = profiles.find((p) => p.id === pendingDeleteId) ?? null

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-[18rem]">
            <div className="flex items-center gap-2">
              <h2 id="asr-service-heading" className="text-lg font-semibold">{t('asr.title')}</h2>
              <Tooltip
                variant="light"
                content={t('asr.help')}
              >
                <Info aria-label={t('asr.helpAria')} className={helpIconClass} />
              </Tooltip>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('asr.desc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* 并发跑，所以没有「停止」：invoke 发出去的请求没法撤回，
                摆一颗停不掉任何东西的按钮比没有更糟。整批只等最慢那张，很快。 */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => void handleTestAll()}
              disabled={busy || profiles.length === 0}
            >
              <RefreshCw className={cn('mr-1 h-3.5 w-3.5', batch && 'animate-spin')} aria-hidden />
              {batch ? t('asr.testingBatch', { done: batch.done, total: batch.total }) : t('asr.testAll')}
            </Button>
            <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={handleNew} disabled={busy}>
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('common.new')}
            </Button>
          </div>
        </div>

        {!loaded ? (
          <p className="py-2 text-sm text-muted-foreground">{t('asr.loading')}</p>
        ) : profiles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
            {t('asr.empty')}
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby="asr-service-heading"
            className="grid gap-2.5 sm:grid-cols-3"
          >
            {profiles.map(renderCard)}
          </div>
        )}

        {notice && (
          <Feedback className="mt-3" tone={notice.tone} message={notice.message} detail={notice.detail} />
        )}
      </CardContent>

      {renderEditor()}

      {pendingDelete && (
        <Modal title={t('asr.deleteTitle')} onClose={() => setPendingDeleteId('')} showCloseButton panelClassName="w-[420px]">
          <div className="mt-3 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('asr.deleteBody', { name: asrCardTitle(pendingDelete, profiles.filter((p) => p.provider === pendingDelete.provider).length) })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPendingDeleteId('')}>{t('common.cancel')}</Button>
              <Button size="sm" onClick={() => void handleDelete(pendingDelete.id)}>{t('common.delete')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  )
}
