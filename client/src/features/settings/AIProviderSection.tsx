// 「AI 服务」—— 一张卡 = 一份完整可用的配置（供应商 + 地址 + 密钥 + 模型）。
//
// 为什么不是原来的「先选供应商、再填一套」：那个形状下存储按供应商分槽
// （`cloudAi.<provider>.*`），于是
//   1. 两个不同端点的「OpenAI 兼容」物理上存不下第二份——点模型只改 model 字段、
//      地址和密钥不动，两个模型实际都打向同一个端点，其中一个必然是错的；
//   2. 候选模型按当前供应商过滤，想比较 DeepSeek 和千问哪个出字快，得来回拨下拉，
//      而出字快慢是口述场景里选 LLM 唯一压倒性重要的指标。
// 现在一张卡就是一份完整配置，点一下整份生效；网格是平的，所有候选同屏可比。
//
// 形状不是新造的，是本仓库既有的两处房规：
//   - 单选卡片网格 = `WorkModeSection`（工作模式）与外观页主题：
//     `role="radiogroup"` + `grid gap-3 sm:grid-cols-3`，选中态 `border-primary bg-primary/5`
//     再加一个对勾（不让"当前是哪个"只依赖颜色）。
//   - 新建 / 编辑 / 删除走 `Modal`（和「更改模型目录」「确认删除模型」同一个壳）：
//     它自带 Esc、焦点陷阱、关闭后还原焦点。上一版把编辑面板挂在页面下方，
//     点「新建」屏幕上毫无变化，用户以为按钮坏了；弹窗从根上没有这个问题。
//
// 卡上显示什么，标准是"能不能把两张卡区分开"：模型名 + 供应商永远显示；
// 主机名只在它不是该供应商默认地址时才显示（见 profileCustomHost 的注释）；
// 完整 URL 只在编辑弹窗里。耗时是这一页唯一属于 SayIt 的信息，常显。

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { CheckCircle2, ExternalLink, Info, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback, FormatHint, type FeedbackTone } from '@/components/ui/feedback'
import { Modal } from '@/components/ui/modal'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getSetting, setSetting } from '@/services/store'
import {
  SERVER_AI_SOURCE_KEY,
  setRuntimeServerAiSource,
  type ServerAiSource,
} from '@/services/transcription/serverAiSource'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { useAiEnabled } from '@/hooks/useAiEnabled'
import { describeProviderError } from '@/lib/errorMessages'
import {
  aiProvidersForDisplay,
  blankProfile,
  checkAiKeyFormat,
  checkApiUrl,
  extractTestReply,
  findProvider,
  formatCheckedAt,
  formatLatency,
  gradeLatency,
  isCheckFresh,
  isProfileComplete,
  keyAfterProviderSwitch,
  profileSubtitle,
  profileTitle,
  preferredAiProviderValue,
  providerLabel,
  resolveActiveProfile,
  type AiProfile,
  type AiProfileCheck,
} from './aiProviderCatalog'
import { loadAiProfiles, saveAiProfiles } from './aiProfileStore'
import { getLocale, t } from '@/i18n'
import { useT } from '@/i18n/useT'

interface TestResult { ok: boolean; message: string; elapsed_ms: number; detail?: string }

interface Notice {
  tone: FeedbackTone
  message: string
  detail?: string
  /** 结果显示在哪：弹窗里（保存/测试）还是网格下方（卡上的测速） */
  scope: 'editor' | 'list'
}

interface TestOutcome {
  ok: boolean
  elapsedMs: number
  reply: string
  message: string
  detail?: string
}

/** 「未保存」的判断基准：模型清单也算在内，但检测结论不算（它不是用户填的东西） */
function draftSnapshot(draft: AiProfile, models: string[]): string {
  return JSON.stringify({
    provider: draft.provider,
    apiUrl: draft.apiUrl,
    apiKey: draft.apiKey,
    models,
  })
}

/** 把一次测试的结果收成落盘用的结论。失败原因只留那句人话，原始异常不进存储 */
function outcomeToCheck(outcome: TestOutcome): AiProfileCheck {
  return outcome.ok
    ? { ok: true, at: Date.now(), latencyMs: outcome.elapsedMs }
    : { ok: false, at: Date.now(), reason: outcome.message }
}

interface CardStatus {
  /** 卡上那枚标签的可见文字。可用时只放数字（320ms），档位靠颜色区分，把宽度让给模型名 */
  text: string
  /** 标签的底色 + 文字色（tone 就靠它表达，不再另画圆点） */
  box: string
  /** 读屏用的完整说法：数字之外还念出结论词（可用 · 很快），补上视力用户靠颜色获得的信息 */
  spoken: string
  /** tooltip 文案。空串 = 不挂 tooltip */
  hint: string
}

/**
 * 测通了但很慢，结果不该报成一片绿色的「成功」。
 * 分档标准见 gradeLatency：口述时超过 1 秒就能感觉到停顿，超过 2 秒基本没法用来干活。
 */
function latencyTone(ms: number): FeedbackTone {
  return gradeLatency(ms).tone === 'ok' ? 'success' : 'warning'
}

/** 一句话结论。慢到不该用的时候，第一句就得说出来，别让用户从数字里自己算 */
function successMessage(model: string, ms: number): string {
  const grade = gradeLatency(ms)
  if (grade.tier === 'tooSlow') {
    return t('ai.msg.tooSlow', { model, latency: formatLatency(ms) })
  }
  if (grade.tier === 'slow') {
    return t('ai.msg.slow', { model, latency: formatLatency(ms) })
  }
  return t('ai.msg.ok', { model, latency: formatLatency(ms), grade: grade.label })
}

/**
 * 测试通过后的完整交代。
 *
 * 为什么要这么全：这行结果是用户唯一能核对"我到底测的是哪一份配置"的地方。
 * 只报一个耗时的话，两张卡都叫 gpt-4o-mini 时根本分不清刚才测的是哪个端点。
 * 排成一列「字段：值」，不是写句子——它是一份记录，不是一段说明。
 */
function successDetail(profile: AiProfile, outcome: TestOutcome): string {
  const grade = gradeLatency(outcome.elapsedMs)
  return [
    t('ai.detail.provider', { value: providerLabel(profile.provider) }),
    t('ai.detail.model', { value: profile.model }),
    t('ai.detail.endpoint', { value: profile.apiUrl }),
    t('ai.detail.roundTrip', { latency: formatLatency(outcome.elapsedMs), grade: grade.label }),
    outcome.reply ? t('ai.detail.reply', { value: outcome.reply }) : '',
    t('ai.detail.time', { value: new Date().toLocaleTimeString(getLocale(), { hour12: false }) }),
  ].filter(Boolean).join('\n')
}

function renderStatusChip(status: CardStatus) {
  const chip = (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
        status.box,
        status.hint && 'cursor-help',
      )}
    >
      {status.text}
    </span>
  )
  if (!status.hint) return <span className="shrink-0">{chip}</span>
  // 指针事件要单独收回来：外面那层把点击让给了铺满整卡的单选按钮
  return (
    <Tooltip variant="light" className="pointer-events-auto relative z-10 shrink-0" content={status.hint}>
      {chip}
    </Tooltip>
  )
}

const NEUTRAL_BOX = 'bg-muted text-muted-foreground'

/**
 * 卡上那枚状态标签。
 *
 * 设计取舍：可用时标签**只显示耗时数字**（如「320ms」），快慢档位完全靠颜色区分，
 * 不再把「很快 / 太慢」这些字塞进去——那几个字会挤占模型名的横向空间，而模型名
 * 动辄二十多个字符，宁可把地方让给它。档位词移进 tooltip；读屏另有 spoken 完整念出。
 *
 * 另外两条老规矩不变：
 *   - 颜色只在结论新鲜时才给。超过保鲜期（CHECK_FRESH_MS）一律收回中性灰——
 *     三天前测出的绿色和刚测的一样，那是在替供应商做无限期担保。
 *   - 红色表示"别用这个"，所以「不可用」和「太慢」共用它——后者是能连上但等不起。
 */
function describeStatus(profile: AiProfile, checking: boolean): CardStatus {
  if (checking) {
    return { text: t('ai.status.testing'), box: 'bg-warning/10 text-warning-strong', spoken: t('ai.status.testing'), hint: t('ai.status.testingHint') }
  }

  const check = profile.check
  if (!check) {
    return isProfileComplete(profile)
      ? { text: t('ai.status.untested'), box: NEUTRAL_BOX, spoken: t('ai.status.untested'), hint: t('ai.status.untestedHint') }
      : { text: t('ai.status.incomplete'), box: NEUTRAL_BOX, spoken: t('ai.status.incomplete'), hint: t('ai.status.incompleteHint') }
  }

  const fresh = isCheckFresh(check)
  // 迁移来的老结论没有时间戳，所以「什么时候」这句要么给准，要么明说不知道
  const when = (verdict: string): string =>
    check.at
      ? t('ai.status.whenKnown', { when: formatCheckedAt(check.at), verdict })
      : t('ai.status.whenUnknown', { verdict })
  const staleNote = fresh ? '' : t('ai.status.staleNote')

  if (!check.ok) {
    // 失败没有数字可显示，只能出词
    return {
      text: t('ai.status.unavailable'),
      box: fresh ? 'bg-destructive/10 text-destructive-strong' : NEUTRAL_BOX,
      spoken: t('ai.status.unavailable'),
      hint: [when(t('ai.status.verdictFail')), check.reason, staleNote].filter(Boolean).join(' · '),
    }
  }

  const ms = check.latencyMs
  if (ms === undefined) {
    // 迁移来的老结论可能只知道"通过"、没有耗时
    return {
      text: t('ai.status.available'),
      box: fresh ? 'bg-success/10 text-success-strong' : NEUTRAL_BOX,
      spoken: t('ai.status.available'),
      hint: [when(t('ai.status.verdictPass')), staleNote].filter(Boolean).join(' · '),
    }
  }

  const grade = gradeLatency(ms)
  const box = !fresh
    ? NEUTRAL_BOX
    : grade.tone === 'bad'
      ? 'bg-destructive/15 text-destructive-strong'
      : grade.tone === 'warn'
        ? 'bg-warning/10 text-warning-strong'
        : 'bg-success/10 text-success-strong'

  return {
    // 只放数字，档位靠颜色 + tooltip
    text: formatLatency(ms),
    box,
    spoken: t('ai.status.availableSpoken', { grade: grade.label, latency: formatLatency(ms) }),
    hint: [
      when(t('ai.status.verdictPass')),
      grade.label,
      grade.tier === 'tooSlow' ? t('ai.status.tooSlowNote') : '',
      staleNote,
    ].filter(Boolean).join(' · '),
  }
}


// ⓘ 里只放"选哪家"这一件事。"点一张即启用"写在卡头副标题上，不重复说；
// 卡上标签的含义由标签自己和它的 tooltip 承担。
const pickAdvice = () => t('ai.pickAdvice')

const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'
const selectClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-2 text-sm transition-colors focus:border-input-focus-border'
const linkClass = 'inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 decoration-primary/40 transition-colors hover:decoration-primary'
const cardIconButtonClass = 'pointer-events-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
const helpIconClass = 'h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground'

export default function AIProviderSection() {
  useT()
  const [profiles, setProfiles] = useState<AiProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [loaded, setLoaded] = useState(false)
  /** 弹窗里正在编辑的那份（新建也走这里）。null = 弹窗关着 */
  const [draft, setDraft] = useState<AiProfile | null>(null)
  const [draftIsNew, setDraftIsNew] = useState(false)
  /**
   * 弹窗里待保存的模型清单。
   *
   * 为什么是一个清单而不是一个字段：最常见的一次操作是"同一个供应商、同一个地址和密钥，
   * 想再挂两三个模型比一比"。此前那样一次只能填一个，剩下的得重开弹窗、重粘密钥。
   * 现在填几个就存几张卡，地址和密钥共用。
   */
  const [draftModels, setDraftModels] = useState<string[]>([])
  const [modelInput, setModelInput] = useState('')
  /** 打开弹窗时的快照，用来判断「未保存」 */
  const [draftBaseline, setDraftBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [checkingId, setCheckingId] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [serverAiSource, setServerAiSource] = useState<ServerAiSource>('managed')
  const [savingServerAiSource, setSavingServerAiSource] = useState(false)
  const [serverAiSourceError, setServerAiSourceError] = useState(false)
  /** 工作模式与来源都读回后才渲染那一段（见 useEffect 里的注释） */
  const [serverAiSourceLoaded, setServerAiSourceLoaded] = useState(false)
  const [isServerMode, setIsServerMode] = useState(false)
  const aiEnabled = useAiEnabled()
  /**
   * 下面这组服务此刻会不会被调用。不会的时候照样能编辑、测速（服务器模式下先调好再切过去是正常用法），
   * 但要让人一眼看出「选中的那张现在没在用」，否则打着勾的卡片会被当成正在整理文字的那个。
   * 来源没读回之前按「生效」画，免得本地/云模式的用户看见标记闪一下。
   */
  const servicesInactiveReason: 'aiOff' | 'serverManaged' | null = !aiEnabled
    ? 'aiOff'
    : serverAiSourceLoaded && isServerMode && serverAiSource === 'managed'
      ? 'serverManaged'
      : null
  /** 「测试全部」的进度；null = 没在批量测试 */
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  /** 批量测试是并发的，所以「正在测哪个」是一组而不是一个 */
  const [checkingIds, setCheckingIds] = useState<string[]>([])

  const draftProvider = findProvider(draft?.provider ?? '')
  const draftNeedsKey = !draftProvider.keyless
  const draftUrlError = draft ? checkApiUrl(draft.apiUrl) : ''
  const draftKeyHint = draft && draftNeedsKey ? checkAiKeyFormat(draft.provider, draft.apiKey) : ''
  const draftSignature = draft ? draftSnapshot(draft, draftModels) : ''
  // 输入框里打了字但没按回车也算改动——保存时会自动收编它，所以现在就得算"未保存"
  const draftDirty = draft !== null && (draftSignature !== draftBaseline || modelInput.trim() !== '')
  // 新建时密钥是自动带过来的（同供应商上一份），界面上要交代一句它从哪来。
  // 用"当前值是否还等于那份配置的密钥"来判断：用户一改成别的，这句提示自己就消失
  const draftKeyInherited = draft !== null
    && draftIsNew
    && draft.apiKey.trim() !== ''
    && lastProfileOf(draft.provider)?.apiKey === draft.apiKey
  const busy = saving || checkingId !== '' || batch !== null
  /** 这个卡正在测吗 —— 单个测试和并发批量测试都要算上 */
  const isChecking = (id: string) => checkingId === id || checkingIds.includes(id)
  const pendingDelete = profiles.find((p) => p.id === pendingDeleteId) ?? null

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const state = await loadAiProfiles()
      setProfiles(state.profiles)
      setActiveId(state.activeId)
      setLoaded(true)
    })()
    // 两个值一起等（Promise.all + 各自 catch 兜底），到齐后同一批渲染。
    // 分两次落值会出两种假象：默认是服务器模式，本地/云模式的用户会看见这一段先出现再消失；
    // 来源默认 managed，已保存 custom 的用户会看见开关自己滑一下（pitfalls #11）。
    // 只在值到齐后才首次渲染，两者都不存在，也就不需要 ready/animate 那套过渡开关。
    void Promise.all([
      getSetting('workMode', 'server').catch(() => 'server'),
      getSetting(SERVER_AI_SOURCE_KEY, 'managed').catch(() => 'managed'),
    ]).then(([mode, value]) => {
      if (cancelled) return
      const source = value === 'custom' ? 'custom' : 'managed'
      setServerAiSource(source)
      setRuntimeServerAiSource(source)
      setIsServerMode(mode === 'server')
      setServerAiSourceLoaded(true)
    })
    // 切走路由时复位「有未保存改动」，别把脏状态留给下一次进入
    return () => {
      cancelled = true
      setEngineDraftDirty(false)
    }
  }, [])

  useEffect(() => { setEngineDraftDirty(draftDirty) }, [draftDirty])

  async function handleServerAiSource(next: ServerAiSource) {
    if (savingServerAiSource || next === serverAiSource) return
    const previous = serverAiSource
    setServerAiSource(next)
    setRuntimeServerAiSource(next)
    setSavingServerAiSource(true)
    setServerAiSourceError(false)
    try {
      await setSetting(SERVER_AI_SOURCE_KEY, next)
    } catch {
      setServerAiSource(previous)
      setRuntimeServerAiSource(previous)
      setServerAiSourceError(true)
    } finally {
      setSavingServerAiSource(false)
    }
  }

  /** 唯一的写入点：列表 + 启用项一起落盘，并由 store 同步运行时那四个扁平键 */
  async function persist(nextProfiles: AiProfile[], nextActiveId: string) {
    const active = resolveActiveProfile(nextProfiles, nextActiveId)
    setProfiles(nextProfiles)
    setActiveId(active?.id ?? '')
    await saveAiProfiles({ profiles: nextProfiles, activeId: nextActiveId })
  }

  function openEditor(profile: AiProfile, isNew: boolean) {
    const models = profile.model.trim() ? [profile.model.trim()] : []
    setDraft(profile)
    setDraftIsNew(isNew)
    setDraftModels(models)
    setModelInput('')
    setDraftBaseline(draftSnapshot(profile, models))
    setNotice(null)
  }

  function closeEditor() {
    if (saving) return
    setDraft(null)
    setDraftIsNew(false)
    setDraftModels([])
    setModelInput('')
    setDraftBaseline('')
    setNotice(null)
    setEngineDraftDirty(false)
  }

  function addModel(name: string) {
    const value = name.trim()
    setModelInput('')
    setNotice(null)
    if (!value || draftModels.includes(value)) return
    setDraftModels([...draftModels, value])
  }

  function removeModel(name: string) {
    setDraftModels(draftModels.filter((m) => m !== name))
    setNotice(null)
  }

  function handleActivate(id: string) {
    if (id === activeId) return
    setNotice(null)
    void persist(profiles, id)
  }

  async function handleDelete(id: string) {
    const next = profiles.filter((p) => p.id !== id)
    setPendingDeleteId('')
    if (draft?.id === id) closeEditor()
    setNotice(null)
    // 删掉的正是启用项时，启用第一条；一条不剩就写空，下游自己跳过 AI 环节
    await persist(next, id === activeId ? '' : activeId)
  }

  /**
   * 换供应商时，地址与模型只在「还是上一家的样板值」时才跟着换。
   * 用户自己敲过的自定义端点或模型名不能被一次误点的下拉抹掉。
   */
  function handleDraftProvider(value: string) {
    if (!draft) return
    const from = findProvider(draft.provider)
    const to = findProvider(value)
    const previous = lastProfileOf(value)
    // 地址：自己敲过的自定义端点不能被一次误点的下拉抹掉，只有还是样板值时才跟着换；
    // 换到一个已经配过的供应商，就用那份配过的地址，而不是清单里的默认值
    const boilerplate = draft.apiUrl.trim() === '' || draft.apiUrl.trim() === from.defaultUrl
    const url = boilerplate ? previous?.apiUrl || to.defaultUrl : draft.apiUrl
    // 密钥跟着地址走：地址换到了别家，上一家的密钥一并换掉；用户自己粘的不动。
    // 规则和踩过的坑见 keyAfterProviderSwitch
    const apiKey = keyAfterProviderSwitch({
      key: draft.apiKey,
      fromProvider: draft.provider,
      fromUrl: draft.apiUrl,
      toUrl: url,
      toSavedKey: previous?.apiKey ?? '',
      profiles,
    })
    // 模型清单同理：还全是上一家的样板值时才换成新家的推荐，用户自己敲的一律留着
    const stillBoilerplate = draftModels.length === 0
      || draftModels.every((m) => from.defaultModels.includes(m))
    if (stillBoilerplate) {
      setDraftModels(to.defaultModels[0] ? [to.defaultModels[0]] : [])
    }
    setDraft({ ...draft, provider: value, apiUrl: url, apiKey, check: undefined })
    setNotice(null)
  }

  /** 改了任何一格，上一次的检测结论就不再描述这份配置了，一并作废（别让卡上留着旧的「可用」） */
  function patchDraft(patch: Partial<AiProfile>) {
    if (!draft) return
    setDraft({ ...draft, ...patch, check: undefined })
    setNotice(null)
  }

  /** 同供应商最近配过的那份（用来给新草稿带上地址和密钥） */
  function lastProfileOf(providerValue: string): AiProfile | undefined {
    return [...profiles].reverse().find((p) => p.provider === providerValue && p.apiUrl.trim() !== '')
  }

  /**
   * 新建草稿：供应商默认跟当前启用的那份一致，地址和密钥沿用同供应商已配过的最近一份。
   *
   * 这是「另存为新的一份」那个按钮的替代品——它想解决的是"同一个端点再加一个模型，
   * 不用重新粘一遍密钥"，但一个叫「另存为」的链接摆在模型输入框旁边，谁也看不出这层意思。
   * 换成默认值来做：新建时该带的东西自己就带上了，用户只需要改模型名。不需要多一个控件。
   */
  function makeDraft(providerValue?: string): AiProfile {
    const active = resolveActiveProfile(profiles, activeId)
    const target = providerValue ?? active?.provider ?? preferredAiProviderValue()
    const fresh = blankProfile(target)
    const previous = lastProfileOf(target)
    return previous
      ? { ...fresh, apiUrl: previous.apiUrl, apiKey: previous.apiKey }
      : fresh
  }

  async function runTest(profile: AiProfile): Promise<TestOutcome> {
    try {
      const result = await invoke<TestResult>('test_ai_connection', {
        config: {
          provider: profile.provider,
          api_url: profile.apiUrl,
          api_key: profile.apiKey,
          model: profile.model,
        },
      })
      if (result.ok) {
        return { ok: true, elapsedMs: result.elapsed_ms, reply: extractTestReply(result.detail), message: '' }
      }
      const friendly = describeProviderError(result.message)
      return { ok: false, elapsedMs: 0, reply: '', message: friendly.message, detail: friendly.detail }
    } catch (err) {
      const friendly = describeProviderError(err)
      return { ok: false, elapsedMs: 0, reply: '', message: friendly.message, detail: friendly.detail }
    }
  }

  /**
   * 保存（可选择顺手测一遍）。
   *
   * 两个按钮共用这一段：「保存」只落盘，「保存并测试」落盘后逐个真调一次。
   * 此前只有「保存并测试」一个入口——想改个地址、或者先把几个模型填上待会儿再测，
   * 都被强迫付一次（计费的）调用。
   *
   * 落盘一定在测试之前：测失败不该把用户刚粘进来的密钥弄丢。
   */
  async function handleSave(withTest: boolean) {
    if (!draft || busy) return

    // 输入框里打了字但没按回车，保存时自动收编——这是最容易发生的操作，别让它白费
    const models = modelInput.trim() && !draftModels.includes(modelInput.trim())
      ? [...draftModels, modelInput.trim()]
      : draftModels

    const base = {
      provider: draft.provider,
      apiUrl: draft.apiUrl.trim() || (draftProvider.urlOptional ? draftProvider.defaultUrl : ''),
      apiKey: draft.apiKey.trim(),
    }
    const urlError = checkApiUrl(base.apiUrl)
    if (urlError) {
      setNotice({ tone: 'warning', scope: 'editor', message: urlError })
      return
    }
    if (!base.apiUrl) {
      setNotice({
        tone: 'warning',
        scope: 'editor',
        message: draftNeedsKey ? t('ai.err.apiUrlEmpty') : t('ai.err.ollamaUrlEmpty'),
      })
      return
    }

    // 第一个模型沿用当前这份的 id（编辑就是改它），其余各自成为新的一张卡
    const targets: AiProfile[] = models.length === 0
      ? [{ ...draft, ...base, model: '' }]
      : models.map((model, index) => index === 0
        ? { ...draft, ...base, model }
        : { ...blankProfile(draft.provider), ...base, model })

    // 检测结论只在"这份配置一个字都没变"时才留着；改了任何一格，旧结论就不再描述它
    const withChecks = targets.map((target) => {
      const stored = profiles.find((p) => p.id === target.id)
      const unchanged = stored
        && stored.provider === target.provider
        && stored.apiUrl === target.apiUrl
        && stored.apiKey === target.apiKey
        && stored.model === target.model
      return { ...target, check: unchanged ? stored.check : undefined }
    })

    setSaving(true)
    setNotice(null)
    setModelInput('')
    setDraftModels(models)

    const existingIds = new Set(profiles.map((p) => p.id))
    let nextProfiles = profiles.map((p) => withChecks.find((t) => t.id === p.id) ?? p)
    nextProfiles = [...nextProfiles, ...withChecks.filter((t) => !existingIds.has(t.id))]
    // 新建的第一份保存后即启用（刚配完就是想用它）；编辑已有的不抢当前启用项
    const nextActiveId = draftIsNew ? withChecks[0].id : activeId

    try {
      await persist(nextProfiles, nextActiveId)
    } catch (err) {
      setNotice({ tone: 'error', scope: 'editor', message: t('ai.err.saveFailed'), detail: String(err) })
      setSaving(false)
      return
    }

    setDraft(withChecks[0])
    setDraftIsNew(false)
    setDraftBaseline(draftSnapshot(withChecks[0], models))

    const created = withChecks.length
    // 多个模型一次存完，弹窗就没有"正在编辑哪一份"了——关掉，结果落到网格下面
    const scope: Notice['scope'] = created > 1 ? 'list' : 'editor'
    const finish = (notice: Notice) => {
      if (created > 1) closeEditor()
      setNotice(notice)
      setSaving(false)
    }

    if (draftNeedsKey && !base.apiKey) {
      finish({ tone: 'warning', scope, message: t('ai.msg.savedNoKey', { count: created }) })
      return
    }
    if (models.length === 0) {
      finish({ tone: 'warning', scope: 'editor', message: t('ai.msg.savedNoModel') })
      return
    }
    if (!withTest) {
      finish({
        tone: 'success',
        scope,
        message: created > 1 ? t('ai.msg.savedCount', { count: created }) : t('ai.msg.savedOne'),
        detail: created > 1 ? withChecks.map((t) => t.model).join('\n') : undefined,
      })
      return
    }

    // 逐个测：结论一律写回（通不过也要写，卡上得显示「不可用」而不是停在「未测试」）
    const results: Array<{ profile: AiProfile; outcome: TestOutcome }> = []
    let working = nextProfiles
    for (const target of withChecks) {
      const outcome = await runTest(target)
      const tested = { ...target, check: outcomeToCheck(outcome) }
      working = working.map((p) => (p.id === tested.id ? tested : p))
      await persist(working, nextActiveId)
      if (tested.id === withChecks[0].id) {
        setDraft(tested)
        setDraftBaseline(draftSnapshot(tested, models))
      }
      results.push({ profile: tested, outcome })
    }

    if (results.length === 1) {
      const { profile, outcome } = results[0]
      finish(outcome.ok
        ? {
          tone: latencyTone(outcome.elapsedMs),
          scope: 'editor',
          message: t('ai.msg.savedAndTested', { result: successMessage(profile.model, outcome.elapsedMs) }),
          detail: successDetail(profile, outcome),
        }
        : {
          tone: 'error',
          scope: 'editor',
          message: t('ai.msg.savedButFailed', { message: outcome.message }),
          detail: outcome.detail,
        })
      return
    }

    const okCount = results.filter((r) => r.outcome.ok).length
    finish({
      tone: okCount === results.length ? 'success' : okCount === 0 ? 'error' : 'warning',
      scope,
      message: t('ai.msg.savedBatch', { total: results.length, ok: okCount, fail: results.length - okCount }),
      detail: results
        .map(({ profile, outcome }) => outcome.ok
          ? t('ai.msg.batchItemOk', { model: profile.model, latency: formatLatency(outcome.elapsedMs), grade: gradeLatency(outcome.elapsedMs).label })
          : t('ai.msg.batchItemFail', { model: profile.model, message: outcome.message }))
        .join('\n'),
    })
  }

  /**
   * 卡上的「测试」：拿这份配置真的发一句话过去，看拿不拿得到回复。
   *
   * 它回答的是"这条能不能用"（密钥对不对、模型开通了没、网络通不通），耗时是可用之后的
   * 第二个维度。原来这个按钮叫「测速」，把结论说成了一个速度数字——用户按下它时想问的
   * 其实是"这个模型好不好用"。
   */
  async function handleCheck(profile: AiProfile) {
    if (busy) return
    const scope: Notice['scope'] = draft ? 'editor' : 'list'
    if (!isProfileComplete(profile)) {
      setNotice({
        tone: 'warning',
        scope,
        message: t('ai.msg.incompleteCard', { title: profileTitle(profile) }),
      })
      return
    }

    setCheckingId(profile.id)
    setNotice(null)
    const outcome = await runTest(profile)
    await persist(
      profiles.map((p) => (p.id === profile.id ? { ...p, check: outcomeToCheck(outcome) } : p)),
      activeId,
    )
    if (outcome.ok) {
      setNotice({
        tone: latencyTone(outcome.elapsedMs),
        scope,
        message: successMessage(profile.model, outcome.elapsedMs),
        detail: successDetail(profile, outcome),
      })
    } else {
      setNotice({
        tone: 'error',
        scope,
        message: t('ai.msg.modelFailed', { model: profile.model, message: outcome.message }),
        detail: outcome.detail,
      })
    }
    setCheckingId('')
  }

  /**
   * 一键测试全部：**并发**真发一句话过去，一次点击直接开始（没有二次确认）。
   *
   * ⚠️ 并发的代价，改回串行前先想清楚：卡上的耗时是用来横向比较「哪个更快」的，
   * 并发跑出来的数字互相污染 —— 同一个地址和密钥下挂着好几个模型时尤其明显，
   * 还可能撞上限流被记成「不可用」。所以批量结果里会注明这批耗时不宜横向比较；
   * 要拿准数字，用卡上的单张测试。
   *
   * 另外两个决定：
   *  · **一次性落盘**，不逐张写。并发下每个回调拿到的都是同一份旧 profiles，
   *    逐张 persist 会互相覆盖，只剩最后一个的结论。
   *  · **跳过没填完的**，不给它们写「不可用」——它们缺的是配置而不是可用性，
   *    写进结论只会污染卡片状态；跳过几个会在结果里说明。
   */
  async function handleCheckAll() {
    if (busy) return
    const targets = profiles.filter(isProfileComplete)
    const skipped = profiles.length - targets.length
    if (targets.length === 0) {
      setNotice({
        tone: 'warning',
        scope: 'list',
        message: t('ai.msg.nothingToTest'),
      })
      return
    }

    setNotice(null)
    setBatch({ done: 0, total: targets.length })
    setCheckingIds(targets.map((p) => p.id))

    let done = 0
    const results = await Promise.all(targets.map(async (target) => {
      const outcome = await runTest(target)
      // 每个自己测完就把图标停下、进度加一，不用等整批结束
      done += 1
      setBatch({ done, total: targets.length })
      setCheckingIds((prev) => prev.filter((id) => id !== target.id))
      return { target, outcome }
    }))

    const checks = new Map(results.map((r) => [r.target.id, outcomeToCheck(r.outcome)]))
    await persist(
      profiles.map((p) => {
        const check = checks.get(p.id)
        return check ? { ...p, check } : p
      }),
      activeId,
    )
    setCheckingIds([])
    setBatch(null)

    let okCount = 0
    let failCount = 0
    const lines = results.map(({ target, outcome }) => {
      if (outcome.ok) {
        okCount += 1
        return t('ai.msg.batchLineOk', { model: target.model, latency: formatLatency(outcome.elapsedMs) })
      }
      failCount += 1
      return t('ai.msg.batchLineFail', { model: target.model, message: outcome.message })
    })

    const parts = [t('ai.msg.batchOk', { count: okCount })]
    if (failCount > 0) parts.push(t('ai.msg.batchFail', { count: failCount }))
    if (skipped > 0) parts.push(t('ai.msg.batchSkipped', { count: skipped }))
    if (targets.length > 1) {
      lines.push('', t('ai.msg.batchNote'))
    }
    setNotice({
      tone: failCount > 0 ? 'warning' : 'success',
      scope: 'list',
      message: t('ai.msg.batchDone', { parts: parts.join(t('asr.listSeparator')) }),
      detail: lines.join('\n'),
    })
  }

  /**
   * 一张卡就两行，约 70px：
   *   第一行  ✓ 模型名 ……… 状态标签（可用 1.2s / 不可用 / 未测试）
   *   第二行  供应商 · 主机名 ……… 测试 / 编辑 / 删除（划过才显形）
   *
   * 两个颜色的分工是刻意的，也是上一版最误导的地方：
   *   - 对勾是**主题色**，只表示"这份正在被使用"（和工作模式卡一致）；
   *   - **绿色只属于状态标签**，只有真的测通过才会出现。
   * 上一版把对勾涂成绿的，等于一选中就宣布"能用"——而它可能密钥都没填对。
   */
  function renderCard(profile: AiProfile) {
    const isActive = profile.id === activeId
    const checking = isChecking(profile.id)
    const status = describeStatus(profile, checking)

    return (
      <div
        key={profile.id}
        className={cn(
          'group relative rounded-lg border p-2.5 transition-colors',
          isActive ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
        )}
      >
        {/* 铺满整卡的单选按钮：卡上还有自己的图标按钮，所以不能把整张卡做成 <button>
            （按钮套按钮，读屏和键盘都会错）。文字是静态的，点哪儿都落到这个按钮上。 */}
        <button
          type="button"
          role="radio"
          aria-checked={isActive}
          aria-label={t('common.cardStatusAria', {
            title: profileTitle(profile),
            subtitle: profileSubtitle(profile),
            status: status.spoken,
          })}
          onClick={() => handleActivate(profile.id)}
          className="absolute inset-0 rounded-lg"
        />

        <div className="flex items-center gap-1.5">
          {/* 「使用中」用实心绿勾，和诊断页表示"正常"的 CheckCircle2 是同一个图标。
              它和右边的状态标签分工不同：勾说的是"这份在被用"，标签说的是"上次测得如何"，
              所以勾旁边挂一个 tooltip 明说，避免又被读成"能用" */}
          {isActive && (
            <Tooltip className="pointer-events-auto relative z-10 shrink-0" content={t('common.inUse')}>
              <CheckCircle2 className="h-4 w-4 shrink-0 cursor-help text-success-strong" aria-label={t('common.inUse')} />
            </Tooltip>
          )}
          {/* 字号压到 12px：模型名动辄 20 多个字符（doubao-seed-2-0-lite-260215），
              三列排布下 14px 装不住 */}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={profileTitle(profile)}>
            {profileTitle(profile)}
          </span>
          {renderStatusChip(status)}
        </div>

        <div className="mt-1 flex items-center gap-1.5">
          {/* 供应商 · 主机名合成一行；主机名只在不是该供应商默认地址时才出现
              （两张都叫「OpenAI 兼容」的卡靠它区分）。完整地址悬停可见，也在编辑弹窗里 */}
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
            title={profile.apiUrl}
          >
            {profileSubtitle(profile)}
          </span>
          <div className="pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {/* 图标 tooltip 一律是"这个按钮叫什么"，两三个字（对齐诊断页的「刷新状态」等）。
                「会真实调用一次、按供应商计费」这种前提不属于 tooltip：它太长，
                而且用户按下按钮的那一刻已经知道自己在测一个云服务了 */}
            <Tooltip className="pointer-events-auto" content={t('common.test')}>
              <button
                type="button"
                onClick={() => void handleCheck(profile)}
                disabled={busy}
                aria-label={t('ai.testAria', { title: profileTitle(profile) })}
                className={cardIconButtonClass}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content={t('common.edit')}>
              <button
                type="button"
                onClick={() => openEditor({ ...profile }, false)}
                aria-label={t('ai.editAria', { title: profileTitle(profile) })}
                className={cardIconButtonClass}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content={t('common.delete')}>
              <button
                type="button"
                onClick={() => setPendingDeleteId(profile.id)}
                aria-label={t('ai.deleteAria', { title: profileTitle(profile) })}
                className={cardIconButtonClass}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Card>
      <CardContent className="p-6">
        {/* 只在服务器模式出现：本地/云 API 模式下 AI 整理本来就走下面选中的服务，没有第二个
            选项可选，摆一个恒定生效的开关只会让人以为它还管着别的事。
            形态用设置页里那 8 处同构的开关行 —— 分段控件在本应用表示页面/短枚举切换，
            而两个短选项撑成等宽卡会留一大片空白，还会和下方真正的服务卡争层级。
            说明文字跟着开关状态走，直接说“当前由谁整理”，比让用户从「关」反推更省事。 */}
        {serverAiSourceLoaded && isServerMode && (
          <section className="mb-4 border-b border-border pb-4" aria-labelledby="server-ai-source-heading">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {/* 字号与图标间距都对齐下面的「AI 服务」标题：两者是同一层级的两块内容，
                      标题小一号会让它看着像附属于下面那块 */}
                  <h2 id="server-ai-source-heading" className="text-lg font-semibold">
                    {t('ai.serverSource.title')}
                  </h2>
                  <Tooltip variant="light" content={t('ai.serverSource.help')}>
                    <Info
                      aria-label={t('settings.helpAria', { label: t('ai.serverSource.title') })}
                      className={helpIconClass}
                    />
                  </Tooltip>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(serverAiSource === 'custom' ? 'ai.serverSource.descCustom' : 'ai.serverSource.descManaged')}
                </p>
              </div>
              <Switch
                checked={serverAiSource === 'custom'}
                onChange={() => void handleServerAiSource(serverAiSource === 'custom' ? 'managed' : 'custom')}
                labelledBy="server-ai-source-heading"
                disabled={savingServerAiSource}
              />
            </div>

            {serverAiSourceError && (
              <Feedback className="mt-2" tone="error" message={t('ai.err.saveFailed')} />
            )}
          </section>
        )}

        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-[18rem]">
            <div className="flex items-center gap-2">
              <h2 id="ai-service-heading" className="text-lg font-semibold">{t('ai.title')}</h2>
              <Tooltip variant="light" content={pickAdvice()}>
                <Info aria-label={t('ai.helpAria')} className={helpIconClass} />
              </Tooltip>
              {servicesInactiveReason && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {t('ai.inactiveBadge')}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {servicesInactiveReason === 'aiOff'
                ? t('ai.inactiveAiOff')
                : servicesInactiveReason === 'serverManaged'
                  ? t('ai.inactiveServerManaged')
                  : t('ai.desc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* 并发跑，所以没有「停止」：invoke 发出去的请求没法撤回，
                摆一颗停不掉任何东西的按钮比没有更糟。整批只等最慢那个，很快。 */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => void handleCheckAll()}
              disabled={busy || profiles.length === 0}
            >
              <RefreshCw className={cn('mr-1 h-3.5 w-3.5', batch && 'animate-spin')} aria-hidden />
              {batch ? t('ai.testingBatch', { done: batch.done, total: batch.total }) : t('ai.testAll')}
            </Button>
            {/* 「新建」回到卡头右上角（和「润色模式」页同一个位置）。
                它开的是弹窗，所以不会再出现"点了按钮、变化发生在屏幕外"的问题 */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => openEditor(makeDraft(), true)}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('common.new')}
            </Button>
          </div>
        </div>

        {/* 自定义服务始终可编辑和测试；服务器模式是否实际使用由上方来源选择决定。 */}
        <fieldset className="min-w-0">
          {!loaded ? (
            <p className="py-2 text-sm text-muted-foreground">{t('ai.loading')}</p>
          ) : profiles.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
              {t('ai.empty')}
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-labelledby="ai-service-heading"
              // 未生效时整组调淡；鼠标移上去或键盘聚焦时恢复，表示仍然可以编辑和测试
              className={cn(
                'grid gap-2.5 sm:grid-cols-3',
                servicesInactiveReason && 'opacity-60 transition-opacity focus-within:opacity-100 hover:opacity-100',
              )}
            >
              {profiles.map(renderCard)}
            </div>
          )}

          {/* 卡上动作（测速）的结果没有弹窗可归，落在网格下方 */}
          {notice?.scope === 'list' && (
            <Feedback className="mt-3" tone={notice.tone} message={notice.message} detail={notice.detail} />
          )}
        </fieldset>
      </CardContent>

      {draft && (
        <Modal
          title={draftIsNew ? t('ai.editorNew') : t('ai.editorEdit')}
          onClose={closeEditor}
          locked={saving}
          showCloseButton
          panelClassName="w-[520px]"
        >
          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="ai-provider" className="mb-1 block text-sm text-muted-foreground">{t('ai.provider')}</label>
              <select
                id="ai-provider"
                value={draft.provider}
                onChange={(e) => handleDraftProvider(e.target.value)}
                className={selectClass}
              >
                {aiProvidersForDisplay().map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="ai-api-url" className="mb-1 block text-sm text-muted-foreground">
                {draftProvider.urlOptional ? t('ai.apiUrlOptional') : draftProvider.keyless ? t('ai.ollamaUrl') : t('ai.apiUrl')}
              </label>
              <input
                id="ai-api-url"
                type="url"
                inputMode="url"
                value={draft.apiUrl}
                onChange={(e) => patchDraft({ apiUrl: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(true) }}
                placeholder={draftProvider.defaultUrl}
                aria-describedby={draftProvider.urlOptional ? 'ai-api-url-hint' : undefined}
                className={inputClass}
              />
              {draftProvider.urlOptional && (
                <p id="ai-api-url-hint" className="mt-1 text-xs text-muted-foreground">{t('ai.apiUrlOptionalHint')}</p>
              )}
              {draftUrlError && <FormatHint text={draftUrlError} />}
            </div>

            {draftNeedsKey && (
              // data-modal-autofocus：弹窗打开时焦点落在密钥上（这才是要干的事），
              // 而不是第一个可聚焦元素——那是右上角的关闭按钮
              <div data-modal-autofocus>
                <label htmlFor="ai-api-key" className="mb-1 block text-sm text-muted-foreground">API Key</label>
                <PasswordInput
                  id="ai-api-key"
                  label="API Key"
                  value={draft.apiKey}
                  onChange={(v) => patchDraft({ apiKey: v })}
                  onSubmit={() => void handleSave(true)}
                  placeholder={t('ai.keyPlaceholder')}
                  className={inputClass}
                />
                {!notice && draftKeyHint && <FormatHint text={draftKeyHint} />}
                {/* 密钥不是凭空出现的：说一句它从哪来，免得用户以为自己看错了 */}
                {draftKeyInherited && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t('ai.keyReused', { provider: draftProvider.label })}
                  </p>
                )}
                {/* 密钥入口放在密钥这一格里。
                    这里原来还有一个「怎么申请密钥？看配置文档」的链接，去掉了：AI 服务
                    要做的只有「去控制台复制一把 Key」，上面那个控制台链接就是最短路径，
                    再挂一篇文档反而暗示这件事很复杂。
                    （语音识别那边保留了，但只对豆包显示 —— 只有它要在新旧两代控制台之间选。）*/}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {draftProvider.consoleUrl && (
                    <button
                      type="button"
                      onClick={() => void shellOpen(draftProvider.consoleUrl as string)}
                      className={linkClass}
                    >
                      {t('ai.openConsole', { provider: draftProvider.label })}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="ai-model" className="mb-1 block text-sm text-muted-foreground">{t('ai.model')}</label>
              {/* 原来这里是 <input list=...>：Chromium 会画一个下拉箭头，但它其实是个自由文本框，
                  "又是下拉又要我填"两头都不像。现在拆开——输入框只管输入，推荐名做成可点的小按钮 */}
              <div className="flex items-center gap-2">
                <input
                  id="ai-model"
                  value={modelInput}
                  onChange={(e) => { setModelInput(e.target.value); setNotice(null) }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    addModel(modelInput)
                  }}
                  placeholder={draftProvider.defaultModels[0] ?? t('ai.modelPlaceholder')}
                  className={cn(inputClass, 'flex-1')}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => addModel(modelInput)}
                  disabled={!modelInput.trim()}
                >
                  {t('ai.addAnother')}
                </Button>
              </div>

              {draftModels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {draftModels.map((model) => (
                    <span
                      key={model}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/50 py-0.5 pl-2 pr-1 text-xs"
                    >
                      {model}
                      <button
                        type="button"
                        onClick={() => removeModel(model)}
                        aria-label={t('ai.removeModel', { model })}
                        className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive-strong"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* 这里原来还有一排「推荐模型」小按钮，去掉了：新建时该供应商的推荐模型
                  已经预先躺在上面的清单里，输入框的 placeholder 也写着它，
                  再摆一排按钮是把同一件事说第三遍。 */}
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {t('ai.multiModelHint')}
              </p>
            </div>

            {notice?.scope === 'editor' && (
              <Feedback tone={notice.tone} message={notice.message} detail={notice.detail} />
            )}

            {/* 只留一个主按钮。关闭走右上角那个叉（Esc、点背板也行），
                不用再摆一个和它同义的「取消」 */}
            {/* 两个入口：「保存」只落盘，「保存并测试」额外真调一次。
                此前只有后者——想改个地址、或者先把几个模型填上待会儿再测，
                都被强迫付一次计费调用。关闭走右上角那个叉（Esc、点背板也行）。 */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => void handleSave(false)}
                disabled={busy}
              >
                {t('common.save')}
              </Button>
              <Button size="sm" className="h-9" onClick={() => void handleSave(true)} disabled={busy}>
                {saving ? t('common.processing') : draftModels.length > 1 ? t('ai.saveAndTestCount', { count: draftModels.length }) : t('ai.saveAndTest')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <Modal title={t('ai.deleteTitle')} onClose={() => setPendingDeleteId('')} panelClassName="w-[420px]">
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {profileTitle(pendingDelete)} ({profileSubtitle(pendingDelete)}). {t('ai.deleteBody')}
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" className="h-9" onClick={() => setPendingDeleteId('')}>
              {t('common.cancel')}
            </Button>
            <button
              type="button"
              onClick={() => void handleDelete(pendingDelete.id)}
              className="h-9 rounded-md border border-destructive/30 bg-destructive/5 px-3 text-sm font-medium text-destructive-strong transition-colors hover:bg-destructive/10"
            >
              {t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  )
}
