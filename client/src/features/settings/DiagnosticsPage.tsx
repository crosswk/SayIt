// 诊断页面 — 系统状态 + 日志查看

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Card, CardContent } from '@/components/ui/card'
import { getSetting } from '@/services/store'
import { getRuntimeEvents, type RuntimeEvent } from '@/services/debugLog'
import { getWorkMode } from '@/services/transcription'
import { FolderOpen, RefreshCw, CheckCircle2, XCircle, MinusCircle } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import DiagnosticsReportPanel from './DiagnosticsReportPanel'

type HealthStatus = 'ok' | 'error' | 'unknown'

interface HealthItem {
  label: string
  status: HealthStatus
  detail: string
}

// ASR 供应商 → 显示名映射
const ASR_DISPLAY: Record<string, string> = {
  doubao_v2: '豆包 ASR（Doubao-Seed-ASR-2.0）',
  qwen: '千问 ASR（qwen3-asr-flash）',
  qwen_omni_35_plus: '千问 3.5 Omni Plus（qwen3.5-omni-plus-realtime）',
  qwen_omni_35_flash: '千问 3.5 Omni Flash（qwen3.5-omni-flash-realtime）',
  qwen_omni_flash: '千问 Omni Flash（qwen3-omni-flash-realtime）',
  qwen_omni_turbo: '千问 Omni Turbo（qwen-omni-turbo-realtime）',
}

// AI 供应商 → 显示名映射
const AI_DISPLAY: Record<string, string> = {
  openai_compat: 'OpenAI 兼容',
  deepseek: 'DeepSeek',
  doubao: '豆包（火山方舟）',
  qwen: '通义千问',
  ollama: 'Ollama（本地）',
}

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 text-green-500" />
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-500" />
  return <MinusCircle className="h-4 w-4 text-muted-foreground/50" />
}

function levelColor(level: string) {
  if (level === 'error') return 'text-red-500'
  if (level === 'warn') return 'text-amber-500'
  return 'text-muted-foreground'
}

function levelBg(level: string) {
  if (level === 'error') return 'bg-red-500/10 border-red-500/20'
  if (level === 'warn') return 'bg-amber-500/10 border-amber-500/20'
  return 'bg-muted/30 border-border'
}

type LogFilter = 'errors' | 'warnings' | 'all'

export default function DiagnosticsPage() {
  const [health, setHealth] = useState<HealthItem[]>([])
  const [checking, setChecking] = useState(false)
  const [events, setEvents] = useState<RuntimeEvent[]>([])
  const [logFilter, setLogFilter] = useState<LogFilter>('errors')
  const [logContent, setLogContent] = useState('')
  const [showFileLog, setShowFileLog] = useState(true)

  useEffect(() => {
    void doHealthCheck()
    setEvents(getRuntimeEvents())
    void loadFileLog()
  }, [])

  async function doHealthCheck() {
    setChecking(true)
    await runHealthCheck()
    setChecking(false)
  }

  async function handleRefresh() {
    setChecking(true)
    setEvents(getRuntimeEvents())
    await runHealthCheck()
    setChecking(false)
  }

  async function runHealthCheck() {
    const items: HealthItem[] = []
    const workMode = getWorkMode()
    items.push({ label: '工作模式', status: 'ok', detail: workMode === 'server' ? '服务器' : workMode === 'cloud_api' ? '云 API' : '本地' })

    // ASR 检查
    if (workMode === 'cloud_api') {
      const asrProvider = await getSetting('cloudAsr.provider', '') as string
      if (!asrProvider) {
        items.push({ label: 'ASR', status: 'error', detail: '未配置供应商' })
      } else {
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const displayName = ASR_DISPLAY[asrProvider] || asrProvider
        if (!asrApiKey) {
          items.push({ label: 'ASR', status: 'error', detail: `${displayName} — 未填写密钥` })
        } else {
          // 实际测试连通性
          try {
            const isQwenOmni = asrProvider.startsWith('qwen_omni')
            const qwenOmniModel = asrProvider === 'qwen_omni_35_plus' ? 'qwen3.5-omni-plus-realtime'
              : asrProvider === 'qwen_omni_35_flash' ? 'qwen3.5-omni-flash-realtime'
              : asrProvider === 'qwen_omni_flash' ? 'qwen3-omni-flash-realtime'
              : asrProvider === 'qwen_omni_turbo' ? 'qwen-omni-turbo-realtime' : undefined
            const result = await invoke<{ ok: boolean; message: string }>('test_asr_connection', {
              config: {
                provider: isQwenOmni ? 'qwen_omni' : asrProvider,
                api_key: asrApiKey,
                app_id: await getSetting('cloudAsr.appId', '') as string,
                ...(isQwenOmni && qwenOmniModel && { extra: { model: qwenOmniModel } }),
              },
            })
            items.push({ label: 'ASR', status: result.ok ? 'ok' : 'error', detail: result.ok ? displayName : `${displayName} — ${result.message}` })
          } catch (err) {
            items.push({ label: 'ASR', status: 'error', detail: `${displayName} — ${String(err)}` })
          }
        }
      }
    } else if (workMode === 'local') {
      const modelId = await getSetting('localAsr.modelId', '') as string
      items.push({ label: 'ASR', status: modelId ? 'ok' : 'error', detail: modelId || '未选择模型' })
    } else {
      items.push({ label: 'ASR', status: 'ok', detail: '由服务器提供' })
    }

    // AI 检查
    if (workMode !== 'server') {
      const aiEnabled = await getSetting('aiEnabled', false) as boolean
      if (!aiEnabled) {
        items.push({ label: 'AI 校对', status: 'ok', detail: '已关闭（极速模式）' })
      } else {
        const aiProvider = await getSetting('cloudAi.provider', '') as string
        const aiApiKey = await getSetting('cloudAi.apiKey', '') as string
        const aiApiUrl = await getSetting('cloudAi.apiUrl', '') as string
        const aiModel = await getSetting('cloudAi.model', '') as string
        const displayName = AI_DISPLAY[aiProvider] || aiProvider

        if (!aiProvider || (!aiApiKey && aiProvider !== 'ollama') || !aiApiUrl) {
          items.push({ label: 'AI 校对', status: 'error', detail: '未完整配置' })
        } else {
          // 实际测试连通性
          try {
            const result = await invoke<{ ok: boolean; message: string }>('test_ai_connection', {
              config: { provider: aiProvider, api_url: aiApiUrl, api_key: aiApiKey, model: aiModel },
            })
            items.push({ label: 'AI 校对', status: result.ok ? 'ok' : 'error', detail: result.ok ? `${displayName}（${aiModel}）` : `${displayName} — ${result.message}` })
          } catch (err) {
            items.push({ label: 'AI 校对', status: 'error', detail: `${displayName} — ${String(err)}` })
          }
        }
      }
    } else {
      items.push({ label: 'AI 校对', status: 'ok', detail: '由服务器提供' })
    }

    setHealth(items)
  }

  function filteredEvents() {
    if (logFilter === 'errors') return events.filter((e) => e.level === 'error')
    if (logFilter === 'warnings') return events.filter((e) => e.level === 'error' || e.level === 'warn')
    return events
  }

  async function loadFileLog() {
    try {
      const content = await invoke<string | null>('read_log_file', { logType: 'current' })
      if (!content) {
        setLogContent('（日志文件为空）')
      } else {
        // 最新的日志放上面
        const lines = content.split('\n').filter(Boolean)
        setLogContent(lines.reverse().join('\n'))
      }
      setShowFileLog(true)
    } catch (err) {
      setLogContent(`读取失败: ${String(err)}`)
      setShowFileLog(true)
    }
  }

  async function openLogFolder() {
    try { await invoke('open_log_folder') } catch { /* ignore */ }
  }

  function formatTime(ts: number) {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
  }

  const filterTabs: { value: LogFilter; label: string; count: number }[] = [
    { value: 'errors', label: '错误', count: events.filter((e) => e.level === 'error').length },
    { value: 'warnings', label: '警告', count: events.filter((e) => e.level === 'error' || e.level === 'warn').length },
    { value: 'all', label: '全部', count: events.length },
  ]

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">诊断</h1>

      <div className="space-y-6">
        {/* 系统状态 */}
        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">系统状态</h2>
              <Tooltip content={checking ? '检测中...' : '刷新状态'}>
                <button
                  onClick={() => void handleRefresh()}
                  disabled={checking}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
                </button>
              </Tooltip>
            </div>
            <div className="space-y-2">
              {health.map((item, i) => (
                <div key={i} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <StatusIcon status={item.status} />
                  <span className="text-sm font-medium">{item.label}</span>
                  <span className="ml-auto text-sm text-muted-foreground">{item.detail}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 运行日志 */}
        <Card>
          <CardContent className="p-6">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">运行日志</h2>
              <div className="flex items-center gap-1.5">
                {filterTabs.map((tab) => (
                  <button
                    key={tab.value}
                    onClick={() => setLogFilter(tab.value)}
                    className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                      logFilter === tab.value
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {tab.label}{tab.count > 0 ? ` (${tab.count})` : ''}
                  </button>
                ))}
              </div>
            </div>

            <div className="custom-scrollbar max-h-64 min-h-[3rem] space-y-1 overflow-y-auto">
              {filteredEvents().length === 0 ? (
                <div className="flex h-12 items-center justify-center text-sm text-muted-foreground/50">
                  {logFilter === 'errors' ? '暂无错误' : logFilter === 'warnings' ? '暂无警告' : '暂无日志'}
                </div>
              ) : (
                filteredEvents().map((event, i) => (
                  <div key={`${event.time}-${i}`} className={`rounded border px-3 py-1.5 text-xs ${levelBg(event.level)}`}>
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-muted-foreground/60">{formatTime(event.time)}</span>
                      <span className={`shrink-0 font-medium uppercase ${levelColor(event.level)}`}>{event.level}</span>
                      <span className="shrink-0 text-muted-foreground">[{event.source}]</span>
                      <span className="min-w-0 flex-1 truncate">{event.message}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* 底部操作栏 */}
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
              <span className="text-xs text-muted-foreground/50">显示最近 200KB 日志内容</span>
              <div className="flex items-center gap-0.5">
                <Tooltip content="刷新日志">
                  <button
                    onClick={() => void loadFileLog()}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content="打开日志所在文件夹">
                  <button
                    onClick={() => void openLogFolder()}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>

            {showFileLog && (
              <pre className="custom-scrollbar mt-3 max-h-48 overflow-auto rounded-md bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                {logContent}
              </pre>
            )}
          </CardContent>
        </Card>

        {/* 诊断报告（所有模式均可用） */}
        <DiagnosticsReportPanel embedded />
      </div>
    </div>
  )
}
