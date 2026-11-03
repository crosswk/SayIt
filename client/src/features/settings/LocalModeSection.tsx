// 本地模式配置面板 — 模型管理

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen, Copy, Check, ChevronDown, HardDrive, Loader2, Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Feedback } from '@/components/ui/feedback'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/ui/modal'
import { getSetting, setSetting } from '@/services/store'
import { refreshModeStatus } from '@/stores/modeStatus'
import { reconnectProvider } from '@/services/recorder'
import { describeDownloadError } from '@/lib/errorMessages'
import { getLocale, t } from '@/i18n'
import { IS_MAC } from '@/lib/platform'
import { useT } from '@/i18n/useT'
import {
  localModelDisplayDescription,
  localModelDisplayLanguages,
  localModelDisplayName,
} from '@/i18n/displayNames'

/** 模型存储位置变更的窗口事件：次级设置卡片（LocalModeAdvancedSection）里改了
 *  目录后，通知模型列表卡片刷新已下载状态——两个卡片各自持有状态、不在同一组件树。 */
const MODELS_DIR_CHANGED_EVENT = 'sayit:models-dir-changed'

function formatList(items: string[]): string {
  return items.join(t('common.listSeparator'))
}

interface ModelFile {
  name: string
  url: string
  size_bytes: number
  sha256: string | null
}

interface DownloadSource {
  source: string
  files: ModelFile[]
}

interface ModelInfo {
  id: string
  name: string
  description: string
  model_type: string
  total_size_bytes: number
  languages: string[]
  sources: DownloadSource[]
  speed?: number
  accuracy?: number
  recommended?: boolean
  memory_mb?: number
  languages_label?: string
  quant?: string
  featured?: boolean
}

interface LocalModelInfo {
  id: string
  name: string
  model_type: string
  total_size_bytes: number
  path: string
  complete: boolean
}

interface DownloadProgress {
  model_id: string
  file_name: string
  downloaded_bytes: number
  total_bytes: number
  percent: number
  file_index: number
  file_count: number
  status: string
  error: string | null
}

interface ModelsDirInfo {
  current: string
  default_dir: string
  is_custom: boolean
}

// 本地 GGUF 引擎的诊断信息（Rust 命令 gguf_asr_diagnostics）
interface GgufDevice {
  kind: string
  name: string
  memory_mb: number
  /** 持久化用的稳定标识（PCI 总线 id，拿不到时是 "kind:name"）。设置里存这个。 */
  id: string
  /** ggml registry 索引。只用于排序展示，别拿它当持久化标识——驱动更新会让它变。 */
  index: number
  is_gpu: boolean
}

interface GgufDiagnostics {
  devices: GgufDevice[]
  current_backend: string | null
  /** 实际绑定的设备描述。与用户选的那张可能不同（详见 Rust 侧 resolve_gpu_device），
   *  所以"当前使用"一行显示的必须是这个，不是设置值。 */
  current_device: string | null
  /** 正在加载中的模型 id。非 null 时 current_backend 一定是 null。 */
  loading_model: string | null
  native_version: string
  process_memory_mb: number
}

/** 显卡名里的商标噪音（(R) / (TM)）去掉，列表里已经够长了。 */
function cleanDeviceName(name: string): string {
  return name.replace(/\((R|TM)\)/gi, '').trim()
}

/** 显卡标签：名字 +「（N GB 显存）」。mac 的 Apple 芯片是统一内存，没有显存可报，只写名字。 */
function gpuLabel(d: Pick<GgufDevice, 'name' | 'memory_mb'>): string {
  const vram = !IS_MAC && d.memory_mb > 0 ? t('local.vram', { gb: (d.memory_mb / 1024).toFixed(0) }) : ''
  return `${cleanDeviceName(d.name)}${vram}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 常驻内存的展示：350 → "~350 MB"，1400 → "~1.4 GB"。
 *  统一按 1024 进制、统一写「GB/MB」——同一页原来出现过 /1000 的「~1.4G」、
 *  /1024³ 的「1.4 GB」和 /1024 的「8 GB」三种口径，用户没法横向比。 */
function formatMemory(mb: number): string {
  if (mb < 1024) return `~${mb} MB`
  return `~${(mb / 1024).toFixed(1)} GB`
}

/** 下载源的展示名。同一个源在模型卡里叫「HF Mirror（国内推荐）」、在离线指引里叫
 *  「HF Mirror (China)」，收敛到一处。 */
function sourceLabel(source: string): string {
  return source === 'HuggingFace Mirror' ? t('local.source.mirror') : source
}

/** 速度/准确度评级：10 分制细柱状条（无数字），与参数排同一行 */
function MiniRating({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100))
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

function CopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-md bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{label}</span>
        {/* 纯图标按钮必须自带 aria-label：Tooltip 只响应鼠标悬停，键盘和读屏用户拿不到它 */}
        <Tooltip content={copied ? t('record.copied') : t('common.copyLink')}>
          <button
            type="button"
            aria-label={copied ? t('common.copiedLink', { label }) : t('common.copyLinkAria', { label })}
            onClick={() => {
              void navigator.clipboard.writeText(url)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied
              ? <Check className="h-3.5 w-3.5 text-success-strong" aria-hidden />
              : <Copy className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </Tooltip>
      </div>
      <code className="mt-1 block select-all break-all text-[11px] leading-relaxed text-muted-foreground">{url}</code>
    </div>
  )
}

function OfflineGuideDialog({ models, onClose }: { models: ModelInfo[]; onClose: () => void }) {
  const [selectedSource, setSelectedSource] = useState(0)

  // 收集所有源名称
  const sourceNames = models[0]?.sources.map((s) => s.source) || []

  return (
    <Modal title={t('local.offlineGuideTitle')} onClose={onClose} showCloseButton panelClassName="w-[640px]">
      <>
        {/* 步骤 */}
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p>{t('local.offlineStep1')}</p>
          <p>{t('local.offlineStep2')}</p>
          <p>{t('local.offlineStep3')}</p>
        </div>

        {/* 源切换 */}
        <div role="radiogroup" aria-label={t('local.downloadSourceAria')} className="mt-4 flex gap-1 rounded-lg border border-border p-0.5">
          {sourceNames.map((name, i) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selectedSource === i}
              onClick={() => setSelectedSource(i)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${selectedSource === i
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {sourceLabel(name)}
            </button>
          ))}
        </div>

        {/* 模型文件链接 */}
        <div className="mt-4 space-y-4">
          {models.map((model) => {
            const modelName = localModelDisplayName(model)
            // 某模型没有当前标签对应的源时，回退到它的第一个源（防御，正常不会发生：
            // catalog 的测试保证所有模型提供同一组源）
            const source = model.sources[selectedSource] ?? model.sources[0]
            if (!source) return null
            return (
              <div key={model.id}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-medium">{modelName}</span>
                  <code className="rounded bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">{model.id}/</code>
                  <Tooltip content={t('local.openModelFolder')}>
                    <button
                      type="button"
                      aria-label={t('local.openModelFolderAria', { name: modelName })}
                      onClick={() => void invoke<string>('open_model_folder', { modelId: model.id })}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </Tooltip>
                </div>
                <div className="space-y-1.5">
                  {source.files.map((file) => (
                    <CopyLink key={file.name} url={file.url} label={file.name} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </>
    </Modal>
  )
}

/** 模型存储位置：查看 / 更改 / 恢复默认。更改时可选把已下载模型一并迁移。 */
function ModelsDirSection({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<ModelsDirInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 待确认的目录变更：null=无。dir=null 表示恢复默认。
  const [pending, setPending] = useState<{ dir: string | null } | null>(null)

  const load = async () => {
    try { setInfo(await invoke<ModelsDirInfo>('get_models_dir')) } catch { /* ignore */ }
  }
  useEffect(() => { void load() }, [])

  async function pickDir() {
    setError('')
    try {
      const selected = await open({ directory: true, multiple: false, title: t('local.pickDirTitle') })
      if (typeof selected !== 'string') return // 取消
      if (info && selected === info.current) return // 未变化
      setPending({ dir: selected })
    } catch (err) {
      setError(String(err))
    }
  }

  function requestResetDefault() {
    if (!info || !info.is_custom) return
    setPending({ dir: null })
  }

  async function applyChange() {
    if (!pending) return
    setBusy(true)
    setError('')
    try {
      // 一律自动迁移已下载的模型到新目录
      await invoke<string>('set_models_dir', { dir: pending.dir, moveExisting: true })
      setPending(null)
      await load()
      onChanged() // 路径变了，刷新已下载模型列表
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-2 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t('local.storageTitle')}</h2>
          <Tooltip variant="light" content={t('local.storageHelp')}>
            <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
          </Tooltip>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[12rem] flex-1 items-center gap-1.5 rounded-md bg-muted/30 px-3 py-2">
            <code className="min-w-0 flex-1 select-all truncate text-xs text-muted-foreground" title={info?.current}>
              {info?.current || t('common.loading')}
            </code>
            {info?.is_custom && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t('local.storageCustom')}</span>
            )}
            <Tooltip content={t('local.openDir')}>
              <button
                type="button"
                aria-label={t('local.openDirAria')}
                onClick={() => void invoke<string>('open_models_folder')}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
          <Button size="sm" variant="outline" onClick={() => void pickDir()} disabled={busy}>
            {t('local.changeLocation')}
          </Button>
          {info?.is_custom && (
            <Button size="sm" variant="ghost" onClick={requestResetDefault} disabled={busy}>
              {t('local.restoreDefault')}
            </Button>
          )}
        </div>

        {error && <Feedback className="mt-3" tone="error" message={t('local.dirOpFailed')} detail={error} />}
      </CardContent>

      {pending && (
        <Modal
          title={pending.dir === null ? t('local.restoreDefaultTitle') : t('local.changeLocationTitle')}
          onClose={() => setPending(null)}
          locked={busy}
          panelClassName="w-[420px]"
        >
          <>
            <p className="mt-2 break-all text-sm text-muted-foreground">
              {t('local.newLocation', { dir: pending.dir === null ? (info?.default_dir || t('local.defaultDir')) : pending.dir })}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('local.migrateNote')}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPending(null)} disabled={busy}>{t('common.cancel')}</Button>
              <Button size="sm" onClick={() => void applyChange()} disabled={busy}>
                {busy ? (<><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />{t('common.processing')}</>) : t('common.confirm')}
              </Button>
            </div>
          </>
        </Modal>
      )}
    </Card>
  )
}

export default function LocalModeSection() {
  useT()
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [downloadedModels, setDownloadedModels] = useState<LocalModelInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [downloadSource, setDownloadSource] = useState(
    () => getLocale() === 'en' ? 'HuggingFace' : 'HuggingFace Mirror',
  )
  const [preloadingModelId, setPreloadingModelId] = useState('')
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress>>({})
  // 「更多模型」折叠。默认只展示 featured 的小/中/大三个，其余点开才看到。
  const [showMore, setShowMore] = useState(false)
  // 模型清单的加载状态。原来 loadData 的 catch 是空的，list_available_models 失败时
  // 页面只剩标题 + 下载源一行 + 下面一片空白，看起来像"本地模式坏了"。
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState('')
  // 离线下载指引的开关提到这一层：下载失败时也要能把用户直接送进去
  const [offlineGuideOpen, setOfflineGuideOpen] = useState(false)
  // 检测到的 GPU 摘要。选模型时最该知道的就是"这台机器什么水平"，
  // 而这条信息原来只出现在两张卡片之后的「计算后端」里。
  const [gpuSummary, setGpuSummary] = useState<string | null>(null)

  useEffect(() => {
    void loadData()
    const unlisten = listen<DownloadProgress>('model-download-progress', (event) => {
      const p = event.payload
      setDownloading((prev) => ({ ...prev, [p.model_id]: p }))
      if (p.status === 'completed' || p.status === 'failed') {
        void refreshDownloaded()
      }
    })
    // 模型存储位置（在次级设置卡片里）变更后，刷新已下载列表
    const onDirChanged = () => { void refreshDownloaded() }
    window.addEventListener(MODELS_DIR_CHANGED_EVENT, onDirChanged)
    return () => {
      void unlisten.then((fn) => fn())
      window.removeEventListener(MODELS_DIR_CHANGED_EVENT, onDirChanged)
    }
  }, [])

  async function loadData() {
    let available: ModelInfo[] = []
    try {
      const [a, downloaded] = await Promise.all([
        invoke<ModelInfo[]>('list_available_models'),
        invoke<LocalModelInfo[]>('list_downloaded_models'),
      ])
      available = a
      setAvailableModels(a)
      setDownloadedModels(downloaded)
      setListState('ready')
      setListError('')
    } catch (err) {
      setListState('error')
      setListError(String(err))
    }

    // GPU 摘要：只为在模型列表顶部给一句硬件背景，失败就当没有（不影响选模型）
    try {
      const diag = await invoke<GgufDiagnostics>('gguf_asr_diagnostics')
      const gpus = diag.devices.filter((d) => d.kind !== 'cpu')
      setGpuSummary(gpus.length > 0
        ? formatList(gpus
          .map((d) => gpuLabel(d)))
        : '')
    } catch {
      setGpuSummary(null)
    }

    const selected = await getSetting('localAsr.modelId', 'sensevoice-small-gguf') as string
    setSelectedModelId(selected)
    const defaultSource = getLocale() === 'en' ? 'HuggingFace' : 'HuggingFace Mirror'
    setDownloadSource(await getSetting('localAsr.downloadSource', defaultSource) as string)

    // 当前选中的模型在折叠区时自动展开，避免"当前模型在列表里找不到"
    const selectedInfo = available.find((m) => m.id === selected)
    if (selectedInfo && !selectedInfo.featured) setShowMore(true)
  }

  async function refreshDownloaded() {
    try {
      const downloaded = await invoke<LocalModelInfo[]>('list_downloaded_models')
      setDownloadedModels(downloaded)
    } catch { /* ignore */ }
  }

  async function handleDownload(modelId: string) {
    try {
      await invoke('download_model', { modelId, source: downloadSource })
      // 下载完成后自动选中并预加载
      setSelectedModelId(modelId)
      await setSetting('localAsr.modelId', modelId)
      void refreshModeStatus() // 同步左下角的引擎指示
      try {
        const accelerator = await getSetting('localAsr.accelerator', 'auto') as string
        const gpuDevice = await getSetting('localAsr.gpuDevice', '') as string
        await invoke<string>('preload_local_model', { modelId, accelerator, gpuDevice })
      } catch { /* ignore */ }
      // provider 缓存着上次的就绪结果，不重连的话刚下载完第一次按快捷键仍会被判未就绪。
      // 同 handleSelectModel：排在预加载之后，避免它的 onConnect 再排一轮加载。
      reconnectProvider()
    } catch (err) {
      setDownloading((prev) => ({
        ...prev,
        [modelId]: {
          ...prev[modelId],
          model_id: modelId,
          file_name: '',
          downloaded_bytes: 0,
          total_bytes: 0,
          percent: 0,
          status: 'failed',
          error: String(err),
        },
      }))
    }
  }

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  async function handleDelete(modelId: string) {
    setConfirmDeleteId(null)
    try {
      await invoke('delete_model', { modelId })
      await refreshDownloaded()
      setDownloading((prev) => {
        const next = { ...prev }
        delete next[modelId]
        return next
      })
      // 删掉的可能正是当前选中的模型 → 就绪状态变了，通知徽标与侧栏指示
      void refreshModeStatus()
      // 同时让 provider 重新判定：否则它仍缓存着"已就绪"，模型都删了还能照常开录
      reconnectProvider()
    } catch { /* ignore */ }
  }

  /** 切到另一个下载源并立刻重试。下载失败时最常见的下一步就是这个。 */
  async function retryWithOtherSource(modelId: string) {
    const options = availableModels[0]?.sources.map((s) => s.source) ?? []
    const next = options.find((s) => s !== downloadSource) ?? downloadSource
    setDownloadSource(next)
    await setSetting('localAsr.downloadSource', next)
    setDownloading((prev) => {
      const rest = { ...prev }
      delete rest[modelId]
      return rest
    })
    await handleDownload(modelId)
  }

  async function handleSelectModel(modelId: string) {
    if (preloadingModelId) return // 防止切换/加载中重复触发
    setSelectedModelId(modelId)
    setPreloadingModelId(modelId)
    await setSetting('localAsr.modelId', modelId)
    void refreshModeStatus() // 同步左下角的引擎指示
    try {
      const accelerator = await getSetting('localAsr.accelerator', 'auto') as string
      const gpuDevice = await getSetting('localAsr.gpuDevice', '') as string
      await invoke<string>('preload_local_model', { modelId, accelerator, gpuDevice })
    } catch { /* 未下载 / 加载失败都由就绪判定与识别阶段报出，这里不打断选择 */ } finally {
      setPreloadingModelId('')
      // reconnectProvider 必须排在预加载**之后**：它的 onConnect 自己也会发一次
      // preload_local_model，而引擎的加载是全局单锁串行的。放在前面（原来的写法）
      // 等于一次点击排两轮"卸旧 + 载新"，等待时间可能翻倍。
      // 放在后面，它只会命中已经加载好的缓存，立刻返回。
      // 未下载的模型走的是同一条路：预加载报错后仍然要 reconnect 让 provider
      // 重新判定为未就绪，所以这行放在 finally 里而不是 try 的末尾。
      reconnectProvider()
    }
  }

  const downloadedIds = new Set(downloadedModels.filter((m) => m.complete).map((m) => m.id))

  // 小/中/大三个直接展示，其余折叠进「更多」。后端没标 featured 时全部展示兜底。
  const featuredModels = availableModels.some((m) => m.featured)
    ? availableModels.filter((m) => m.featured)
    : availableModels
  const moreModels = availableModels.filter((m) => !featuredModels.includes(m))
  const visibleModels = showMore ? [...featuredModels, ...moreModels] : featuredModels

  // 下载源按钮从 catalog 生成，保证和后端提供的源一一对应
  // （catalog 的测试保证了所有模型的源集合一致，取第一个模型的即可）
  const sourceOptions = availableModels[0]?.sources.map((s) => s.source) ?? []
  // 存储里的旧值（如已下线的 ModelScope）对不上任何源时，实际下载会回落到
  // 第一个源，这里让 UI 显示和实际行为一致
  const effectiveSource = sourceOptions.includes(downloadSource)
    ? downloadSource
    : sourceOptions[0] ?? downloadSource

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t('local.modelTitle')}</h2>
            <Tooltip content={t('local.openModelDir')}>
              <button
                type="button"
                aria-label={t('local.openModelDir')}
                onClick={() => void invoke<string>('open_models_folder')}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>

          {selectedModelId && downloadedIds.has(selectedModelId) && (
            <p className="mb-2 text-sm text-muted-foreground">
              {t('local.currentModel', { name: availableModels.find((m) => m.id === selectedModelId)?.name || selectedModelId })}
            </p>
          )}
          {selectedModelId && !downloadedIds.has(selectedModelId) && listState === 'ready' && (
            <Feedback
              className="mb-3"
              tone="warning"
              message={t('local.notDownloadedWarning')}
            />
          )}

          {/* 硬件背景。选模型是这一页最难的决定，而"这台机器什么水平"这条信息
              原来要往下翻两张卡才看得到。 */}
          {gpuSummary !== null && (
            <p className="mb-4 text-xs text-muted-foreground">
              {gpuSummary
                ? t(IS_MAC ? 'local.gpuDetectedMac' : 'local.gpuDetected', { gpu: gpuSummary })
                : t('local.noGpu')}
            </p>
          )}

          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span id="download-source-label" className="text-sm text-muted-foreground">{t('local.downloadSource')}</span>
            <Segmented
              labelledBy="download-source-label"
              size="sm"
              value={effectiveSource}
              options={sourceOptions.map((src) => ({ value: src, label: sourceLabel(src) }))}
              onChange={(src) => { setDownloadSource(src); void setSetting('localAsr.downloadSource', src) }}
              className="shrink-0 justify-end"
            />
          </div>

          {listState === 'loading' && (
            <p className="py-4 text-sm text-muted-foreground">{t('local.loadingCatalog')}</p>
          )}
          {listState === 'error' && (
            <Feedback
              tone="error"
              message={t('local.catalogError')}
              detail={listError}
              actions={[{ label: t('local.reload'), onClick: () => void loadData() }]}
            />
          )}
          {listState === 'ready' && availableModels.length === 0 && (
            <Feedback
              tone="warning"
              message={t('local.catalogEmpty')}
            />
          )}

          <div className="space-y-2">
            {visibleModels.map((model) => {
              const modelName = localModelDisplayName(model)
              const modelDescription = localModelDisplayDescription(model)
              const modelLanguages = localModelDisplayLanguages(model)
              const isDownloaded = downloadedIds.has(model.id)
              const isSelected = selectedModelId === model.id
              const progress = downloading[model.id]
              const isDownloading = progress?.status === 'downloading'

              return (
                <div
                  key={model.id}
                  className={`flex items-center justify-between rounded-lg border p-3 ${isSelected ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{modelName}</span>
                      {model.recommended && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t('local.recommended')}</span>
                      )}
                      {isDownloaded && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Check className="h-3 w-3" />{t('local.downloaded')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{modelDescription}</p>
                    {/* 参数行：评分柱状条 + 下载体积（硬盘图标）+ 内存占用 + 语种，一行小字。
                        量化档（Q8_0 之类）不展示——普通用户看不懂，文件名里查得到 */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                      {model.speed ? <MiniRating label={t('local.speed')} value={model.speed} /> : null}
                      {model.accuracy ? <MiniRating label={t('local.accuracy')} value={model.accuracy} /> : null}
                      {model.total_size_bytes > 0 && (
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3 w-3" />
                          {formatSize(model.total_size_bytes)}
                        </span>
                      )}
                      {model.memory_mb ? (
                        <><span aria-hidden>·</span><span>{t('local.memoryUsage', { size: formatMemory(model.memory_mb) })}</span></>
                      ) : null}
                      {modelLanguages ? (
                        <><span aria-hidden>·</span><span>{modelLanguages}</span></>
                      ) : null}
                    </div>
                    {isDownloading && progress && (
                      <div className="mt-2">
                        <div
                          role="progressbar"
                          aria-label={t('local.downloadingAria', { name: modelName })}
                          aria-valuenow={Math.round(progress.percent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>
                        {/* aria-live：下载过去对读屏用户是完全静默的 */}
                        <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                          {progress.file_count > 1
                            ? t('local.fileProgress', { index: progress.file_index, count: progress.file_count })
                            : ''}
                          {progress.file_name} — {progress.percent.toFixed(1)}%
                          {progress.total_bytes > 0
                            ? t('local.downloadProgressBytes', {
                              downloaded: formatSize(progress.downloaded_bytes),
                              total: formatSize(progress.total_bytes),
                            })
                            : t('local.downloadedBytes', { downloaded: formatSize(progress.downloaded_bytes) })}
                        </p>
                      </div>
                    )}
                    {/* 下载失败原来只有一行原始异常。而"换个源重试"和"手动下载指引"这两条
                        降级路径就在同一张卡上，失败信息却不指向任何一个——用户会以为
                        本地模式不能用。现在直接把两个动作放进错误块里。 */}
                    {progress?.status === 'failed' && (() => {
                      const friendly = describeDownloadError(progress.error ?? '')
                      const hasOtherSource = sourceOptions.some((s) => s !== effectiveSource)
                      return (
                        <Feedback
                          className="mt-2"
                          tone="error"
                          message={friendly.message}
                          detail={friendly.detail}
                          actions={[
                            ...(friendly.action === 'switch_source' && hasOtherSource
                              ? [{
                                label: t('local.switchSourceRetry', { source: sourceLabel(sourceOptions.find((s) => s !== effectiveSource) ?? '') }),
                                onClick: () => void retryWithOtherSource(model.id),
                              }]
                              : [{ label: t('common.retry'), onClick: () => void handleDownload(model.id) }]),
                            { label: t('local.manualGuide'), onClick: () => setOfflineGuideOpen(true) },
                          ]}
                        />
                      )
                    })()}
                  </div>
                  <div className="ml-3 flex gap-2">
                    {isDownloaded ? (
                      <>
                        {!isSelected && (
                          <Button
                            size="sm" variant="outline"
                            disabled={preloadingModelId !== ''}
                            onClick={() => void handleSelectModel(model.id)}
                          >
                            {preloadingModelId === model.id ? t('local.loadingModel') : t('local.select')}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(model.id)}>
                          {t('common.delete')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => void handleDownload(model.id)}
                        disabled={isDownloading}
                      >
                        {isDownloading ? t('local.downloading') : t('local.download')}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* 加载一个模型要读完整个权重文件再预热一次推理，大模型几十秒也正常。
              原来这段只让按钮变灰，界面看起来就是卡死了 —— 0.1.4 有用户因此强杀了进程。
              所以这条必须显眼：配色沿用 Feedback 的 warning/error 写法（5% 底 + 25% 描边
              + strong 图标色），但**用不停转的图标承担"还在动"的信息** —— 静态色块
              说不出"没卡住"，转圈能。不用绿色：绿在这套配色里代表"成功/已完成"，
              加载中打绿灯会让人以为已经好了。
              role=status + aria-live：这条状态对读屏用户否则完全静默。 */}
          {preloadingModelId && (
            <div
              role="status"
              aria-live="polite"
              className="mt-3 flex items-start gap-2 rounded-md border border-info/25 bg-info/5 px-3 py-2.5"
            >
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-info-strong" aria-hidden />
              <p className="text-sm leading-relaxed text-foreground">
                {/* 显式 {' '}：两个表达式之间的换行会被 JSX 整个吃掉，
                    英文下就会粘成 "…Loading" 这种没有空格的样子 */}
                {t('local.preloading', { name: availableModels.find((m) => m.id === preloadingModelId)?.name || preloadingModelId })}
                {' '}
                {t('local.preloadingNote')}
              </p>
            </div>
          )}

          {/* 更多模型：小众需求（更多语种 / 中间量化档）折叠收纳 */}
          {moreModels.length > 0 && (
            <button
              type="button"
              aria-expanded={showMore}
              onClick={() => setShowMore(!showMore)}
              className="mt-3 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {showMore ? t('common.collapse') : t('local.moreModels', { count: moreModels.length })}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showMore ? 'rotate-180' : ''}`} aria-hidden />
            </button>
          )}

          {availableModels.length > 0 && (
            <button
              type="button"
              onClick={() => setOfflineGuideOpen(true)}
              className="mt-3 text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60"
            >
              {t('local.slowDownloadHint')}
            </button>
          )}
        </CardContent>
      </Card>

      {offlineGuideOpen && (
        <OfflineGuideDialog models={availableModels} onClose={() => setOfflineGuideOpen(false)} />
      )}

      {/* 删除确认对话框 */}
      {confirmDeleteId && (
        <Modal title={t('local.deleteModelTitle')} onClose={() => setConfirmDeleteId(null)} panelClassName="w-80">
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('local.deleteModelBody', { name: availableModels.find((m) => m.id === confirmDeleteId)?.name || confirmDeleteId })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>{t('common.cancel')}</Button>
              <Button size="sm" variant="destructive" onClick={() => void handleDelete(confirmDeleteId)}>{t('common.delete')}</Button>
            </div>
          </>
        </Modal>
      )}
    </>
  )
}

/** 本地模式的次级设置：识别语言、计算后端、模型驻留、模型存储位置。
 *  单独一个导出，由 VoiceEnginePage 放在「识别测试」之后——选模型是主操作，
 *  这些是偶尔动一次的，不该排在测试入口前面。 */
export function LocalModeAdvancedSection() {
  useT()
  const [asrLanguage, setAsrLanguage] = useState('auto')
  const [accelerator, setAccelerator] = useState('auto')
  /** GgufDevice.id，'' = 自动。只在多显卡机器上有界面，见下面 showGpuPicker。 */
  const [gpuDevice, setGpuDevice] = useState('')
  const [unloadIdleMinutes, setUnloadIdleMinutes] = useState(0)
  const [devices, setDevices] = useState<GgufDevice[]>([])
  const [currentBackend, setCurrentBackend] = useState<string | null>(null)
  const [currentDevice, setCurrentDevice] = useState<string | null>(null)
  // 打开本页时可能正好有一次加载在进行（最常见：本地模式启动时的后台预热）。
  // 那时后端还没绑定，显示"正在加载"比什么都不显示准确。
  const [loadingModel, setLoadingModel] = useState<string | null>(null)
  const [diagnosticsState, setDiagnosticsState] = useState<'loading' | 'ready' | 'error'>('loading')
  // 切换计算后端会就地重载当前模型（几秒），期间禁掉按钮防连点
  const [rebinding, setRebinding] = useState(false)

  /** 拉一次引擎实况。挂载时与换后端后都要用，别把这几个 setState 抄两份。 */
  async function refreshDiagnostics() {
    try {
      const diag = await invoke<GgufDiagnostics>('gguf_asr_diagnostics')
      setDevices(diag.devices)
      setCurrentBackend(diag.current_backend)
      setCurrentDevice(diag.current_device)
      setLoadingModel(diag.loading_model)
      setDiagnosticsState('ready')
    } catch {
      setDiagnosticsState('error')
    }
  }

  useEffect(() => {
    void (async () => {
      setAsrLanguage(await getSetting('localAsr.language', 'auto') as string)
      setAccelerator(await getSetting('localAsr.accelerator', 'auto') as string)
      setGpuDevice(await getSetting('localAsr.gpuDevice', '') as string)
      setUnloadIdleMinutes(Number(await getSetting('localAsr.unloadIdleMinutes', 0)) || 0)
      await refreshDiagnostics()
    })()
  }, [])

  const gpuDevices = devices.filter((d) => d.is_gpu)
  const hasGpu = gpuDevices.length > 0
  const gpuSummary = formatList(gpuDevices
    .map((d) => gpuLabel(d)))

  /** 只有真的有多张显卡才给这个选择器。单卡机器上它永远只有一个有意义的值，
   *  摆在设置里只是多一个要读懂的东西。CPU 后端下也藏起来——那时它不起作用。 */
  const showGpuPicker = gpuDevices.length > 1 && accelerator !== 'cpu'

  /** 切换计算后端。引擎按 (模型, 后端, 显卡) 缓存，换任意一项都要重载模型——
   *  就地重新预加载当前模型，让切换立刻生效而不是等下次口述。
   *  模型未下载时预加载会报错，忽略即可（下载后会按新设置加载）。 */
  async function handleSelectAccelerator(value: string) {
    if (rebinding) return
    setAccelerator(value)
    await setSetting('localAsr.accelerator', value)
    await rebindEngine({ accelerator: value, gpuDevice })
  }

  /** 切换显卡。与换后端同一条路径：设置落盘 + 就地重载。 */
  async function handleSelectGpuDevice(value: string) {
    if (rebinding) return
    setGpuDevice(value)
    await setSetting('localAsr.gpuDevice', value)
    await rebindEngine({ accelerator, gpuDevice: value })
  }

  /** 重新绑定引擎。两个切换共用，别把这段抄两份——漏掉 refreshDiagnostics 的那份
   *  会让"当前使用"一行停在换卡之前的设备上，看着像设置没生效。 */
  async function rebindEngine(opts: { accelerator: string; gpuDevice: string }) {
    setRebinding(true)
    try {
      const modelId = await getSetting('localAsr.modelId', 'sensevoice-small-gguf') as string
      await invoke<string>('preload_local_model', {
        modelId,
        accelerator: opts.accelerator,
        gpuDevice: opts.gpuDevice,
      })
    } catch { /* ignore */ } finally {
      await refreshDiagnostics()
      setRebinding(false)
    }
  }

  async function handleSelectUnloadIdle(value: number) {
    setUnloadIdleMinutes(value)
    try {
      await setSetting('localAsr.unloadIdleMinutes', value)
      await invoke('set_local_model_idle_unload', { idleMinutes: value })
    } catch { /* 重启后仍会从持久化设置读取；即时更新失败不影响识别 */ }
  }

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 id="local-language-heading" className="text-lg font-semibold">{t('local.languageTitle')}</h2>
              <p className="mt-2 text-xs text-muted-foreground">{t('local.languageNote')}</p>
            </div>
            <Segmented
              labelledBy="local-language-heading"
              value={asrLanguage}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'zh', label: t('local.lang.zh') },
                { value: 'en', label: t('local.lang.en') },
              ]}
              onChange={(value) => { setAsrLanguage(value); void setSetting('localAsr.language', value) }}
              className="shrink-0 justify-end"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <h2 id="accelerator-heading" className="text-lg font-semibold">{t('local.backendTitle')}</h2>
              <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs ${diagnosticsState === 'ready' && hasGpu
                ? 'border-success/30 bg-success/10 text-success-strong'
                : 'border-border bg-muted/40 text-muted-foreground'
                }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${diagnosticsState === 'ready' && hasGpu ? 'bg-success' : 'bg-muted-foreground'}`} aria-hidden />
                {diagnosticsState === 'loading' ? t('local.backendChecking') : diagnosticsState === 'error' ? t('local.backendCheckFailed') : hasGpu ? t('local.backendGpuReady') : t('local.backendCpuOnly')}
              </span>
            </div>
            <Segmented
              labelledBy="accelerator-heading"
              value={accelerator}
              disabled={rebinding}
              options={[
                { value: 'auto', label: t('common.auto') },
                { value: 'gpu', label: 'GPU' },
                { value: 'cpu', label: 'CPU' },
              ]}
              onChange={(value) => void handleSelectAccelerator(value)}
              className="shrink-0 justify-end"
            />
          </div>
          {diagnosticsState === 'ready' && hasGpu && (
            <p className="mt-2 text-xs text-muted-foreground">
              {gpuSummary}
              {/* 加载中就说加载中：后端是在模型加载时才绑定的，这期间 currentBackend
                  一定是空，原来这里会什么都不显示，看着像检测失败。
                  多显卡机器上报设备名而不是后端名——那时用户真正想确认的是
                  "用的是哪张卡"，而 currentDevice 是实际绑定结果（可能与所选不同）。 */}
              {loadingModel
                ? t('local.backendLoadingModel')
                : showGpuPicker && currentDevice
                  ? t('local.backendCurrentDevice', { device: cleanDeviceName(currentDevice) })
                  : currentBackend
                    ? t('local.backendCurrent', { backend: currentBackend.toUpperCase() })
                    : ''}
            </p>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {diagnosticsState === 'loading'
              ? t('local.backendHintLoading')
              : diagnosticsState === 'error'
                ? t('local.backendHintError')
                : hasGpu
                  ? t('local.backendHintGpu')
                  : t('local.backendHintCpu')}
          </p>

          {/* 多显卡才出现。单卡机器上这个下拉只有一个有意义的值，摆出来纯属噪音。 */}
          {showGpuPicker && (
            <div className="mt-4 border-t border-border pt-4">
              <label id="gpu-device-heading" className="mb-2 block text-sm text-foreground">
                {t('local.gpuDeviceTitle')}
              </label>
              <Select
                labelledBy="gpu-device-heading"
                value={gpuDevice}
                disabled={rebinding}
                onChange={(value) => void handleSelectGpuDevice(value)}
                options={[
                  { value: '', label: t('local.gpuDeviceAuto') },
                  ...gpuDevices.map((d) => ({
                    value: d.id,
                    label: gpuLabel(d),
                  })),
                ]}
                className="sm:max-w-md"
              />
              <p className="mt-2 text-xs text-muted-foreground">{t('local.gpuDeviceHint')}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 id="unload-idle-heading" className="text-lg font-semibold">{t('local.unloadTitle')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('local.unloadDesc')}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {unloadIdleMinutes === 0
                  ? t('local.unloadNever')
                  : t('local.unloadAfter', {
                    duration: unloadIdleMinutes === 60 ? t('local.unload.1h') : t('local.minutes', { count: unloadIdleMinutes }),
                  })}
              </p>
            </div>
            <Segmented
              labelledBy="unload-idle-heading"
              value={unloadIdleMinutes}
              options={[
                { value: 0, label: t('local.unload.never') },
                { value: 10, label: t('local.unload.10m') },
                { value: 30, label: t('local.unload.30m') },
                { value: 60, label: t('local.unload.1h') },
              ]}
              onChange={(value) => void handleSelectUnloadIdle(value)}
              className="shrink-0 justify-end"
            />
          </div>
        </CardContent>
      </Card>

      <ModelsDirSection onChanged={() => window.dispatchEvent(new Event(MODELS_DIR_CHANGED_EVENT))} />
    </>
  )
}
