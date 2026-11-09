import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trash2, VolumeX, Star, Play, Pause, RotateCcw, Loader2, Download, Copy, X, FolderOpen, Pencil, ChevronDown, ChevronUp, SpellCheck } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { SuccessCheck } from '@/components/ui/success-check'
import { Card, CardContent } from '@/components/ui/card'
import { type HistoryRecord } from '@/services/store'
import * as bridge from '@/services/bridge'
import { pickVoiceDurationSec } from '@/services/timeModel'
import { invoke } from '@tauri-apps/api/core'
import { getLocale, t } from '@/i18n'
import { useT } from '@/i18n/useT'
import { historyFailureReasonDisplay } from '@/i18n/displayNames'
import { errorDetailText } from '@/lib/errorMessages'
import { addRuntimeEvent } from '@/services/debugLog'
import { useRecordingPlayback } from './useRecordingPlayback'
import { AudioProgressBar } from './AudioProgressBar'
import { AsrCorrectionDialog } from './AsrCorrectionDialog'
import { groupByDay } from './dayGroups'

/** 云 API 内部 key → 用户友好的模型 ID */
const ASR_PROVIDER_DISPLAY: Record<string, string> = {
  doubao_v2: 'Doubao-Seed-ASR-2.0',
  doubao: 'Doubao-Seed-ASR',
  qwen: 'qwen3-asr-flash',
  qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
  qwen_omni_flash: 'qwen3-omni-flash-realtime',
  qwen_omni_turbo: 'qwen-omni-turbo-realtime',
  qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
}

interface HistoryRecordListProps {
  records: HistoryRecord[]
  onDelete: (id: string) => Promise<void> | void
  onToggleFavorite?: (id: string, nextFavorite: boolean) => Promise<void> | void
  onReprocess?: (record: HistoryRecord) => Promise<void> | void
  /** 手工编辑转换结果并保存 */
  onEdit?: (id: string, nextText: string) => Promise<void> | void
  /** 记下「这条的 ASR 纠错已提交/已撤回」，由页面写回本地记录 */
  onSaveAsrCorrection?: (id: string, patch: Partial<HistoryRecord>) => Promise<void> | void
  emptyText?: string
  /** 搜索关键词：在正文与 ASR 原文里高亮命中处 */
  highlight?: string
}

function getDayLabel(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const recordDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  // 日期格式跟界面语言：英文界面下 "August 4" 而不是 "8月4日"
  const dateStr = date.toLocaleDateString(getLocale(), { month: 'long', day: 'numeric' })
  if (recordDay.getTime() === today.getTime()) return t('record.dayPrefix', { day: t('record.today'), date: dateStr })
  if (recordDay.getTime() === yesterday.getTime()) return t('record.dayPrefix', { day: t('record.yesterday'), date: dateStr })
  return date.toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
}

/** 把 text 中命中 keyword 的子串用 <mark> 高亮（大小写不敏感，用 indexOf 避免正则特殊字符问题）。 */
function highlightText(text: string, keyword: string) {
  const kw = keyword.trim()
  if (!kw) return text
  const lower = text.toLowerCase()
  const kwLower = kw.toLowerCase()
  const parts: Array<string | JSX.Element> = []
  let from = 0
  let idx = lower.indexOf(kwLower, from)
  let key = 0
  while (idx !== -1) {
    if (idx > from) parts.push(text.slice(from, idx))
    parts.push(
      <mark key={key++} className="rounded-sm bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-500/30">
        {text.slice(idx, idx + kw.length)}
      </mark>,
    )
    from = idx + kw.length
    idx = lower.indexOf(kwLower, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

function HistoryItem({
  record,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  onSaveAsrCorrection,
  highlight = '',
}: {
  record: HistoryRecord
  onDelete: () => void
  onToggleFavorite?: (nextFavorite: boolean) => void
  onReprocess?: () => Promise<void> | void
  onEdit?: (nextText: string) => Promise<void> | void
  onSaveAsrCorrection?: (patch: Partial<HistoryRecord>) => Promise<void> | void
  highlight?: string
}) {
  // 详情区靠**点「展开详情」按钮**开合，不用 hover。
  //
  // 曾经改成过鼠标悬停展开（进入停留 160ms 才开、离开延迟 180ms 才收，编辑/播放/
  // 键盘焦点时粘滞不收）。那套逻辑本身是能用的，但被撤掉了：hover 展开意味着
  // 光标只是路过列表，行高就会变化，读一屏历史时整个列表始终在动；而"展开某条看细节"
  // 本来就是个明确的意图，值得用户点一下。
  // 别再改回 hover —— 那条路已经走过一次了。
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [reprocessing, setReprocessing] = useState(false)
  const [reprocessError, setReprocessError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [downloadPath, setDownloadPath] = useState('')
  const [copied, setCopied] = useState(false)
  const [correcting, setCorrecting] = useState(false)
  const playback = useRecordingPlayback(record.audioFilePath)

  const text = record.llmText || record.asrText
  const isEmpty = record.isEmpty || (!text && record.charCount === 0)
  const voiceDurationSec = pickVoiceDurationSec({
    holdSec: record.durationSec,
    audioSec: record.audioDurationSec,
    asrSec: record.asrDurationSec,
  })

  /**
   * 「纠正识别」入口的门槛。
   *
   * 只有服务器模式：只有服务器上的模型是我们能改的，云 API / 本地模型认错了，
   * 把用户音频收上来既没用又是一次隐私意外（见 .kiro/decisions.md）。
   * 必须有录音路径：没有音频的纠正对改进识别没有用。路径存在但文件已被保留期清掉
   * 这种情况留给面板去说明 —— 列表渲染时不该为每一行去摸一次磁盘。
   */
  const canCorrectAsr = Boolean(
    onSaveAsrCorrection && record.workMode === 'server' && record.asrText && !isEmpty && record.audioFilePath,
  )
  const asrCorrectionSubmitted = Boolean(record.asrCorrectionId)

  const handleReprocess = useCallback(async () => {
    if (!onReprocess || reprocessing) return
    setReprocessing(true)
    setReprocessError('')
    try {
      await onReprocess()
    } catch (error) {
      // 原来没有 catch：失败只在日志里留一行 Unhandled promise rejection，按钮转完就没下文，
      // 用户以为点了没反应（2026-10-19 本地模型把显卡跑挂那次，连着点了十来次）。
      const reason = errorDetailText(error)
      setReprocessError(reason)
      addRuntimeEvent('warn', 'history', 'Transcribe again failed', { recordId: record.id, error: reason })
    } finally {
      setReprocessing(false)
    }
  }, [onReprocess, reprocessing, record.id])

  // ── 编辑：自动保存（失焦 / 离开页面即存，无需按钮）──
  // 用 ref 保存最新值，供失焦回调与卸载清理读取，避免闭包拿到旧值。
  const editTextRef = useRef('')
  const editingRef = useRef(false)
  const textRef = useRef(text)
  const onEditRef = useRef(onEdit)
  textRef.current = text
  onEditRef.current = onEdit

  const startEdit = useCallback(() => {
    editTextRef.current = text
    editingRef.current = true
    setEditText(text)
    setEditing(true)
  }, [text])

  // 提交：仅当仍在编辑且内容有变化时写回。幂等——重复调用（失焦后又卸载）不会重复保存。
  const commitEdit = useCallback(async () => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    const next = editTextRef.current
    if (!onEditRef.current || next === textRef.current) return
    await onEditRef.current(next)
  }, [])

  // 取消：不保存，直接退出（后续失焦/卸载因 editingRef=false 而跳过）。
  const cancelEdit = useCallback(() => {
    editingRef.current = false
    setEditing(false)
  }, [])

  // 离开页面（组件卸载）时若仍在编辑，自动保存。
  useEffect(() => () => { void commitEdit() }, [commitEdit])

  const handleDownloadAudio = useCallback(async () => {
    if (!record.audioFilePath || downloading) return
    setDownloading(true)
    setDownloadStatus('idle')
    setDownloadPath('')
    try {
      if (!(await bridge.audioFileExists(record.audioFilePath))) {
        setDownloadStatus('fail')
        setDownloadPath(t('record.audioMissing'))
        setTimeout(() => setDownloadStatus('idle'), 3000)
        return
      }

      const ts = new Date(record.timestamp)
      const dateStr = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`
      const filename = `sayit_${dateStr}.wav`

      // Rust 直接复制文件，不再把整段录音读成 base64 再发回去
      const savedPath = await bridge.saveRecordingToDownloads(record.audioFilePath, filename)

      setDownloadStatus('ok')
      setDownloadPath(savedPath)
      setTimeout(() => setDownloadStatus('idle'), 5000)
    } catch (err) {
      setDownloadStatus('fail')
      setDownloadPath(String(err))
      setTimeout(() => setDownloadStatus('idle'), 3000)
    } finally {
      setDownloading(false)
    }
  }, [record.audioFilePath, record.timestamp, downloading])

  const open = expanded

  return (
    <div
      className="group rounded-md transition-colors hover:bg-accent/50"
      // 关掉滚动锚定：Chromium 默认会在行高变化时自动调 scrollTop 去"稳住"某个锚点元素，
      // 锚点若落在展开行下方，补偿的结果就是内容（含你刚点开的这行）往上蹿 ——
      // 表现为"有时往上、有时往下，挤来挤去"。关掉之后展开一律向下推，行为可预期。
      style={{ overflowAnchor: 'none' }}
    >
      <div className="flex items-start gap-2 px-2 py-2">
        <span className="w-12 shrink-0 pt-0.5 text-xs text-muted-foreground">
          {formatTime(record.timestamp)}
        </span>

        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-2">
          <div className="min-w-0">
            {editing ? (
              <div onClick={(e) => e.stopPropagation()}>
                <textarea
                  value={editText}
                  onChange={(e) => { setEditText(e.target.value); editTextRef.current = e.target.value }}
                  autoFocus
                  rows={Math.min(Math.max(editText.split('\n').length, 2), 12)}
                  className="w-full resize-y rounded-md border border-input-border bg-input-bg px-2.5 py-1.5 text-sm leading-relaxed focus:border-input-focus-border focus:outline-none"
                  onBlur={() => { void commitEdit() }}
                  onKeyDown={(e) => {
                    // Esc 取消（不保存）；Ctrl/Cmd+Enter 立即保存（失焦触发提交）
                    if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() }
                  }}
                />
                <span className="mt-1 inline-block text-[11px] text-muted-foreground/50">{t('record.editHint')}</span>
              </div>
            ) : isEmpty ? (
              <div className="flex items-center gap-2">
                <VolumeX className="h-3.5 w-3.5 text-muted-foreground/40" />
                <p className="text-sm italic text-muted-foreground/60">{t('record.noSpeech')}</p>
              </div>
            ) : (
              <div
                className="cursor-pointer text-sm leading-relaxed text-foreground/75 select-text transition-colors hover:text-foreground"
                onClick={() => {
                  const selection = window.getSelection()
                  if (selection && selection.toString().trim()) return
                  void bridge.copyText(text).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
              >
                {(() => {
                  // 编辑过的记录：在正文末尾内联一个小铅笔图标（hover 提示「已编辑」），不占额外行、不混入正文文本
                  const editedMark = record.manualEditedAt ? (
                    <Tooltip content={t('record.edited')}>
                      <Pencil className="ml-1 inline-block h-3 w-3 translate-y-[1px] text-muted-foreground/40" />
                    </Tooltip>
                  ) : null
                  if (text.includes('\n')) {
                    const paras = text.split(/\n{2,}/)
                    return paras.map((para, idx) => (
                      <p key={idx} className={idx > 0 ? 'mt-1.5' : undefined}>
                        {highlightText(para, highlight)}
                        {idx === paras.length - 1 && editedMark}
                      </p>
                    ))
                  }
                  return <p>{highlightText(text, highlight)}{editedMark}</p>
                })()}
              </div>
            )}
          </div>

          <div className={`flex h-fit shrink-0 self-start gap-0.5 transition-opacity group-hover:opacity-100 ${open ? 'opacity-100' : 'opacity-0'}`}>
            {!isEmpty && (
              <Tooltip content={copied ? t('record.copied') : t('record.copyText')} forceVisible={copied}>
                <button
                  onClick={() => {
                    void bridge.copyText(text).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    })
                  }}
                  className="inline-flex items-center rounded p-1 transition-colors hover:bg-accent"
                  aria-label={t('record.copy')}
                >
                  {copied ? (
                    <SuccessCheck className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              </Tooltip>
            )}

            {onToggleFavorite && (
              <Tooltip content={record.favorite ? t('record.unfavorite') : t('record.favorite')}>
                <button
                  onClick={() => onToggleFavorite(!record.favorite)}
                  className="rounded p-1 hover:bg-accent"
                  aria-label={record.favorite ? t('record.unfavorite') : t('record.favorite')}
                >
                  <Star className={`h-3.5 w-3.5 ${record.favorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
                </button>
              </Tooltip>
            )}

            <Tooltip content={expanded ? t('record.collapse') : t('record.expand')}>
              <button
                onClick={() => setExpanded(!expanded)}
                className="rounded p-1 hover:bg-accent"
                aria-label={t('record.details')}
                aria-expanded={expanded}
              >
                {expanded
                  ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                  : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            </Tooltip>

            <Tooltip content={t('record.deleteRecord')}>
              <button
                onClick={onDelete}
                className="rounded p-1 hover:bg-accent"
                aria-label={t('record.delete')}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </button>
            </Tooltip>
          </div>

          {/* 展开动画：grid 0fr→1fr，200ms ease-out。中途试过实测高度 + 自定义曲线 +
              内容淡入位移，叠得越多反而越碎，已经撤掉，别再往上加。 */}
          <div
            className="col-span-2 grid grid-cols-subgrid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
            style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
            aria-hidden={!open}
          >
            <div className="col-span-2 grid grid-cols-subgrid overflow-hidden">
              <div className="col-span-2 mt-2 grid grid-cols-subgrid gap-y-2 text-xs">
                {/* 空结果的成因。折叠行只能显示「无有效声音」，真实原因（额度耗尽、
                    资源未开通、服务端断连、文本处理清空）放这里。老记录没有这个字段。 */}
                {isEmpty && (record.failReasonCode || record.failReason) && (
                  <div className="col-span-2 text-muted-foreground">
                    <span className="font-medium">{t('record.reasonLabel')}</span>
                    <span className="whitespace-pre-line break-words">{historyFailureReasonDisplay(record)}</span>
                  </div>
                )}
                {!isEmpty && record.asrText && (
                  <div className="text-muted-foreground">
                    <span className="font-medium">{t('record.asrLabel')}</span>
                    <span className="whitespace-pre-line">{highlightText(record.asrText, highlight)}</span>
                  </div>
                )}
                <div className="col-span-2 flex flex-wrap items-center gap-2 text-muted-foreground">
                  {record.workMode && (
                    <>
                      <span className="rounded border border-border px-1.5 py-0.5 text-xs">
                        {record.workMode === 'server' ? t('record.modeServer') : record.workMode === 'cloud_api' ? t('record.modeCloudApi') : t('record.modeLocal')}
                      </span>
                      {record.asrProvider && (
                        <span className="text-xs">ASR: {ASR_PROVIDER_DISPLAY[record.asrProvider] || record.asrProvider}</span>
                      )}
                      {record.aiProvider && record.aiProvider !== 'server' && record.llmMs > 0 && (
                        <span className="text-xs">
                          AI: {record.aiProvider}{record.aiModel ? ` (${record.aiModel})` : ''}
                        </span>
                      )}
                      <span className="text-border">|</span>
                    </>
                  )}
                  <span>{t('record.voiceLength', { sec: voiceDurationSec.toFixed(1) })}</span>
                  <span className="text-border">|</span>
                  <span>{t('record.recognizeTime', { total: ((record.asrMs + record.llmMs) / 1000).toFixed(1), asr: record.asrMs, llm: record.llmMs })}</span>

                  {/* 四个操作按钮单独收成一组：它们原来和左边的文字共用外层的 gap-2(8px)，
                      按钮之间也就被撑到 8px，比右上角那排（gap-0.5）散得多。
                      这里组内用 gap-0.5 与上排统一，组与文字之间仍由外层的 gap-2 分隔。 */}
                  <div className="flex items-center gap-0.5">
                    {!isEmpty && onEdit && !editing && (
                      <Tooltip content={t('record.editText')}>
                        <button
                          type="button"
                          onClick={startEdit}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent"
                          aria-label={t('record.edit')}
                        >
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </Tooltip>
                    )}
                    {record.audioFilePath && (
                      <Tooltip content={playback.playing ? t('record.pause') : t('record.play')}>
                        <button
                          type="button"
                          onClick={() => { void playback.toggle() }}
                          disabled={playback.loading}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label={playback.playing ? t('record.pause') : t('record.play')}
                        >
                          {playback.loading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : playback.playing ? (
                            <Pause className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <Play className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                    {record.audioFilePath && (
                      <Tooltip content={downloadStatus === 'ok' ? t('record.savedTo', { path: downloadPath }) : downloadStatus === 'fail' ? t('record.downloadFailed', { path: downloadPath }) : t('record.downloadAudio')}>
                        <button
                          type="button"
                          onClick={() => { void handleDownloadAudio() }}
                          disabled={downloading}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label={t('record.downloadAudio')}
                        >
                          {downloading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : downloadStatus === 'ok' ? (
                            <SuccessCheck className="h-3.5 w-3.5 text-success" />
                          ) : downloadStatus === 'fail' ? (
                            <X className="h-3.5 w-3.5 text-destructive" />
                          ) : (
                            <Download className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                    {canCorrectAsr && (
                      <Tooltip content={asrCorrectionSubmitted ? t('asrCorrection.entrySubmitted') : t('asrCorrection.entry')}>
                        <button
                          type="button"
                          onClick={() => setCorrecting(true)}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent"
                          aria-label={asrCorrectionSubmitted ? t('asrCorrection.entrySubmitted') : t('asrCorrection.entry')}
                        >
                          <SpellCheck className={`h-3.5 w-3.5 ${asrCorrectionSubmitted ? 'text-success' : 'text-muted-foreground'}`} />
                        </button>
                      </Tooltip>
                    )}
                    {record.audioFilePath && onReprocess && (
                      <Tooltip content={t('record.reprocess')}>
                        <button
                          type="button"
                          onClick={() => { void handleReprocess() }}
                          disabled={reprocessing}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label={t('record.reprocess')}
                        >
                          {reprocessing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </div>
                {downloadStatus === 'ok' && downloadPath && (
                  <div className="col-span-2 mt-1 flex items-center gap-2 text-xs text-success break-all">
                    <span className="min-w-0 truncate">{t('record.savedTo', { path: downloadPath })}</span>
                    <button
                      onClick={() => void invoke('reveal_file_in_folder', { filePath: downloadPath })}
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={t('record.openFolder')}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {downloadStatus === 'fail' && downloadPath && (
                  <div className="col-span-2 mt-1 text-xs text-destructive break-all">
                    {t('record.downloadFailed', { path: downloadPath })}
                  </div>
                )}
                {reprocessError && !reprocessing && (
                  <div role="alert" className="col-span-2 mt-1 text-xs text-destructive break-all">
                    {t('record.reprocessFailed', { reason: reprocessError })}
                  </div>
                )}
                {/* 音频进度条 + 倍速 */}
                {playback.ready && <AudioProgressBar playback={playback} className="col-span-2 mt-2" />}
              </div>
            </div>
          </div>
        </div>
      </div>

      {correcting && onSaveAsrCorrection && (
        <AsrCorrectionDialog
          record={record}
          onClose={() => setCorrecting(false)}
          onSubmitted={(patch) => { void onSaveAsrCorrection(patch) }}
        />
      )}
    </div>
  )
}

function DayGroup({
  label,
  records,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  onSaveAsrCorrection,
  highlight,
}: {
  label: string
  records: HistoryRecord[]
  onDelete: (id: string) => void
  onToggleFavorite?: (id: string, nextFavorite: boolean) => Promise<void> | void
  onReprocess?: (record: HistoryRecord) => Promise<void> | void
  onEdit?: (id: string, nextText: string) => Promise<void> | void
  onSaveAsrCorrection?: (id: string, patch: Partial<HistoryRecord>) => Promise<void> | void
  highlight?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">{label}</h2>
        <div className="divide-y">
          {records.map((record) => (
            <HistoryItem
              key={record.id}
              record={record}
              onDelete={() => onDelete(record.id)}
              onToggleFavorite={onToggleFavorite ? (next) => onToggleFavorite(record.id, next) : undefined}
              onReprocess={onReprocess ? () => onReprocess(record) : undefined}
              onEdit={onEdit ? (nextText) => onEdit(record.id, nextText) : undefined}
              onSaveAsrCorrection={onSaveAsrCorrection ? (patch) => onSaveAsrCorrection(record.id, patch) : undefined}
              highlight={highlight}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default function HistoryRecordList({
  records,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  onSaveAsrCorrection,
  emptyText,
  highlight,
}: HistoryRecordListProps) {
  useT()
  // 默认值不能写在参数里：默认参数在模块作用域求值不了 t()，写死中文串又会在英文界面漏出来。
  const resolvedEmptyText = emptyText ?? t('history.empty')
  const dayGroups = useMemo(() => groupByDay(records, getDayLabel), [records])

  if (records.length === 0) {
    return <p className="py-12 text-center text-muted-foreground">{resolvedEmptyText}</p>
  }

  return (
    <div className="space-y-3">
      {dayGroups.map((group) => (
        <DayGroup
          key={group.dayStart}
          label={group.label}
          records={group.records}
          onDelete={onDelete}
          onToggleFavorite={onToggleFavorite}
          onReprocess={onReprocess}
          onEdit={onEdit}
          onSaveAsrCorrection={onSaveAsrCorrection}
          highlight={highlight}
        />
      ))}
    </div>
  )
}
