// 本地模式配置面板 — 模型管理

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { FolderOpen, Copy, Check } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { getSetting, setSetting } from '@/services/store'

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

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function CopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate text-[11px] text-foreground/70 select-all">{url}</code>
      <Tooltip content={copied ? '已复制' : '复制链接'}>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-muted-foreground"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </Tooltip>
    </div>
  )
}

function OfflineGuideDialog({ models, onClose }: { models: ModelInfo[]; onClose: () => void }) {
  const [selectedSource, setSelectedSource] = useState(0)

  // 收集所有源名称
  const sourceNames = models[0]?.sources.map((s) => s.source) || []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[520px] max-h-[80vh] overflow-y-auto rounded-xl border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold">离线下载指引</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          从下方复制链接，在浏览器中下载文件，然后放到对应的模型文件夹中。
        </p>

        {/* 步骤 */}
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p>1. 点击模型名称旁的文件夹图标，打开对应模型目录</p>
          <p>2. 复制下方链接，在浏览器中下载文件，放入该目录</p>
          <p>3. 刷新页面即可自动识别</p>
        </div>

        {/* 源切换 */}
        <div className="mt-4 flex gap-1 rounded-lg border border-border p-0.5">
          {sourceNames.map((name, i) => (
            <button
              key={name}
              onClick={() => setSelectedSource(i)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                selectedSource === i
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {name === 'HuggingFace Mirror' ? 'HF Mirror (China)' : name}
            </button>
          ))}
        </div>

        {/* 模型文件链接 */}
        <div className="mt-4 space-y-4">
          {models.map((model) => {
            const source = model.sources[selectedSource]
            if (!source) return null
            return (
              <div key={model.id}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-medium">{model.name}</span>
                  <code className="rounded bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">{model.id}/</code>
                  <Tooltip content="打开模型文件夹">
                    <button
                      type="button"
                      onClick={() => void invoke<string>('open_model_folder', { modelId: model.id })}
                      className="rounded p-1 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
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

        <div className="mt-5 flex justify-end">
          <Button size="sm" variant="outline" onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  )
}

function OfflineGuide({ models }: { models: ModelInfo[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        无法在线下载？查看离线下载指引
      </button>
      {open && <OfflineGuideDialog models={models} onClose={() => setOpen(false)} />}
    </>
  )
}

export default function LocalModeSection() {
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [downloadedModels, setDownloadedModels] = useState<LocalModelInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [downloadSource, setDownloadSource] = useState('modelscope')
  const [asrLanguage, setAsrLanguage] = useState('auto')
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress>>({})

  useEffect(() => {
    void loadData()
    const unlisten = listen<DownloadProgress>('model-download-progress', (event) => {
      const p = event.payload
      setDownloading((prev) => ({ ...prev, [p.model_id]: p }))
      if (p.status === 'completed' || p.status === 'failed') {
        void refreshDownloaded()
      }
    })
    return () => { void unlisten.then((fn) => fn()) }
  }, [])

  async function loadData() {
    try {
      const [available, downloaded] = await Promise.all([
        invoke<ModelInfo[]>('list_available_models'),
        invoke<LocalModelInfo[]>('list_downloaded_models'),
      ])
      setAvailableModels(available)
      setDownloadedModels(downloaded)
    } catch { /* ignore */ }

    setSelectedModelId(await getSetting('localAsr.modelId', 'sensevoice-small') as string)
    setDownloadSource(await getSetting('localAsr.downloadSource', 'modelscope') as string)
    setAsrLanguage(await getSetting('localAsr.language', 'auto') as string)
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
      try {
        await invoke<string>('preload_local_model', { modelId })
      } catch { /* ignore */ }
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
    } catch { /* ignore */ }
  }

  async function handleSelectModel(modelId: string) {
    setSelectedModelId(modelId)
    await setSetting('localAsr.modelId', modelId)
    try { await invoke<string>('preload_local_model', { modelId }) } catch { /* ignore */ }
  }

  const downloadedIds = new Set(downloadedModels.filter((m) => m.complete).map((m) => m.id))

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <h2 className="mb-3 text-lg font-semibold">识别语言</h2>
          <div className="flex gap-2">
            {([
              { value: 'auto', label: '自动' },
              { value: 'zh', label: '中文' },
              { value: 'en', label: '英文' },
            ] as const).map((lang) => (
              <button
                key={lang.value}
                type="button"
                onClick={() => { setAsrLanguage(lang.value); void setSetting('localAsr.language', lang.value) }}
                className={`rounded-md border px-4 py-1.5 text-sm transition-colors ${
                  asrLanguage === lang.value
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground hover:bg-accent'
                }`}
              >
                {lang.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            大部分场景选"自动"即可。纯英文会议建议选"英文"以提高准确率。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">语音识别模型</h2>
            <Tooltip content="打开模型所在文件夹">
              <button
                onClick={() => void invoke<string>('open_models_folder')}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>

          {selectedModelId && downloadedIds.has(selectedModelId) && (
            <p className="mb-4 text-sm text-muted-foreground">
              当前模型：{availableModels.find((m) => m.id === selectedModelId)?.name || selectedModelId}
            </p>
          )}
          {selectedModelId && !downloadedIds.has(selectedModelId) && (
            <p className="mb-4 text-sm text-warning">
              当前选中的模型尚未下载，请先下载。
            </p>
          )}

          <div className="mb-3 flex items-center gap-3">
            <label className="text-sm text-muted-foreground">下载源</label>
            <div className="flex gap-2">
              {([
                { value: 'ModelScope', label: 'ModelScope' },
                { value: 'HuggingFace', label: 'HuggingFace' },
                { value: 'HuggingFace Mirror', label: 'HF Mirror' },
              ] as const).map((src) => (
                <button
                  key={src.value}
                  type="button"
                  onClick={() => { setDownloadSource(src.value); void setSetting('localAsr.downloadSource', src.value) }}
                  className={`rounded-md border px-3 py-1 text-xs transition-colors ${
                    downloadSource === src.value
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card text-foreground hover:bg-accent'
                  }`}
                >
                  {src.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {availableModels.map((model) => {
              const isDownloaded = downloadedIds.has(model.id)
              const isSelected = selectedModelId === model.id
              const progress = downloading[model.id]
              const isDownloading = progress?.status === 'downloading'

              return (
                <div
                  key={model.id}
                  className={`flex items-center justify-between rounded-lg border p-3 ${
                    isSelected ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{model.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {model.total_size_bytes > 0 ? formatSize(model.total_size_bytes) : ''}
                      </span>
                      {isDownloaded && (
                        <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">已下载</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{model.description}</p>
                    {isDownloading && progress && (
                      <div className="mt-2">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {progress.file_count > 1
                            ? `文件 ${progress.file_index}/${progress.file_count} — `
                            : ''}
                          {progress.file_name} — {progress.percent.toFixed(1)}%
                          {progress.total_bytes > 0
                            ? ` (${formatSize(progress.downloaded_bytes)} / ${formatSize(progress.total_bytes)})`
                            : ` (${formatSize(progress.downloaded_bytes)})`}
                        </p>
                      </div>
                    )}
                    {progress?.status === 'failed' && (
                      <p className="mt-1 text-xs text-destructive">下载失败：{progress.error}</p>
                    )}
                  </div>
                  <div className="ml-3 flex gap-2">
                    {isDownloaded ? (
                      <>
                        {!isSelected && (
                          <Button size="sm" variant="outline" onClick={() => void handleSelectModel(model.id)}>
                            选择
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(model.id)}>
                          删除
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => void handleDownload(model.id)}
                        disabled={isDownloading}
                      >
                        {isDownloading ? '下载中...' : '下载'}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* 离线下载指引（可折叠） */}
          <OfflineGuide models={availableModels} />

        </CardContent>
      </Card>

      {/* 删除确认对话框 */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirmDeleteId(null)}>
          <div className="w-80 rounded-xl border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">确认删除模型</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              删除后需要重新下载才能使用，确定要删除「{availableModels.find((m) => m.id === confirmDeleteId)?.name || confirmDeleteId}」吗？
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>取消</Button>
              <Button size="sm" variant="destructive" onClick={() => void handleDelete(confirmDeleteId)}>删除</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
