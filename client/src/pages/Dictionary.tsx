import { Fragment, useEffect, useState } from 'react'
import { Plus, X, Search, RotateCcw, ChevronDown, ChevronUp, FolderPlus, Trash2, Download, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import {
  ASR_PLATFORMS,
  ASR_PROVIDERS,
  asrModelsOf,
  type AsrPlatform,
} from '@/features/settings/asrProviderCatalog'
import {
  expectedClientCap,
  expectedHotwordDelivery,
  foldHotwordDelivery,
  hotwordDependsOnStreamingPath,
  hotwordUndecidedReason,
  type HotwordUiState,
  type HotwordUndecidedReason,
} from '@/lib/asrModels'
import { cn } from '@/lib/utils'
import * as bridge from '@/services/bridge'
import { exportHotwords } from '@/services/exports'
import { getSetting } from '@/services/store'
import { BUILTIN_SETS, MAX_HOTWORDS } from '@/services/hotwords/model'
import { builtinInputKey, useHotwordsManager } from '@/services/hotwords/useHotwordsManager'
import TextReplacementSection from '@/components/TextReplacementSection'
import TextFormatSection from '@/components/TextFormatSection'
import { useSortable, DragHandle } from '@/components/ui/sortable'
import { t, type TranslationKey } from '@/i18n'
import { RichText } from '@/i18n/RichText'
import { useT } from '@/i18n/useT'

type Tab = 'hotwords' | 'replacement'

/** 超过该数量的热词总数时，给出"过多可能反而降低准确率"的软提示 */
const HOTWORD_SOFT_LIMIT = 200
/** 单个分类内词条超过该数量时折叠，只显示前 N 个 + 展开按钮，避免一大片平铺 */
const CHIPS_COLLAPSE_LIMIT = 30

/** 词条标签列表：数量多时折叠（搜索中不折叠，避免藏起匹配项）。 */
function WordChips({
  words,
  onRemove,
  expandAll = false,
}: {
  words: string[]
  onRemove: (word: string) => void
  expandAll?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const overflow = words.length > CHIPS_COLLAPSE_LIMIT
  const shown = expanded || expandAll || !overflow ? words : words.slice(0, CHIPS_COLLAPSE_LIMIT)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((word) => (
          <span
            key={word}
            className="inline-flex items-center gap-1 rounded-md border bg-secondary/50 px-2 py-0.5 text-xs"
          >
            {word}
            <button
              onClick={() => onRemove(word)}
              className="rounded-full p-0.5 transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label={t('dict.deleteWord', { word })}
            >
              <X className="h-2.5 w-2.5 text-muted-foreground" />
            </button>
          </span>
        ))}
      </div>
      {overflow && !expandAll && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? t('dict.collapse') : t('dict.expandAll', { count: words.length })}
        </button>
      )}
    </div>
  )
}

/**
 * 那句话该说哪一条。
 *
 * 「未确定」有三种成因，**展示状态可以共用，说明不能共用**。原来三种都套同一句
 * 「等第一次识别或测试连接之后才能确定」，而那句只对「auto 协议还没探测」成立：
 * 声明缺失是 SayIt 的 bug，查询失败是命令没调通，这两种再录一百次也不会变 ——
 * 让用户反复口述去等一个永远不来的结果，是把可指认的故障说成正常等待。
 */
function deliveryMessageKey(
  ui: HotwordUiState,
  reason: HotwordUndecidedReason | null,
): TranslationKey {
  if (ui === 'sent') return 'dict.delivery.sent'
  if (ui === 'not_sent') return 'dict.delivery.notSent'
  switch (reason) {
    // Rust 返回 unknown_provider：我们漏了声明，不是用户配置的问题
    case 'declaration_missing': return 'dict.delivery.undecidedDeclaration'
    // 命令没调通（旧版本二进制没有这个 command、IPC 异常）
    case 'query_failed': return 'dict.delivery.undecidedQueryFailed'
    // auto 协议尚未探测 —— 只有这一种能靠"再用一次"解决
    default: return 'dict.delivery.undecided'
  }
}

/**
 * 当前这套配置拿热词做什么。
 *
 * 为什么不是一张「各模型对热词的支持」表：那张表（0.1.1 加的）硬编码 7 行、永远显示
 * 同一份内容，漏了 Groq / OpenAI / OpenAI 兼容 / OpenRouter / MiMo / Gemini 六家，
 * 还把「不支持」限定成本地模型的问题 —— 于是用 FunASR 的人看到的是一张"云端全是支持"
 * 的表，而他的热词一条都没进请求（issue #67）。
 *
 * 判据全部来自运行时：工作模式 + 当前 provider + 实时字幕开关，云端那档直接问 Rust
 * （providers/capabilities.rs 是唯一声明处）。前端不再自己存一份清单。
 */
function HotwordDeliveryNotice({ hotwordCount }: { hotwordCount: number }) {
  const [tableOpen, setTableOpen] = useState(false)
  const [state, setState] = useState<{
    ui: HotwordUiState
    /** 走流式还是回落会改变结论 —— 为真时要说明"取决于实时字幕这次能不能连上" */
    pathDependent: boolean
    /** SayIt 自设的发送条数上限，null = 不截断 */
    clientCap: number | null
    /** 云端模式才有转写后的空格还原 */
    hasSpacingRestore: boolean
    /** ui 为 'undecided' 时，究竟卡在哪一种未确定上（三种的处置办法完全不同） */
    undecidedReason: HotwordUndecidedReason | null
  } | null>(null)

  useEffect(() => {
    let disposed = false

    const load = async () => {
      const mode = await getSetting('workMode', 'server') as string

      // 本地引擎：一条都不传。models/ 下没有任何热词通道 —— local_transcribe 的参数
      // 里没有热词那一项（只有音频、模型、语种和计算设备那几个），GGML 迁移时按
      // dev-docs 的 D3 放弃了热词（旧的 sherpa-onnx 时代确实写进 recognizer 配置，
      // 那个实现已经不在了）。
      if (mode === 'local') {
        if (!disposed) {
          setState({
            ui: 'not_sent',
            pathDependent: false,
            clientCap: null,
            hasSpacingRestore: false,
            undecidedReason: null,
          })
        }
        return
      }
      // 服务器模式：热词随 start 消息发给服务端（ServerProvider 的 start payload）。
      if (mode === 'server') {
        if (!disposed) {
          setState({
            ui: 'sent',
            pathDependent: false,
            clientCap: null,
            hasSpacingRestore: false,
            undecidedReason: null,
          })
        }
        return
      }

      const [provider, protocol, workspaceId, streamingOn] = await Promise.all([
        getSetting('cloudAsr.provider', '') as Promise<string>,
        getSetting('cloudAsr.protocol', 'auto') as Promise<string>,
        getSetting('cloudAsr.qwen.workspaceId', '') as Promise<string>,
        getSetting('streamingDisplayEnabled', false) as Promise<boolean>,
      ])
      // baseUrl + model 要一起给：auto 协议的探测结果按「地址 + 模型」缓存，
      // 少给一个就查不到那条缓存，会把已经探明的配置显示成"未确定"。
      const [baseUrl, model] = await Promise.all([
        getSetting('cloudAsr.baseUrl', '') as Promise<string>,
        getSetting('cloudAsr.model', '') as Promise<string>,
      ])
      const capability = await bridge.asrHotwordCapability(provider, {
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(protocol && protocol !== 'auto' ? { protocol } : {}),
      })
      if (disposed) return
      if (!capability) {
        // 查不到（老版本 Rust、IPC 失败）不能编一个答案，显示"未确定"。
        setState({
          ui: 'undecided',
          pathDependent: false,
          clientCap: null,
          hasSpacingRestore: true,
          // 和"协议还没探测"共用展示状态，但原因必须留住：那句"第一次识别之后就能
          // 确定"对这一种不成立 —— 命令根本没调通，再录一百次也不会变。
          undecidedReason: 'query_failed',
        })
        return
      }
      const pathOpts = {
        streamingDisplayEnabled: Boolean(streamingOn),
        provider,
        qwenWorkspaceId: workspaceId,
      }
      const delivery = expectedHotwordDelivery(capability, pathOpts)
      setState({
        ui: foldHotwordDelivery(delivery),
        pathDependent: hotwordDependsOnStreamingPath(capability),
        // 取**这条路径**上的上限，不是这家的概括。两者的区别在 OpenAI live 上会显形：
        // 关掉实时字幕走文件端点，热词一条都不发，这时报上限就是在自相矛盾。
        clientCap: expectedClientCap(capability, pathOpts),
        hasSpacingRestore: true,
        undecidedReason: hotwordUndecidedReason(delivery),
      })
    }

    void load()
    // 「OpenAI 兼容」的 auto 协议要到第一次转写才探测出来（探测发生在 cloud_transcribe
    // 内部）。不重查的话，热词页一直开着的用户会永远看到"还没探测出来"——
    // 而答案在他第一次口述之后就已经有了。
    const onCapabilityMaybeChanged = () => { void load() }
    window.addEventListener(bridge.ASR_CAPABILITY_MAYBE_CHANGED_EVENT, onCapabilityMaybeChanged)
    return () => {
      disposed = true
      window.removeEventListener(bridge.ASR_CAPABILITY_MAYBE_CHANGED_EVENT, onCapabilityMaybeChanged)
    }
  }, [])

  if (!state) return null

  const tone = state.ui === 'sent'
    ? 'text-muted-foreground'
    : state.ui === 'undecided'
      ? 'text-muted-foreground'
      : 'text-amber-500'

  return (
    <div className={cn('mb-4 -mt-1 space-y-1 text-xs leading-relaxed', tone)}>
      {/* 完整对照的入口跟在结论后面，同一行 —— 用户读完"当前这套会不会发送"，
          紧接着最想问的就是"那别的呢"。
          原来这里写的是"完整对照见文档《SayIt 语音识别配置》"，那句话没有落点：
          文档在仓库里，用户在应用内点不到，等于把他推去一个不存在的地方。
          现在改成应用内打开，表格现问 Rust 现渲染（见 HotwordSupportTable）。 */}
      <p>
        <RichText text={t(deliveryMessageKey(state.ui, state.undecidedReason))} />
        <button
          type="button"
          onClick={() => setTableOpen(true)}
          className="ml-1.5 text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
        >
          {t('dict.delivery.openTable')}
        </button>
      </p>
      {/* 回落会翻转结论的那两家（OpenAI live / Gemini live）必须说明，否则用户看到的
          结论会在建连失败那一次悄悄失效，而他不会知道。 */}
      {state.pathDependent && (
        <p><RichText text={t('dict.delivery.pathDependent')} /></p>
      )}
      {/* 客户端截断：说清是 SayIt 发送时的上限，不是服务端限制。
          clientCap 已经是**当前路径**上那份（见 expectedClientCap）—— 按 provider 取
          一个数会让 OpenAI live 关掉字幕时同时显示"不发送"和"最多发 100 个"。 */}
      {state.clientCap !== null && hotwordCount > state.clientCap && (
        <p className="text-amber-500">
          <RichText text={t('dict.delivery.clientCap', { cap: state.clientCap, count: hotwordCount })} />
        </p>
      )}
      {/* 不进 ASR 时给替代路径，但必须说清它要两个开关都开着 —— 「热词注入提示词」
          默认关闭，且依赖 AI 整理（AI 整理本身还可能因短录音跳过或调用失败）。
          不能让用户以为有自动兜底。 */}
      {state.ui === 'not_sent' && (
        <p><RichText text={t('dict.delivery.fallbackHint')} /></p>
      )}
      {/* 云端这条路热词还有一个无条件用途：转写完成后还原被拆开的写法
          （restoreHotwordSpacing，把 "Say It" 还原成 "SayIt"）。不说的话，
          「不进 ASR」会被读成「热词完全没用」。 */}
      {state.hasSpacingRestore && state.ui !== 'sent' && (
        <p className="text-muted-foreground"><RichText text={t('dict.delivery.spacingRestore')} /></p>
      )}
      {tableOpen && <HotwordSupportTable onClose={() => setTableOpen(false)} />}
    </div>
  )
}

/** 对照表里一行的展示状态。 */
interface SupportRow {
  /**
   * 平台 id，用于分组小标题。
   *
   * 存 id 而不是存 `entry.label` 的结果：那个 label 是个 getter（`t()` 调用），
   * 把它的返回值抓进 state 就把加载那一刻的语言固化了 —— 弹窗开着时切换语言，
   * 分组标题会留在旧语言上。渲染时再取，语言就永远是当前的。
   * 同一个坑在 `asrProviderCatalog.ts` 的 `AsrProvider.label` 上有注释。
   */
  platform: AsrPlatform
  /** 模型显示名（就是模型 id，和服务商文档、账单上的写法一致） */
  model: string
  /** 运行时 provider，用于和当前配置比对、以及取能力 */
  provider: string
  /** 这家有没有流式实现 */
  hasStreamingPath: boolean
  /** 开着实时字幕那条路的结论 */
  streaming: HotwordUiState
  /** 关掉实时字幕（或建连失败回落）那条路的结论 */
  buffered: HotwordUiState
  /** 两条路径各自的发送上限 */
  streamingCap: number | null
  bufferedCap: number | null
}

/**
 * 「各服务对热词的支持」完整对照表。
 *
 * ## 为什么这张表是生成的
 *
 * 它替代的是热词页 ⓘ 里那张**硬编码 7 行**的表（0.1.1 加的）：漏了 Groq、OpenAI、
 * OpenAI 兼容、OpenRouter、MiMo、Gemini 六家，而且不看用户选的是谁、永远显示同一份
 * 内容。issue #67 就撞在这上面 —— 用 FunASR 的人读到的是"云端全是支持"，而他的热词
 * 一条都没进请求。
 *
 * 所以问题不在"表格放界面里"，在**手写**：没有任何机制让它跟着实现走。这一版的行
 * 全部来自 Rust 的 `asr_hotword_capability_matrix`（唯一声明处的投影），前端只负责
 * 把 provider key 翻成用户看得懂的名字并排版。改了实现而表格没跟上，在结构上不可能。
 *
 * 显示顺序沿用服务目录（`ASR_PROVIDERS`）—— 那里的顺序是推荐顺序，且已按平台分组。
 */
function HotwordSupportTable({ onClose }: { onClose: () => void }) {
  // 语言切换要重渲染：表里的平台名、状态词、说明全走 t()。
  useT()
  const [rows, setRows] = useState<SupportRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [currentProvider, setCurrentProvider] = useState('')

  useEffect(() => {
    let disposed = false
    void (async () => {
      const [matrix, provider, mode] = await Promise.all([
        bridge.asrHotwordCapabilityMatrix(),
        getSetting('cloudAsr.provider', '') as Promise<string>,
        getSetting('workMode', 'server') as Promise<string>,
      ])
      if (disposed) return
      if (!matrix) {
        // 取不到就说取不到。**不要退化成一张空表** —— 空表看着像"所有服务都不支持"。
        setFailed(true)
        return
      }
      setCurrentProvider(mode === 'cloud_api' ? provider : '')
      setRows(ASR_PROVIDERS.flatMap((entry) => asrModelsOf(entry).map((model) => {
        const capability = matrix[model.provider]
        // 目录里有、Rust 矩阵里没有：那是漏声明，按"未确定"显示而不是"不支持"。
        // 前端测试会在这种情况下先红（遍历目录断言每个 provider 都有声明）。
        const streaming = capability ? foldHotwordDelivery(capability.streaming) : 'undecided'
        const buffered = capability ? foldHotwordDelivery(capability.buffered) : 'undecided'
        return {
          platform: entry.platform,
          model: model.id,
          provider: model.provider,
          hasStreamingPath: capability?.hasStreamingPath ?? false,
          streaming,
          buffered,
          streamingCap: capability?.streamingClientCap ?? null,
          bufferedCap: capability?.bufferedClientCap ?? null,
        }
      })))
    })()
    return () => { disposed = true }
  }, [])

  const label = (state: HotwordUiState) => t(
    state === 'sent' ? 'dict.table.sent'
      : state === 'not_sent' ? 'dict.table.notSent'
        : 'dict.table.undecided',
  )
  const stateClass = (state: HotwordUiState) => state === 'sent'
    ? 'text-foreground'
    : state === 'not_sent' ? 'text-amber-500' : 'text-muted-foreground'

  /** 这一行的「热词」列怎么写：两条路径结论不同的那几家必须分开说。 */
  const renderState = (row: SupportRow) => {
    if (!row.hasStreamingPath || row.streaming === row.buffered) {
      return <span className={stateClass(row.buffered)}>{label(row.buffered)}</span>
    }
    // 这是 OpenAI live / Gemini live 那两家：开字幕与关字幕的答案相反。
    // 一栏里写一个词会必错一半，所以两行分开列。
    return (
      <span className="flex flex-col gap-0.5">
        <span className={stateClass(row.streaming)}>
          {t('dict.table.whenStreaming', { state: label(row.streaming) })}
        </span>
        <span className={stateClass(row.buffered)}>
          {t('dict.table.whenBuffered', { state: label(row.buffered) })}
        </span>
      </span>
    )
  }

  /** 说明列：只放对这一行成立的话（上限是 SayIt 的发送上限，不是服务端限制）。 */
  const renderNote = (row: SupportRow) => {
    const caps = new Set<number>()
    if (row.streaming === 'sent' && row.streamingCap !== null) caps.add(row.streamingCap)
    if (row.buffered === 'sent' && row.bufferedCap !== null) caps.add(row.bufferedCap)
    if (caps.size === 0) return null
    return t('dict.table.capNote', { cap: Array.from(caps).join(' / ') })
  }

  let lastPlatform: AsrPlatform | '' = ''

  return (
    <Modal
      title={t('dict.table.title')}
      onClose={onClose}
      showCloseButton
      /* 780 而不是更窄：模型名最长的那个有 34 个字符
         （qwen-audio-3.0-asr-flash-streaming），再加上「开实时字幕：不发送」两行式的
         状态列和说明列，600 下说明列会被挤到折行。Modal 自带
         max-w-[calc(100vw-2rem)]，小窗口下不会溢出。 */
      panelClassName="w-[780px]"
    >
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        <RichText text={t('dict.table.intro')} />
      </p>

      {failed && (
        <p className="mt-4 text-xs text-amber-500">{t('dict.table.unavailable')}</p>
      )}

      {rows && (
        <table className="mt-3 w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-muted-foreground/70">
              <th className="pb-1.5 pr-3 font-normal">{t('dict.tableModel')}</th>
              <th className="pb-1.5 pr-3 font-normal">{t('dict.tableHotword')}</th>
              <th className="pb-1.5 font-normal">{t('dict.tableNote')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isCurrent = row.provider === currentProvider
              const platformChanged = row.platform !== lastPlatform
              lastPlatform = row.platform
              return (
                <Fragment key={`${row.provider}-${row.model}`}>
                  {platformChanged && (
                    <tr>
                      <td colSpan={3} className="pb-0.5 pt-2.5 text-[11px] font-medium text-muted-foreground">
                        {ASR_PLATFORMS[row.platform].label}
                      </td>
                    </tr>
                  )}
                  {/* 当前在用的那一行高亮 —— 用户来查表多半就是想确认自己这一行。
                      原来那张静态表做不到这件事（它压根不知道用户选了谁）。 */}
                  <tr className={cn('align-top', isCurrent && 'bg-accent/50')}>
                    <td className="py-1 pr-3">
                      {row.model}
                      {isCurrent && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          {t('dict.table.current')}
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3">{renderState(row)}</td>
                    <td className="py-1 text-muted-foreground">{renderNote(row)}</td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      {/* 本地与服务器模式不在服务目录里，但用户同样会问，所以单独两行补上。
          这两条的依据不在 Rust 矩阵里（矩阵只覆盖云端分发 key），是前端硬写的 ——
          能这么写是因为它们各自只有一个答案：服务器模式随 start 消息发送热词，
          本地引擎迁到 GGML 后没有热词通道（models/ 下搜 hotword 零命中）。 */}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        <RichText text={t('dict.table.otherModes')} />
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        <RichText text={t('dict.table.footer')} />
      </p>
    </Modal>
  )
}

export default function Dictionary() {
  useT()
  const [tab, setTab] = useState<Tab>('hotwords')
  const [exportMessage, setExportMessage] = useState('')
  const [warnDismissed, setWarnDismissed] = useState(false)
  const {
    hotwords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    themeInputs,
    newThemeName,
    search,
    loading,
    showUnknown,
    filtered,
    filteredUnknown,
    visibleCustomThemes,
    getSetWordsInHotwords,
    getThemeWordsInHotwords,
    setNewThemeName,
    setSearch,
    setShowUnknown,
    setThemeInput,
    addTheme,
    addWordsToTheme,
    addWordsToBuiltinSet,
    removeTheme,
    moveTheme,
    toggleCustomTheme,
    removeWord,
    toggleBuiltinSet,
    resetBuiltinSet,
  } = useHotwordsManager()

  // 内置分类「恢复默认」的二次确认：记下哪个分类已点过第一下，3 秒没再点就撤回
  const [resetArmedKey, setResetArmedKey] = useState<string | null>(null)
  useEffect(() => {
    if (!resetArmedKey) return
    const timer = setTimeout(() => setResetArmedKey(null), 3000)
    return () => clearTimeout(timer)
  }, [resetArmedKey])
  const isBuiltinSetModified = (key: string) => {
    const words = builtinSetWords[key] || []
    const defaults = new Set(BUILTIN_SETS[key]?.words ?? [])
    return words.length !== defaults.size || words.some((word) => !defaults.has(word))
  }

  // 搜索时列表是过滤后的，序号对不上完整列表，因此搜索状态下不启用拖拽
  const themeSortable = useSortable({ onMove: (from, to) => void moveTheme(from, to) })

  const handleExport = async () => {
    const result = await exportHotwords()
    setExportMessage(result.canceled ? t('history.exportCanceled') : t('history.savedTo', { path: result.filePath ?? '' }))
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* 标题栏 + Tab */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">{t('nav.hotwords')}</h1>
          <div className="flex gap-1 rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setTab('hotwords')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === 'hotwords' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('dict.tabHotwords')}</button>
            <button
              type="button"
              onClick={() => setTab('replacement')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === 'replacement' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('dict.tabTextProcess')}</button>
          </div>
        </div>

        {/* 热词 Tab 的搜索和导出 */}
        {tab === 'hotwords' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {hotwords.length} / {MAX_HOTWORDS}
            </span>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('dict.searchPlaceholder')}
                className="w-52 rounded-md border border-input-border bg-input-bg py-1.5 pl-8 pr-3 text-sm"
              />
            </div>
            <Tooltip content={t('history.export')}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                onClick={() => void handleExport()}
                aria-label={t('history.export')}
              >
                <Download className="h-4 w-4" />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>

      {exportMessage && tab === 'hotwords' && (
        <p className="mb-2 text-sm text-muted-foreground">{exportMessage}</p>
      )}

      {/* ===== 文本处理 Tab ===== */}
      {tab === 'replacement' && (
        <>
          <TextFormatSection />
          <TextReplacementSection />
        </>
      )}

      {/* ===== 热词 Tab ===== */}
      {tab === 'hotwords' && (
        <>
          <p className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
            <span>{t('dict.intro')}</span>
            <Tooltip
              variant="light"
              content={
                <p className="max-w-[380px] text-left leading-relaxed">
                  <RichText text={t('dict.caveat')} />
                </p>
              }
            >
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
            </Tooltip>
          </p>

          {/* 当前这套配置拿热词做什么。
              取代了原来那张硬编码的「各模型对热词的支持」表：那张表漏了 6 家云服务，
              而且永远显示同一份内容、不看用户选的是谁（issue #67）。用户在这一页要
              回答的问题只有一个 —— 我配的热词现在有用吗。全模型对照移到了
              docs/SayIt 语音识别配置.md，那是做选型时才看的东西。 */}
          <HotwordDeliveryNotice hotwordCount={hotwords.length} />

          {hotwords.length > HOTWORD_SOFT_LIMIT && !warnDismissed && (
            <div className="mb-4 -mt-2 flex items-start gap-2 text-xs text-amber-500">
              <p>
                <RichText text={t('dict.countHint', { count: hotwords.length })} />
              </p>
              <button
                type="button"
                onClick={() => setWarnDismissed(true)}
                className="shrink-0 rounded p-0.5 text-amber-500/70 transition-colors hover:bg-amber-500/10 hover:text-amber-500"
                aria-label={t('dict.dismissHint')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* 新建热词分类 */}
          <div className="mb-4 flex items-center gap-2">
            <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={newThemeName}
              onChange={(e) => setNewThemeName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void addTheme()
                }
              }}
              placeholder={t('dict.newCategoryPlaceholder')}
              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
            />
            <Button
              onClick={() => void addTheme()}
              size="sm"
              variant="outline"
              disabled={!newThemeName.trim()}
              className="shrink-0 gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('dict.add')}
            </Button>
          </div>

          {loading ? (
            <p className="py-8 text-center text-muted-foreground">{t('dict.loading')}</p>
          ) : (
            <div className="space-y-4">
              {/* 自定义分类 */}
              {customThemes.length > 1 && !search && (
                <p className="text-xs text-muted-foreground/70">
                  {t('dict.orderHint')}
                </p>
              )}
              {visibleCustomThemes.map((theme, themeIndex) => {
                const canSort = !search && customThemes.length > 1
                const active = !!customThemeActive[theme.id]
                const activeWords = getThemeWordsInHotwords(theme)
                const totalWords = theme.words.length

                return (
                  <Card
                    key={theme.id}
                    {...(canSort ? themeSortable.rowProps(themeIndex) : {})}
                    className={cn('group', !active && 'border-dashed opacity-70', canSort && themeSortable.rowClassName(themeIndex))}
                  >
                    <CardContent className="p-4">
                      {/* 开关放右边（和全软件一致）；收起时没有下方内容，不留 mb-3 的空白 */}
                      <div className={cn('flex items-center justify-between gap-3', active && 'mb-3')}>
                        <div className="flex items-center gap-3 min-w-0">
                          {canSort && <DragHandle {...themeSortable.handleProps(themeIndex, t('dict.dragCategory', { name: theme.name }))} />}
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{theme.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {t('dict.customCount', { active: activeWords.length, total: totalWords })}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <Tooltip content={t('dict.deleteCategory')}>
                            <button
                              type="button"
                              onClick={() => void removeTheme(theme.id)}
                              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              aria-label={t('dict.deleteTheme', { name: theme.name })}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                          <Switch
                            checked={active}
                            onChange={() => void toggleCustomTheme(theme.id)}
                            size="sm"
                          />
                        </div>
                      </div>

                      {active && (
                        <div className="space-y-3">
                          <div className="flex gap-2">
                            <input
                              value={themeInputs[theme.id] || ''}
                              onChange={(e) => setThemeInput(theme.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault()
                                  void addWordsToTheme(theme.id)
                                }
                              }}
                              placeholder={t('dict.addWordsPlaceholder')}
                              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                            />
                            <Button
                              onClick={() => void addWordsToTheme(theme.id)}
                              size="sm"
                              variant="outline"
                              disabled={!(themeInputs[theme.id] || '').trim()}
                              className="shrink-0 gap-1.5"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {t('dict.add')}
                            </Button>
                          </div>

                          {activeWords.length > 0 && (
                            <WordChips words={activeWords} onRemove={removeWord} expandAll={!!search} />
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}

              {/* 内置分类 */}
              {Object.entries(BUILTIN_SETS).map(([key, setDef]) => {
                const active = !!builtinSetActive[key]
                const activeWords = getSetWordsInHotwords(key)
                const totalWords = (builtinSetWords[key] || []).length

                if (search && activeWords.length === 0 && !setDef.label.toLowerCase().includes(search.toLowerCase())) {
                  return null
                }

                const inputKey = builtinInputKey(key)
                const modified = isBuiltinSetModified(key)
                const resetTip = t(modified ? 'dict.resetTip' : 'dict.resetTipDefault')

                return (
                  <Card key={key} className={cn(!active && 'border-dashed opacity-70')}>
                    <CardContent className="p-4">
                      <div className={cn('flex items-center justify-between gap-3', active && 'mb-3')}>
                        <div className="flex items-center gap-3 min-w-0">
                          {/* 自建分类可拖动时左边有手柄，内置分类留同宽空位，名字才能对齐 */}
                          {!search && customThemes.length > 1 && <span className="w-[22px] shrink-0" aria-hidden />}
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{setDef.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {t('dict.builtinCount', { desc: setDef.description, active: activeWords.length, total: totalWords })}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          {/* 和自建分类的删除键同一种小图标按钮。词表没改过时置灰、点不了（藏起来的话用户以为按钮丢了）；
                              改过之后要点两下：第一下变成「确认恢复」，3 秒内再点才执行 —— 它会清掉用户加的词，
                              以前是个带文字的大按钮，挨着开关，很容易误点。 */}
                          {resetArmedKey === key && modified ? (
                            <button
                              type="button"
                              onClick={() => { setResetArmedKey(null); void resetBuiltinSet(key) }}
                              className="rounded px-1.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
                            >
                              {t('dict.resetConfirm')}
                            </button>
                          ) : (
                            <Tooltip content={resetTip}>
                              {/* 包一层 span：disabled 的 button 不派发鼠标事件，提示会出不来 */}
                              <span className="inline-flex">
                                <button
                                  type="button"
                                  disabled={!modified}
                                  onClick={() => setResetArmedKey(key)}
                                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                                  aria-label={resetTip}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </button>
                              </span>
                            </Tooltip>
                          )}
                          <Switch
                            checked={active}
                            onChange={() => void toggleBuiltinSet(key)}
                            size="sm"
                          />
                        </div>
                      </div>

                      {/* 和自建分类同一套添加框：用户常想把自己领域的词补进内置分类，而不是为一两个词另建分类 */}
                      {active && (
                        <div className="space-y-3">
                          <div className="flex gap-2">
                            <input
                              value={themeInputs[inputKey] || ''}
                              onChange={(e) => setThemeInput(inputKey, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault()
                                  void addWordsToBuiltinSet(key)
                                }
                              }}
                              placeholder={t('dict.addWordsPlaceholder')}
                              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                            />
                            <Button
                              onClick={() => void addWordsToBuiltinSet(key)}
                              size="sm"
                              variant="outline"
                              disabled={!(themeInputs[inputKey] || '').trim()}
                              className="shrink-0 gap-1.5"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {t('dict.add')}
                            </Button>
                          </div>

                          {activeWords.length > 0 && (
                            <WordChips words={activeWords} onRemove={removeWord} expandAll={!!search} />
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}

              {/* 历史未分类词汇 */}
              {filteredUnknown.length > 0 && (
                <Card>
                  <CardContent className="p-4">
                    <button
                      className="mb-2 flex w-full items-center justify-between text-left"
                      onClick={() => setShowUnknown(!showUnknown)}
                    >
                      <div>
                        <p className="text-sm font-medium">{t('dict.legacyTitle')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('dict.legacyDesc')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{filteredUnknown.length}</span>
                        {showUnknown ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </button>

                    {showUnknown && (
                      <WordChips words={filteredUnknown} onRemove={removeWord} expandAll={!!search} />
                    )}
                  </CardContent>
                </Card>
              )}

              {!search && hotwords.length === 0 && (
                <div className="rounded-lg border border-dashed border-border py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {/* 已经建过分类却还是 0 个生效词时，叫人「先新建分类」就不对了 */}
                    {customThemes.length > 0 ? t('dict.emptyWithCategories') : t('dict.empty')}
                  </p>
                </div>
              )}

              {search && filtered.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">{t('dict.noMatch')}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
