import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  clearRuntimeEvents,
  clearSessions,
  getRuntimeEvents,
  getSessions,
  type RuntimeEvent,
} from '@/services/debugLog'
import { IssueRuntimeEventsCard, PTTTimelineCard } from './DebugCards'
import SessionCard from './SessionCard'
import { buildPTTHoldPairs, parsePTTEvent } from './debugUtils'
import { type PTTTimelineEvent } from './types'

export default function DebugPage() {
  const [sessions, setSessions] = useState(getSessions)
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>(getRuntimeEvents)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const issueRuntimeEvents = useMemo(
    () => runtimeEvents.filter((event) => event.level !== 'info'),
    [runtimeEvents],
  )

  const pttEvents = useMemo(() => {
    return runtimeEvents
      .map((event) => parsePTTEvent(event))
      .filter((event): event is PTTTimelineEvent => Boolean(event))
      .sort((left, right) => left.time - right.time)
      .slice(-60)
  }, [runtimeEvents])

  const pttHoldPairs = useMemo(() => buildPTTHoldPairs(pttEvents), [pttEvents])

  const refresh = useCallback(() => {
    setSessions([...getSessions()])
    setRuntimeEvents([...getRuntimeEvents()])
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(refresh, 1000)
    return () => clearInterval(id)
  }, [autoRefresh, refresh])

  const handleClear = () => {
    clearSessions()
    clearRuntimeEvents()
    refresh()
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">调试</h1>
          <p className="text-xs text-muted-foreground">查看会话参数、完整 Prompt、关键日志和音频回放（区分按住时长、发送音频时长、ASR音频时长）。</p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
              className="rounded"
            />
            自动刷新
          </label>

          <Button onClick={refresh} variant="outline" size="sm" className="h-7 px-2 text-xs">
            刷新
          </Button>
          <Button onClick={handleClear} variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs text-destructive">
            <Trash2 className="h-3 w-3" /> 清空
          </Button>
        </div>
      </div>

      {pttEvents.length > 0 && (
        <PTTTimelineCard pttEvents={pttEvents} holdPairs={pttHoldPairs} />
      )}

      <IssueRuntimeEventsCard events={issueRuntimeEvents} />

      {sessions.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">还没有调试记录，先录一段再回来查看。</p>
      ) : (
        <div className="space-y-3">
          {sessions.map((session, index) => (
            <SessionCard key={session.id} session={session} defaultOpen={index === 0} />
          ))}
        </div>
      )}
    </div>
  )
}
