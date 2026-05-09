import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { AlertCircle, CheckCircle2, Download, FileArchive, Image as ImageIcon, RefreshCw, Send } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import {
  getDiagnosticsPreview,
  MAX_DIAGNOSTIC_IMAGES,
  MAX_DIAGNOSTIC_IMAGE_SIZE,
  submitDiagnostics,
  downloadDiagnostics,
  validateDiagnosticImages,
} from '@/services/diagnostics'
import { getWorkMode } from '@/services/transcription'
import { save } from '@tauri-apps/plugin-dialog'
import * as bridge from '@/services/bridge'
import type { DiagnosticOccurrence, DiagnosticsPreview } from '@/types/appApi'

const OCCURRENCE_OPTIONS: Array<{ value: DiagnosticOccurrence; label: string }> = [
  { value: 'within_1h', label: '1 小时内' },
  { value: 'today', label: '今天' },
  { value: 'older', label: '更早' },
]

interface DiagnosticsReportPanelProps {
  embedded?: boolean
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-2 last:border-b-0 last:pb-0 first:pt-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="max-w-[65%] break-all text-right text-sm text-foreground">{value}</span>
    </div>
  )
}

export default function DiagnosticsReportPanel({ embedded = false }: DiagnosticsReportPanelProps) {
  const [description, setDescription] = useState('')
  const [issueOccurrence, setIssueOccurrence] = useState<DiagnosticOccurrence>('within_1h')
  const [images, setImages] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'download_success' | 'error'>('idle')
  const [ticketId, setTicketId] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)

  const isServerMode = getWorkMode() === 'server'
  const imageValidation = useMemo(() => validateDiagnosticImages(images), [images])

  useEffect(() => {
    let cancelled = false

    const loadPreview = async () => {
      setLoadingPreview(true)
      try {
        const nextPreview = await getDiagnosticsPreview(issueOccurrence)
        if (!cancelled) setPreview(nextPreview)
      } catch (error) {
        if (!cancelled) setErrorMessage(String(error))
      } finally {
        if (!cancelled) setLoadingPreview(false)
      }
    }

    void loadPreview()

    return () => {
      cancelled = true
    }
  }, [issueOccurrence])

  const handleImageSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    const nextImages = [...images, ...files.filter((file) => file.type.startsWith('image/'))].slice(0, MAX_DIAGNOSTIC_IMAGES)
    setImages(nextImages)
    const validation = validateDiagnosticImages(nextImages)
    setErrorMessage(validation.valid ? '' : validation.errors[0])
  }

  const removeImage = (index: number) => {
    const nextImages = images.filter((_, imageIndex) => imageIndex !== index)
    setImages(nextImages)
    const validation = validateDiagnosticImages(nextImages)
    setErrorMessage(validation.valid ? '' : validation.errors[0])
  }

  const refreshPreview = async () => {
    setLoadingPreview(true)
    setErrorMessage('')
    try {
      setPreview(await getDiagnosticsPreview(issueOccurrence))
    } catch (error) {
      setErrorMessage(String(error))
    } finally {
      setLoadingPreview(false)
    }
  }

  const handleSubmit = async () => {
    if (!description.trim()) {
      setErrorMessage('请先描述问题现象和影响。')
      return
    }
    if (!imageValidation.valid) {
      setErrorMessage(imageValidation.errors[0] || '截图校验失败。')
      return
    }

    setSubmitting(true)
    setStatus('idle')
    setErrorMessage('')
    try {
      const ticket = await submitDiagnostics({
        description: description.trim(),
        issueOccurrence,
        images,
      })
      setTicketId(ticket)
      setStatus('success')
      setDescription('')
      setImages([])
    } catch (error) {
      setStatus('error')
      setErrorMessage(String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDownload = async () => {
    if (!description.trim()) {
      setErrorMessage('请先描述问题现象和影响。')
      return
    }
    if (!imageValidation.valid) {
      setErrorMessage(imageValidation.errors[0] || '截图校验失败。')
      return
    }

    setDownloading(true)
    setStatus('idle')
    setErrorMessage('')
    try {
      const zipPath = await downloadDiagnostics({
        description: description.trim(),
        issueOccurrence,
        images,
      })

      const dest = await save({
        defaultPath: `sayit-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: '诊断包', extensions: ['zip'] }],
      })

      if (!dest) {
        // 用户取消了保存对话框
        setDownloading(false)
        return
      }

      await bridge.copyDiagnosticsZip(zipPath, dest)
      setStatus('download_success')
      setDescription('')
      setImages([])
    } catch (error) {
      setStatus('error')
      setErrorMessage(String(error))
    } finally {
      setDownloading(false)
    }
  }

  const containerClassName = embedded ? '' : 'mx-auto max-w-4xl p-8'
  const busy = submitting || downloading
  const missingDescription = !description.trim()
  const downloadBtn = (
    <Button variant="outline" size="sm" disabled={busy || missingDescription} onClick={handleDownload}>
      <Download className="mr-2 h-4 w-4" />
      {downloading ? '正在打包...' : '下载诊断包'}
    </Button>
  )
  const sendBtn = isServerMode ? (
    <Button size="sm" disabled={busy || missingDescription} onClick={handleSubmit}>
      <Send className="mr-2 h-4 w-4" />
      {submitting ? '正在发送...' : '发送诊断'}
    </Button>
  ) : null

  return (
    <div className={containerClassName}>
      {!embedded && <h1 className="mb-6 text-2xl font-bold">诊断</h1>}

      <Card>
        <CardContent className="p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">问题反馈与诊断</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                提交问题描述、诊断摘要和相关截图，帮助我们更快定位问题。
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={refreshPreview} disabled={loadingPreview}>
              <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loadingPreview ? 'animate-spin' : ''}`} />
              刷新摘要
            </Button>
          </div>

          <div className="space-y-5">
            <div>
              <label className="mb-2 block text-sm font-medium">问题什么时候发生</label>
              <div className="flex flex-wrap gap-4">
                {OCCURRENCE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setIssueOccurrence(option.value)}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                      issueOccurrence === option.value ? 'border-foreground' : 'border-muted-foreground/40'
                    }`}>
                      <span className={`h-2.5 w-2.5 rounded-full ${
                        issueOccurrence === option.value ? 'bg-foreground' : 'bg-transparent'
                      }`} />
                    </span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">问题描述<span className="ml-0.5 text-red-500">*</span></label>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                placeholder={'请描述你做了什么、预期结果是什么、实际出现了什么。\n例如：按住说话后识别成功，但没有自动粘贴到 Teams、Outlook 或记事本。'}
                className="min-h-[56px] max-h-[240px] w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm leading-relaxed focus:border-input-focus-border focus:outline-none"
              />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="block text-sm font-medium">截图</label>
                <span className="text-xs text-muted-foreground">单张不超过 5MB，最多 {MAX_DIAGNOSTIC_IMAGES} 张</span>
              </div>

              {images.length > 0 && (
                <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {images.map((image, index) => (
                    <div key={`${image.name}-${index}`} className="group relative overflow-hidden rounded-md border bg-muted">
                      <img src={URL.createObjectURL(image)} alt={image.name} className="aspect-square w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeImage(index)}
                        className="absolute right-2 top-2 rounded-full bg-black/65 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        删除
                      </button>
                      <div className="truncate px-2 py-2 text-xs text-muted-foreground">{image.name}</div>
                    </div>
                  ))}
                </div>
              )}

              {images.length < MAX_DIAGNOSTIC_IMAGES && (
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border bg-muted px-4 py-3 text-sm transition-colors hover:border-muted-foreground/40 hover:bg-accent">
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">点击上传截图</span>
                  <input type="file" accept="image/*" multiple onChange={handleImageSelect} className="hidden" />
                </label>
              )}
            </div>

            <div className="rounded-md border border-border bg-muted p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
                <FileArchive className="h-4 w-4" />
                本次提交内容
              </div>

              {preview ? (
                <div className="rounded-md border border-border/50 bg-card p-4 shadow-sm">
                  <SummaryRow label="应用版本" value={preview.systemInfo.appVersion} />
                  <SummaryRow label="系统平台" value={preview.systemInfo.platform} />
                  <SummaryRow label="诊断时间" value={preview.generatedAt} />
                  <SummaryRow
                    label="时间范围"
                    value={OCCURRENCE_OPTIONS.find((option) => option.value === issueOccurrence)?.label || '1 小时内'}
                  />
                  <SummaryRow label="扫描日志文件" value={`${preview.filesScanned} 个`} />
                  <SummaryRow label="覆盖记录起点" value={preview.rangeStart || '暂无'} />
                  <SummaryRow label="覆盖记录终点" value={preview.rangeEnd || '暂无'} />
                  <SummaryRow label="截图数量" value={`${images.length} 张`} />
                  <SummaryRow
                    label="摘要内容"
                    value={`关键事件 ${preview.totalTimelineEntries} 条，错误 ${preview.summary.errors} 条，警告 ${preview.summary.warnings} 条`}
                  />
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {loadingPreview ? '正在整理诊断摘要...' : '暂时无法生成诊断摘要。'}
                </div>
              )}
            </div>

            {(errorMessage || !imageValidation.valid) && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="text-destructive">{errorMessage || imageValidation.errors[0]}</div>
              </div>
            )}

            {status === 'success' && (
              <div className="flex items-start gap-2 rounded-md bg-success/10 p-3 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <div>
                  <div className="font-medium text-success">诊断包已发送</div>
                  <div className="mt-1 text-xs text-success/80">工单号：{ticketId}</div>
                </div>
              </div>
            )}

            {status === 'download_success' && (
              <div className="flex items-start gap-2 rounded-md bg-success/10 p-3 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <div>
                  <div className="font-medium text-success">诊断包已保存</div>
                  <div className="mt-1 text-xs text-success/80">请将文件发送给技术支持人员。</div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setDescription('')
                  setImages([])
                  setStatus('idle')
                  setErrorMessage('')
                }}
              >
                清空
              </Button>
              {missingDescription ? <Tooltip content="请先填写问题描述">{downloadBtn}</Tooltip> : downloadBtn}
              {sendBtn && (missingDescription ? <Tooltip content="请先填写问题描述">{sendBtn}</Tooltip> : sendBtn)}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 text-xs text-muted-foreground">
        当前截图校验状态：{imageValidation.valid ? '通过' : imageValidation.errors[0] || '未通过'}。单张上限 {(MAX_DIAGNOSTIC_IMAGE_SIZE / 1024 / 1024).toFixed(0)}MB。
      </div>
    </div>
  )
}
