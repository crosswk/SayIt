import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { readLogFile, openLogFolder } from '@/services/bridge'

type LogLevel = 'all' | 'error' | 'warn' | 'info'
type LogSource = 'current' | '1' | '2' | '3'

interface ParsedLine {
  raw: string
  ts: string
  level: string
  module: string
  message: string
}

function parseLine(line: string): ParsedLine {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[')) {
    return { raw: line, ts: '', level: 'info', module: '', message: trimmed }
  }

  const tsEnd = trimmed.indexOf(']')
  if (tsEnd < 0) return { raw: line, ts: '', level: 'info', module: '', message: trimmed }
  const ts = trimmed.slice(1, tsEnd)

  let rest = trimmed.slice(tsEnd + 1).trimStart()
  let level = 'info'
  if (rest.startsWith('[')) {
    const lvlEnd = rest.indexOf(']')
    if (lvlEnd > 0) {
      level = rest.slice(1, lvlEnd).trim().toLowerCase()
      rest = rest.slice(lvlEnd + 1).trimStart()
    }
  }

  let module = ''
  if (rest.startsWith('[')) {
    const modEnd = rest.indexOf(']')
    if (modEnd > 0) {
      module = rest.slice(1, modEnd).trim()
      rest = rest.slice(modEnd + 1).trimStart()
    }
  }

  return { raw: line, ts, level, module, message: rest }
}

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-destructive',
  warn: 'text-warning',
  info: 'text-muted-foreground',
}

function LogLine({ entry }: { entry: ParsedLine }) {
  const color = LEVEL_COLORS[entry.level] || 'text-muted-foreground'
  return (
    <div className="flex gap-2 border-b border-border/30 px-3 py-1 font-mono text-xs leading-5 hover:bg-accent/30">
      {entry.ts && <span className="shrink-0 text-muted-foreground/60">{entry.ts}</span>}
      <span className={`w-12 shrink-0 text-center font-semibold uppercase ${color}`}>{entry.level}</span>
      {entry.module && <span className="shrink-0 text-accent-foreground/70">[{entry.module}]</span>}
      <span className="min-w-0 break-all text-foreground">{entry.message}</span>
    </div>
  )
}

export default function LogViewerPanel() {
  const [logContent, setLogContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [levelFilter, setLevelFilter] = useState<LogLevel>('all')
  const [source, setSource] = useState<LogSource>('current')
  const [search, setSearch] = useState('')

  const loadLog = useCallback(async (src: LogSource) => {
    setLoading(true)
    try {
      const content = await readLogFile(src === 'current' ? 'current' : src)
      setLogContent(content)
    } catch {
      setLogContent(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLog(source)
  }, [source, loadLog])

  const parsed = useMemo(() => {
    if (!logContent) return []
    return logContent.split('\n').filter(Boolean).map(parseLine)
  }, [logContent])

  const filtered = useMemo(() => {
    let lines = parsed
    if (levelFilter !== 'all') {
      lines = lines.filter((l) => l.level === levelFilter)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      lines = lines.filter((l) => l.raw.toLowerCase().includes(q))
    }
    return lines
  }, [parsed, levelFilter, search])

  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0, total: parsed.length }
    for (const l of parsed) {
      if (l.level === 'error') c.error++
      else if (l.level === 'warn') c.warn++
      else c.info++
    }
    return c
  }, [parsed])

  const LEVEL_OPTIONS: { value: LogLevel; label: string; count: number }[] = [
    { value: 'all', label: '全部', count: counts.total },
    { value: 'error', label: '错误', count: counts.error },
    { value: 'warn', label: '警告', count: counts.warn },
    { value: 'info', label: '信息', count: counts.info },
  ]

  const SOURCE_OPTIONS: { value: LogSource; label: string }[] = [
    { value: 'current', label: '当前日志' },
    { value: '1', label: '日志 1' },
    { value: '2', label: '日志 2' },
    { value: '3', label: '日志 3' },
  ]

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">运行日志</h2>
            <p className="mt-1 text-sm text-muted-foreground">查看应用运行日志，排查问题</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => openLogFolder()}>
              <FolderOpen className="mr-2 h-3.5 w-3.5" />
              打开目录
            </Button>
            <Button variant="outline" size="sm" onClick={() => loadLog(source)} disabled={loading}>
              <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            {SOURCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSource(opt.value)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  source === opt.value
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-border" />

          <div className="flex items-center gap-1.5">
            {LEVEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setLevelFilter(opt.value)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  levelFilter === opt.value
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                {opt.label} ({opt.count})
              </button>
            ))}
          </div>

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索日志内容"
            className="ml-auto w-48 rounded-md border border-input-border bg-input-bg px-2.5 py-1 text-xs focus:border-input-focus-border focus:outline-none"
          />
        </div>

        <div className="custom-scrollbar max-h-[50vh] overflow-y-auto rounded-md border border-border bg-card">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无日志</div>
          ) : (
            filtered.map((entry, i) => <LogLine key={i} entry={entry} />)
          )}
        </div>

        <div className="mt-2 text-xs text-muted-foreground">
          显示 {filtered.length} / {counts.total} 条
        </div>
      </CardContent>
    </Card>
  )
}
