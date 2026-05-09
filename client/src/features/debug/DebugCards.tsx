import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Download, Keyboard, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  getSessionAudioBlob,
  type DebugMessage,
  type DebugSession,
  type RuntimeEvent,
} from '@/services/debugLog'
import {
  formatMs,
  formatTime,
  getPTTBadgeTone,
  getPTTLabel,
  getSessionDurationBytes,
  joinPCMChunks,
  resolveSessionSampleRate,
  summarizeMessage,
} from './debugUtils'
import { type PTTHoldPair, type PTTTimelineEvent } from './types'

export function AudioPlayer({ session }: { session: DebugSession }) {
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState('')
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)

  const sampleRate = resolveSessionSampleRate(session)
  const totalBytes = getSessionDurationBytes(session)
  const durationSec = Math.floor(totalBytes / 2) / sampleRate

  const stopPlayback = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.onended = null
        sourceRef.current.stop(0)
      } catch {
        // ignore
      }
      try {
        sourceRef.current.disconnect()
      } catch {
        // ignore
      }
      sourceRef.current = null
    }

    if (audioCtxRef.current) {
      const context = audioCtxRef.current
      audioCtxRef.current = null
      void context.close().catch(() => {})
    }

    setPlaying(false)
  }, [])

  const handlePlay = useCallback(async (event: MouseEvent) => {
    event.stopPropagation()

    if (playing) {
      stopPlayback()
      return
    }

    setError('')

    const pcm = joinPCMChunks(session.audioChunks)
    if (!pcm || pcm.length === 0) {
      setError('当前会话没有可回放音频')
      return
    }

    stopPlayback()

    try {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioCtx) {
        setError('当前环境不支持音频回放')
        return
      }

      const context = new AudioCtx()
      audioCtxRef.current = context
      if (context.state === 'suspended') {
        await context.resume()
      }

      const audioBuffer = context.createBuffer(1, pcm.length, sampleRate)
      const channel = audioBuffer.getChannelData(0)
      for (let index = 0; index < pcm.length; index++) {
        channel[index] = pcm[index] / 32768
      }

      const source = context.createBufferSource()
      source.buffer = audioBuffer
      source.connect(context.destination)
      source.onended = () => {
        if (sourceRef.current === source) {
          sourceRef.current = null
        }
        if (audioCtxRef.current === context) {
          audioCtxRef.current = null
          void context.close().catch(() => {})
        }
        setPlaying(false)
      }
      sourceRef.current = source
      source.start(0)
      setPlaying(true)
    } catch (err) {
      stopPlayback()
      setError(`播放失败: ${String(err)}`)
    }
  }, [playing, sampleRate, session.audioChunks, stopPlayback])

  const handleDownload = useCallback((event: MouseEvent) => {
    event.stopPropagation()

    const blob = getSessionAudioBlob(session)
    if (!blob) {
      setError('当前会话没有可下载音频')
      return
    }

    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `sayit-debug-${session.id}.wav`
    anchor.click()
    URL.revokeObjectURL(objectUrl)
  }, [session])

  useEffect(() => {
    return () => {
      stopPlayback()
    }
  }, [stopPlayback])

  if (totalBytes === 0) {
    return <span className="text-xs text-muted-foreground/50">无音频</span>
  }

  return (
    <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
      <Button onClick={handlePlay} variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
        {playing ? <Square className="h-3 w-3 text-destructive" /> : <Play className="h-3 w-3 text-success" />}
        <span>{playing ? '停止' : '回放'} ({durationSec.toFixed(1)}s)</span>
      </Button>

      <Button onClick={handleDownload} variant="outline" size="sm" className="h-7 px-2">
        <Download className="h-3 w-3" />
      </Button>

      {error && (
        <span className="max-w-[260px] truncate text-xs text-destructive" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}

export function LogItem({ msg }: { msg: DebugMessage }) {
  const [expanded, setExpanded] = useState(false)
  const isSent = msg.direction === 'sent'

  return (
    <div className="rounded border bg-card px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${isSent ? 'bg-info/15 text-info' : 'bg-success/15 text-success'}`}>
            {isSent ? '发送' : '接收'}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">{msg.type}</span>
          <span className="text-muted-foreground/60">{formatTime(msg.time)}</span>
          <span className="truncate text-muted-foreground">{summarizeMessage(msg)}</span>
        </div>

        <button onClick={() => setExpanded((value) => !value)} className="rounded p-0.5 hover:bg-accent">
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>

      {expanded && (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
          {JSON.stringify(msg.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function RuntimeItem({ event }: { event: RuntimeEvent }) {
  const tone = event.level === 'error'
    ? 'border-destructive/20 bg-destructive/10 text-destructive'
    : event.level === 'warn'
      ? 'border-warning/20 bg-warning/10 text-warning'
      : 'border-border bg-muted text-muted-foreground'

  return (
    <div className={`rounded border px-2 py-1.5 text-xs ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded border bg-card px-1.5 py-0.5 text-xs font-medium uppercase">{event.level}</span>
          <span className="truncate font-medium">{event.source}</span>
          <span className="truncate">{event.message}</span>
        </div>
        <span className="shrink-0 text-xs opacity-80">{formatTime(event.time)}</span>
      </div>
      {Boolean(event.detail) && (
        <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-card/70 p-1.5 text-xs">
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function PTTTimelineCard({
  pttEvents,
  holdPairs,
}: {
  pttEvents: PTTTimelineEvent[]
  holdPairs: PTTHoldPair[]
}) {
  const downCount = pttEvents.filter((event) => event.kind === 'down').length
  const upCount = pttEvents.filter((event) => event.kind === 'up').length
  const matchedCount = holdPairs.filter((pair) => Number.isFinite(pair.holdMs)).length
  const danglingCount = holdPairs.filter((pair) => !pair.up).length

  return (
    <Card className="mb-4 border-info/30">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-info">
            <Keyboard className="h-4 w-4" />
            <span className="text-sm font-medium">PTT 事件时间线</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>down {downCount}</span>
            <span>up {upCount}</span>
            <span>配对 {matchedCount}</span>
            <span className={danglingCount > 0 ? 'text-warning' : ''}>未释放 {danglingCount}</span>
          </div>
        </div>

        <div className="overflow-x-auto rounded border bg-muted p-2">
          <div className="flex min-w-max items-center gap-1.5">
            {pttEvents.map((event, index) => {
              const previous = index > 0 ? pttEvents[index - 1] : null
              const deltaMs = previous ? Math.max(0, event.time - previous.time) : 0

              return (
                <div key={`${event.time}-${index}`} className="flex items-center gap-1.5">
                  <div className={`rounded border px-2 py-1 text-xs font-medium ${getPTTBadgeTone(event.kind)}`}>
                    <div>{getPTTLabel(event.kind)}</div>
                    <div className="font-normal opacity-80">{formatTime(event.time)}</div>
                  </div>
                  {previous && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      +{formatMs(deltaMs)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="max-h-40 space-y-1 overflow-auto rounded border bg-card p-2">
          {pttEvents
            .slice()
            .reverse()
            .map((event, index) => (
              <div key={`${event.time}-${index}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs">
                <div className="min-w-0 truncate">
                  <span className="font-medium text-foreground">{getPTTLabel(event.kind)}</span>
                  <span className="mx-1 text-muted-foreground/50">·</span>
                  <span className="text-muted-foreground">{event.reason}</span>
                  {typeof event.keycode === 'number' && (
                    <span className="ml-2 text-muted-foreground/70">keycode={event.keycode}</span>
                  )}
                  {event.pttSetting && (
                    <span className="ml-2 text-muted-foreground/70">{event.pttSetting}</span>
                  )}
                </div>
                <span className="shrink-0 text-muted-foreground/60">{formatTime(event.time)}</span>
              </div>
            ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function IssueRuntimeEventsCard({ events }: { events: RuntimeEvent[] }) {
  if (events.length === 0) return null

  return (
    <Card className="mb-4 border-warning/30">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm font-medium">运行时异常 / 警告</span>
            <span className="text-xs">{events.length}</span>
          </div>
        </div>
        <div className="max-h-56 space-y-1.5 overflow-auto">
          {events.map((event, index) => (
            <RuntimeItem key={`${event.time}-${index}`} event={event} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
