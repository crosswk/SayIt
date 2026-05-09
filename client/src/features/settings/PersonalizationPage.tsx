// 使用统计页面

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { getStats, listHistory, type Stats, type HistoryRecord } from '@/services/store'
import { createDefaultUserStats } from '@/services/personalization/defaults'
import { getUserStats } from '@/services/personalization/store'
import type { UserStats } from '@/services/personalization/types'
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

function formatDuration(sec: number) {
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h} 小时 ${m} 分`
}

function formatDate(ts: number | undefined) {
  if (!ts) return '-'
  return new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

/** 计算两个时间戳之间的天数 */
function daysBetween(a: number, b: number) {
  return Math.max(1, Math.ceil(Math.abs(b - a) / 86400000))
}

const WORK_MODE_LABELS: Record<string, string> = {
  server: '服务器',
  cloud_api: '云 API',
  local: '本地',
}

interface FullStats {
  totalChars: number
  totalDurationSec: number
  recordCount: number
  avgCharsPerSession: number
  avgSpeed: number
  savedTimeSec: number
  maxDurationSec: number
  dailyAvgRecords: number
  dailyAvgChars: number
  appUsage: Map<string, number>
  hourBuckets: number[]
  workModeCount: Map<string, number>
  presetCount: Map<string, number>
}

function computeFullStats(records: HistoryRecord[], rangeDays: number): FullStats {
  let totalChars = 0
  let totalDurationSec = 0
  let validCount = 0
  let maxDurationSec = 0
  const appUsage = new Map<string, number>()
  const hourBuckets = new Array(24).fill(0)
  const workModeCount = new Map<string, number>()
  const presetCount = new Map<string, number>()
  const daySet = new Set<string>()

  for (const r of records) {
    const d = new Date(r.timestamp)
    daySet.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)
    hourBuckets[d.getHours()]++

    if (r.workMode) workModeCount.set(r.workMode, (workModeCount.get(r.workMode) || 0) + 1)
    if (r.promptPresetName) presetCount.set(r.promptPresetName, (presetCount.get(r.promptPresetName) || 0) + 1)

    // 应用统计放在 isEmpty 之前，确保所有记录都计入
    if (r.appName || r.appId) {
      const name = (r.appName || r.appId || '未知').replace(/\.exe$/i, '')
      appUsage.set(name, (appUsage.get(name) || 0) + 1)
    }

    if (r.isEmpty) continue
    validCount++
    totalChars += r.charCount || 0
    const dur = pickVoiceDurationSec({ holdSec: r.durationSec, audioSec: r.audioDurationSec, asrSec: r.asrDurationSec })
    totalDurationSec += dur
    if (dur > maxDurationSec) maxDurationSec = dur
  }

  const activeDays = Math.max(1, rangeDays > 0 ? Math.min(rangeDays, daySet.size || 1) : daySet.size || 1)

  return {
    totalChars,
    totalDurationSec: Math.round(totalDurationSec),
    recordCount: records.length,
    avgCharsPerSession: validCount > 0 ? Math.round(totalChars / validCount) : 0,
    avgSpeed: totalDurationSec > 60 ? Math.round(totalChars / (totalDurationSec / 60)) : 0,
    savedTimeSec: Math.round(totalChars / 50) * 60,
    maxDurationSec: Math.round(maxDurationSec),
    dailyAvgRecords: Math.round((records.length / activeDays) * 10) / 10,
    dailyAvgChars: Math.round(totalChars / activeDays),
    appUsage,
    hourBuckets,
    workModeCount,
    presetCount,
  }
}

/** 时段分布柱状图 */
function HourChart({ buckets }: { buckets: number[] }) {
  const max = Math.max(...buckets, 1)
  const periods = [
    { label: '凌晨', sum: buckets.slice(0, 6).reduce((a, b) => a + b, 0) },
    { label: '上午', sum: buckets.slice(6, 12).reduce((a, b) => a + b, 0) },
    { label: '下午', sum: buckets.slice(12, 18).reduce((a, b) => a + b, 0) },
    { label: '晚上', sum: buckets.slice(18, 24).reduce((a, b) => a + b, 0) },
  ]
  const totalSum = periods.reduce((a, p) => a + p.sum, 0) || 1

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-[3px]" style={{ height: 64 }}>
        {buckets.map((count, hour) => (
          <div key={hour} className="group relative flex-1">
            <div
              className="w-full rounded-sm bg-primary/20 transition-colors group-hover:bg-primary/30"
              style={{ height: `${Math.max(count > 0 ? 4 : 1, (count / max) * 60)}px` }}
            />
            <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded bg-foreground px-1.5 py-0.5 text-[10px] text-background opacity-0 transition-opacity group-hover:opacity-100 whitespace-nowrap">
              {hour}时 {count}次
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
        <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {periods.map((p) => (
          <div key={p.label} className="rounded-lg bg-muted/30 px-2.5 py-2 text-center">
            <p className="text-[11px] text-muted-foreground">{p.label}</p>
            <p className="text-sm font-medium">{p.sum}</p>
            <p className="text-[10px] text-muted-foreground">{Math.round((p.sum / totalSum) * 100)}%</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 分布列表（统一柔和色调） */
function DistributionList({ entries }: { entries: [string, number][] }) {
  const maxCount = entries.length > 0 ? entries[0][1] : 1

  return (
    <div className="space-y-2">
      {entries.map(([label, count]) => (
        <div key={label} className="flex items-center gap-3">
          <span className="w-20 shrink-0 truncate text-sm">{label}</span>
          <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-muted/20">
            <div
              className="absolute inset-y-0 left-0 rounded-md bg-primary/15"
              style={{ width: `${Math.max((count / maxCount) * 100, 3)}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {count} 次
          </span>
        </div>
      ))}
    </div>
  )
}

export default function PersonalizationPage() {
  const [range, setRange] = useState<TimeRange>('all')
  const [allStats, setAllStats] = useState<Stats>({ totalDurationSec: 0, totalChars: 0 })
  const [userStats, setUserStats] = useState<UserStats>(createDefaultUserStats())
  const [records, setRecords] = useState<HistoryRecord[]>([])

  useEffect(() => {
    getStats().then(setAllStats)
    getUserStats().then(setUserStats)
    listHistory({ limit: 10000 }).then(setRecords)
  }, [])

  const filteredRecords = useMemo(() => {
    if (range === 'all') return records
    const cutoff = getRangeCutoff(range)
    return records.filter((r) => r.timestamp >= cutoff)
  }, [range, records])

  const rangeDays = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 0
  const stats = useMemo(() => computeFullStats(filteredRecords, rangeDays), [filteredRecords, rangeDays])

  // "全部"模式下合并 userStats 中的应用数据（历史记录可能缺少早期的 appName 字段）
  const appUsageEntries = useMemo(() => {
    const merged = new Map(stats.appUsage)
    if (range === 'all') {
      for (const [appId, count] of Object.entries(userStats.appUsageCount)) {
        const name = appId.replace(/\.exe$/i, '')
        const existing = merged.get(name) || 0
        if (count > existing) merged.set(name, count)
      }
    }
    return [...merged.entries()].sort(([, a], [, b]) => b - a)
  }, [stats.appUsage, range, userStats.appUsageCount])

  const workModeEntries: [string, number][] = [...stats.workModeCount.entries()]
    .map(([k, v]) => [WORK_MODE_LABELS[k] || k, v] as [string, number])
    .sort(([, a], [, b]) => b - a)

  const presetEntries = [...stats.presetCount.entries()].sort(([, a], [, b]) => b - a)

  // 首次使用距今天数
  const usageDays = userStats.firstUsedAt ? daysBetween(userStats.firstUsedAt, Date.now()) : 0

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">使用统计</h1>
        <div className="mt-3 inline-flex gap-1 rounded-lg border border-border p-0.5">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRange(opt.value)}
              className={`rounded-md px-3 py-1 text-xs transition-all ${
                range === opt.value
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-5">
        {/* 核心数据 4 列 */}
        <Card>
          <CardContent className="p-6">
            {/* 首次使用提示（仅全部模式，融入顶部） */}
            {range === 'all' && userStats.firstUsedAt && (
              <p className="mb-4 text-xs text-muted-foreground">
                自 {formatDate(userStats.firstUsedAt)} 起，已使用 {usageDays} 天
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">累计字数</p>
                <p className="mt-0.5 text-xl font-semibold">{stats.totalChars.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">历史记录</p>
                <p className="mt-0.5 text-xl font-semibold">{stats.recordCount.toLocaleString()} 条</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">口述时长</p>
                <p className="mt-0.5 text-xl font-semibold">{formatDuration(stats.totalDurationSec)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">节省时间</p>
                <p className="mt-0.5 text-xl font-semibold">{formatDuration(stats.savedTimeSec)}</p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-4">
              <div>
                <span className="text-xs text-muted-foreground">平均每次字数</span>
                <p className="text-sm font-medium">{stats.avgCharsPerSession}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">平均口述速度</span>
                <p className="text-sm font-medium">{stats.avgSpeed} 字/分</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">单次最长录音</span>
                <p className="text-sm font-medium">{stats.maxDurationSec > 0 ? formatDuration(stats.maxDurationSec) : '-'}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">日均使用</span>
                <p className="text-sm font-medium">{stats.dailyAvgRecords} 次 / {stats.dailyAvgChars} 字</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 使用时段分布 */}
        {stats.recordCount > 0 && (
          <Card>
            <CardContent className="p-6">
              <h2 className="mb-4 text-lg font-semibold">使用时段</h2>
              <HourChart buckets={stats.hourBuckets} />
            </CardContent>
          </Card>
        )}

        {/* 工作模式 & Prompt 预设 并排 */}
        {(workModeEntries.length > 0 || presetEntries.length > 0) && (
          <div className="grid gap-5 sm:grid-cols-2">
            {workModeEntries.length > 0 && (
              <Card>
                <CardContent className="p-6">
                  <h2 className="mb-3 text-lg font-semibold">工作模式</h2>
                  <DistributionList entries={workModeEntries} />
                </CardContent>
              </Card>
            )}
            {presetEntries.length > 0 && (
              <Card>
                <CardContent className="p-6">
                  <h2 className="mb-3 text-lg font-semibold">Prompt 预设</h2>
                  <DistributionList entries={presetEntries} />
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* 应用使用次数 */}
        {appUsageEntries.length > 0 && (
          <Card>
            <CardContent className="p-6">
              <h2 className="mb-3 text-lg font-semibold">应用使用次数</h2>
              <div className="space-y-2">
                {appUsageEntries.map(([appName, count]) => {
                  const maxCount = appUsageEntries[0][1]
                  const total = appUsageEntries.reduce((a, [, c]) => a + c, 0) || 1
                  const pct = Math.max((count / maxCount) * 100, 3)
                  return (
                    <div key={appName} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-sm">{appName}</span>
                      <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-muted/20">
                        <div
                          className="absolute inset-y-0 left-0 rounded-md bg-primary/15"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {count} 次
                      </span>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
