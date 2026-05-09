import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { summarizeDomainScenes } from '@/services/personalization/userStats'
import type { UserStats } from '@/services/personalization/types'
import { listHistory, type HistoryRecord } from '@/services/store'
import { pickVoiceDurationSec } from '@/services/timeModel'

type TimeRange = 'today' | '7d' | '30d' | 'all'

const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'all', label: '全部' },
]

function getStartOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function getRangeCutoff(range: TimeRange): number {
  const now = new Date()
  switch (range) {
    case 'today': return getStartOfDay(now).getTime()
    case '7d': return getStartOfDay(new Date(now.getTime() - 6 * 86400000)).getTime()
    case '30d': return getStartOfDay(new Date(now.getTime() - 29 * 86400000)).getTime()
    case 'all': return 0
  }
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function formatDate(timestamp: number | undefined) {
  if (!timestamp) return '未知'
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
}

interface RangeStats {
  totalWords: number
  totalSessions: number
  avgWords: number
  appUsageCount: Record<string, number>
}

function computeRangeStats(records: HistoryRecord[]): RangeStats {
  const appUsageCount: Record<string, number> = {}
  let totalWords = 0
  let totalSessions = 0
  for (const r of records) {
    if (r.isEmpty) continue
    totalSessions++
    totalWords += r.charCount || 0
    if (r.appName || r.appId) {
      const key = r.appName || r.appId || '未知'
      appUsageCount[key] = (appUsageCount[key] || 0) + 1
    }
  }
  return {
    totalWords,
    totalSessions,
    avgWords: totalSessions > 0 ? Math.round(totalWords / totalSessions) : 0,
    appUsageCount,
  }
}

export default function UserStatsSection({ userStats }: { userStats: UserStats }) {
  const [range, setRange] = useState<TimeRange>('today')
  const [records, setRecords] = useState<HistoryRecord[]>([])

  useEffect(() => {
    listHistory({ limit: 10000 }).then(setRecords)
  }, [])

  const filteredRecords = useMemo(() => {
    if (range === 'all') return records
    const cutoff = getRangeCutoff(range)
    return records.filter((r) => r.timestamp >= cutoff)
  }, [range, records])

  const rangeStats = useMemo(() => computeRangeStats(filteredRecords), [filteredRecords])

  // 全部模式用原始 userStats（包含 domainWords 等），其他范围用聚合数据
  const displayStats = range === 'all' ? {
    totalWords: userStats.totalWords,
    totalSessions: userStats.totalSessions,
    avgWords: userStats.totalSessions > 0 ? Math.round(userStats.totalWords / userStats.totalSessions) : 0,
    appUsageCount: userStats.appUsageCount,
  } : rangeStats

  const topScenes = range === 'all' ? summarizeDomainScenes(userStats, 3) : []
  const appUsageEntries = Object.entries(displayStats.appUsageCount)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">使用统计</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              基于本地历史记录统计，数据不会上传。
            </p>
          </div>
          <div className="flex gap-0.5">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  range === opt.value
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">输出字数</p>
            <p className="mt-1 text-lg font-semibold">{displayStats.totalWords.toLocaleString('zh-CN')}</p>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">记录数</p>
            <p className="mt-1 text-lg font-semibold">{displayStats.totalSessions.toLocaleString('zh-CN')}</p>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">平均每次字数</p>
            <p className="mt-1 text-lg font-semibold">{displayStats.avgWords.toLocaleString('zh-CN')}</p>
          </div>
        </div>

        {range === 'all' && (userStats.firstUsedAt || userStats.lastUsedAt) && (
          <div className="rounded-xl border bg-card px-4 py-3">
            <div className="flex items-center justify-between text-xs">
              <div>
                <span className="text-muted-foreground">首次使用：</span>
                <span className="ml-1 font-medium">{formatDate(userStats.firstUsedAt)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">最近使用：</span>
                <span className="ml-1 font-medium">{formatDate(userStats.lastUsedAt)}</span>
              </div>
            </div>
          </div>
        )}

        {range === 'all' && topScenes.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Top 3 应用场景</p>
            {topScenes.map((scene) => (
              <div key={scene.id} className="flex items-center justify-between rounded-xl border bg-card px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{scene.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{scene.words.toLocaleString('zh-CN')} 字</p>
                </div>
                <span className="text-sm font-semibold text-foreground">{formatPercent(scene.ratio)}</span>
              </div>
            ))}
          </div>
        )}

        {appUsageEntries.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Top 5 应用使用次数</p>
            <div className="space-y-2">
              {appUsageEntries.map(([appId, count]) => (
                <div key={appId} className="flex items-center justify-between rounded-xl border bg-card px-4 py-2.5">
                  <p className="text-sm font-medium">{appId}</p>
                  <span className="text-sm font-semibold text-foreground">{count.toLocaleString('zh-CN')} 次</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
