import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trash2, ChevronDown, ChevronUp, VolumeX, Star, Play, Pause, RotateCcw, Loader2, Download, Check, Copy, X, FolderOpen } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { Card, CardContent } from '@/components/ui/card'
import { type HistoryRecord } from '@/services/store'
import * as bridge from '@/services/bridge'
import { pickVoiceDurationSec } from '@/services/timeModel'
import { loadAudioAsDataUrl } from '@/services/audioFileService'
import { invoke } from '@tauri-apps/api/core'

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
  emptyText?: string
}

function getDayLabel(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const recordDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const dateStr = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
  if (recordDay.getTime() === today.getTime()) return `今天 · ${dateStr}`
  if (recordDay.getTime() === yesterday.getTime()) return `昨天 · ${dateStr}`
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function HistoryItem({
  record,
  onDelete,
  onToggleFavorite,
  onReprocess,
}: {
  record: HistoryRecord
  onDelete: () => void
  onToggleFavorite?: (nextFavorite: boolean) => void
  onReprocess?: () => Promise<void> | void
}) {
  const [expanded, setExpanded] = useState(false)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioLoading, setAudioLoading] = useState(false)
  const [reprocessing, setReprocessing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [downloadPath, setDownloadPath] = useState('')
  const [copied, setCopied] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [audioReady, setAudioReady] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string>('')
  const rafRef = useRef<number>(0)

  const text = record.llmText || record.asrText
  const isEmpty = record.isEmpty || (!text && record.charCount === 0)
  const voiceDurationSec = pickVoiceDurationSec({
    holdSec: record.durationSec,
    audioSec: record.audioDurationSec,
    asrSec: record.asrDurationSec,
  })

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = ''
      }
    }
  }, [])

  // Sync time via requestAnimationFrame for smooth progress
  useEffect(() => {
    function tick() {
      if (audioRef.current) {
        setCurrentTime(audioRef.current.currentTime)
      }
      if (audioPlaying) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    if (audioPlaying) {
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => cancelAnimationFrame(rafRef.current)
  }, [audioPlaying])

  const handleTogglePlayback = useCallback(async () => {
    if (!record.audioFilePath) return

    // If already playing, pause
    if (audioRef.current && audioPlaying) {
      audioRef.current.pause()
      setAudioPlaying(false)
      return
    }

    // If we have an audio element ready, resume
    if (audioRef.current && audioUrlRef.current) {
      audioRef.current.playbackRate = playbackRate
      await audioRef.current.play()
      setAudioPlaying(true)
      return
    }

    // Load audio file
    setAudioLoading(true)
    try {
      const dataUrl = await loadAudioAsDataUrl(record.audioFilePath)
      if (!dataUrl) {
        setAudioLoading(false)
        return
      }
      const audio = new Audio(dataUrl)
      audioRef.current = audio
      audioUrlRef.current = dataUrl
      audio.playbackRate = playbackRate
      audio.onloadedmetadata = () => {
        setDuration(audio.duration)
        setAudioReady(true)
      }
      audio.onended = () => {
        setAudioPlaying(false)
        setCurrentTime(0)
      }
      audio.onpause = () => setAudioPlaying(false)
      audio.onplay = () => setAudioPlaying(true)
      await audio.play()
    } catch {
      // ignore playback errors
    } finally {
      setAudioLoading(false)
    }
  }, [record.audioFilePath, audioPlaying, playbackRate])

  const handleReprocess = useCallback(async () => {
    if (!onReprocess || reprocessing) return
    setReprocessing(true)
    try {
      await onReprocess()
    } finally {
      setReprocessing(false)
    }
  }, [onReprocess, reprocessing])

  const handleDownloadAudio = useCallback(async () => {
    if (!record.audioFilePath || downloading) return
    setDownloading(true)
    setDownloadStatus('idle')
    setDownloadPath('')
    try {
      const dataUrl = await loadAudioAsDataUrl(record.audioFilePath)
      if (!dataUrl) {
        setDownloadStatus('fail')
        setDownloadPath('音频文件不存在')
        setTimeout(() => setDownloadStatus('idle'), 3000)
        return
      }

      const ts = new Date(record.timestamp)
      const dateStr = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`
      const filename = `sayit_${dateStr}.wav`

      // Extract base64 from data URL
      const base64Data = dataUrl.split(',')[1]
      const savedPath = await invoke<string>('save_audio_to_downloads', {
        base64Data,
        filename,
      })

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

  const handleSeek = useCallback((value: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = value
      setCurrentTime(value)
    }
  }, [])

  const handleRateChange = useCallback((rate: number) => {
    setPlaybackRate(rate)
    if (audioRef.current) {
      audioRef.current.playbackRate = rate
    }
  }, [])

  const formatElapsed = (value: number) => {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0
    const m = Math.floor(safe / 60)
    const s = Math.floor(safe % 60)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0

  return (
    <div className="group rounded-md transition-colors hover:bg-accent/50">
      <div className="flex items-start gap-2 px-2 py-2">
        <span className="w-12 shrink-0 pt-0.5 text-xs text-muted-foreground">
          {formatTime(record.timestamp)}
        </span>

        <div className="min-w-0 flex-1">
          {isEmpty ? (
            <div className="flex items-center gap-2">
              <VolumeX className="h-3.5 w-3.5 text-muted-foreground/40" />
              <p className="text-sm italic text-muted-foreground/60">无有效声音</p>
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
              {text.includes('\n') ? (
                text.split(/\n{2,}/).map((para, idx) => (
                  <p key={idx} className={idx > 0 ? 'mt-1.5' : undefined}>{para}</p>
                ))
              ) : (
                <p>{text}</p>
              )}
            </div>
          )}

          <div
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
          >
            <div className="overflow-hidden">
              {(expanded || true) && (
                <div className="mt-2 space-y-2 text-xs">
              {!isEmpty && record.asrText && (
                <div className="text-muted-foreground">
                  <span className="font-medium">ASR 原文：</span>
                  <span className="whitespace-pre-line">{record.asrText}</span>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                {record.workMode && (
                  <>
                    <span className="rounded border border-border px-1.5 py-0.5 text-xs">
                      {record.workMode === 'server' ? '服务器' : record.workMode === 'cloud_api' ? '云 API' : '本地'}
                    </span>
                    {record.asrProvider && (
                      <span className="text-xs">ASR: {ASR_PROVIDER_DISPLAY[record.asrProvider] || record.asrProvider}</span>
                    )}
                    {record.aiProvider && record.aiProvider !== 'server' && record.llmText && record.llmText !== record.asrText && (
                      <span className="text-xs">
                        AI: {record.aiProvider}{record.aiModel ? ` (${record.aiModel})` : ''}
                      </span>
                    )}
                    <span className="text-border">|</span>
                  </>
                )}
                <span>语音长度 {voiceDurationSec.toFixed(1)}s</span>
                <span className="text-border">|</span>
                <span>识别 {((record.asrMs + record.llmMs) / 1000).toFixed(1)}s (ASR {record.asrMs}ms + LLM {record.llmMs}ms)</span>
                {record.audioFilePath && (
                  <Tooltip content={audioPlaying ? '暂停播放' : '播放录音'}>
                    <button
                      type="button"
                      onClick={() => { void handleTogglePlayback() }}
                      disabled={audioLoading}
                      className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                      aria-label={audioPlaying ? '暂停播放' : '播放录音'}
                    >
                      {audioLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : audioPlaying ? (
                        <Pause className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <Play className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                  </Tooltip>
                )}
                {record.audioFilePath && (
                  <Tooltip content={downloadStatus === 'ok' ? `已保存到 ${downloadPath}` : downloadStatus === 'fail' ? `下载失败: ${downloadPath}` : '下载音频'}>
                    <button
                      type="button"
                      onClick={() => { void handleDownloadAudio() }}
                      disabled={downloading}
                      className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                      aria-label="下载音频"
                    >
                      {downloading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : downloadStatus === 'ok' ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : downloadStatus === 'fail' ? (
                        <X className="h-3.5 w-3.5 text-destructive" />
                      ) : (
                        <Download className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                  </Tooltip>
                )}
                {record.audioFilePath && onReprocess && (
                  <Tooltip content="重新识别">
                    <button
                      type="button"
                      onClick={() => { void handleReprocess() }}
                      disabled={reprocessing}
                      className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                      aria-label="重新识别"
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
              {downloadStatus === 'ok' && downloadPath && (
                <div className="mt-1 flex items-center gap-2 text-xs text-success break-all">
                  <span className="min-w-0 truncate">已保存到 {downloadPath}</span>
                  <button
                    onClick={() => void invoke('reveal_file_in_folder', { filePath: downloadPath })}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="打开文件所在目录"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {downloadStatus === 'fail' && downloadPath && (
                <div className="mt-1 text-xs text-destructive break-all">
                  下载失败: {downloadPath}
                </div>
              )}
              {/* 音频进度条 + 倍速 */}
              {audioReady && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="w-[72px] shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatElapsed(currentTime)} / {formatElapsed(duration)}
                  </span>
                  <div className="relative h-3 min-w-0 flex-1 overflow-visible">
                    <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                    <div className="absolute left-0 top-1/2 h-px -translate-y-1/2 bg-foreground" style={{ width: `${progress * 100}%` }} />
                    <div
                      className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground bg-card shadow-sm"
                      style={{ left: `${progress * 100}%` }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(duration, 0.1)}
                      step={0.1}
                      value={Math.min(currentTime, duration || 0)}
                      onChange={(e) => handleSeek(Number(e.target.value))}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    {[0.75, 1, 1.5, 2, 2.5].map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => handleRateChange(rate)}
                        className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                          playbackRate === rate
                            ? 'bg-foreground text-background font-medium'
                            : 'text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {!isEmpty && (
            <Tooltip content={copied ? '已复制' : '复制文本'} forceVisible={copied}>
              <button
                onClick={() => {
                  void bridge.copyText(text).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
                className="inline-flex items-center rounded p-1 transition-colors hover:bg-accent"
                aria-label="复制"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            </Tooltip>
          )}

          {onToggleFavorite && (
            <Tooltip content={record.favorite ? '取消收藏' : '收藏'}>
              <button
                onClick={() => onToggleFavorite(!record.favorite)}
                className="rounded p-1 hover:bg-accent"
                aria-label={record.favorite ? '取消收藏' : '收藏'}
              >
                <Star className={`h-3.5 w-3.5 ${record.favorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
              </button>
            </Tooltip>
          )}

          <Tooltip content={expanded ? '收起详情' : '展开详情'}>
            <button 
              onClick={() => setExpanded(!expanded)} 
              className="rounded p-1 hover:bg-accent" 
              aria-label="详情"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
          </Tooltip>
          <Tooltip content="删除记录">
            <button 
              onClick={onDelete} 
              className="rounded p-1 hover:bg-accent" 
              aria-label="删除"
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

function DayGroup({
  label,
  records,
  onDelete,
  onToggleFavorite,
  onReprocess,
}: {
  label: string
  records: HistoryRecord[]
  onDelete: (id: string) => void
  onToggleFavorite?: (id: string, nextFavorite: boolean) => Promise<void> | void
  onReprocess?: (record: HistoryRecord) => Promise<void> | void
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
  emptyText = '还没有记录，去语音工作台试试吧',
}: HistoryRecordListProps) {
  const grouped = useMemo(() => {
    return records.reduce((acc, record) => {
      const label = getDayLabel(record.timestamp)
      if (!acc[label]) acc[label] = []
      acc[label].push(record)
      return acc
    }, {} as Record<string, HistoryRecord[]>)
  }, [records])

  const sortedDays = useMemo(() => {
    return Object.keys(grouped).sort((a, b) => {
      const aIsToday = a.startsWith('今天')
      const bIsToday = b.startsWith('今天')
      const aIsYesterday = a.startsWith('昨天')
      const bIsYesterday = b.startsWith('昨天')
      if (aIsToday) return -1
      if (bIsToday) return 1
      if (aIsYesterday) return -1
      if (bIsYesterday) return 1
      return b.localeCompare(a)
    })
  }, [grouped])

  if (records.length === 0) {
    return <p className="py-12 text-center text-muted-foreground">{emptyText}</p>
  }

  return (
    <div className="space-y-3">
      {sortedDays.map((day) => (
        <DayGroup
          key={day}
          label={day}
          records={grouped[day]}
          onDelete={onDelete}
          onToggleFavorite={onToggleFavorite}
          onReprocess={onReprocess}
        />
      ))}
    </div>
  )
}
