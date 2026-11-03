// 诊断页面 — 系统状态 + 日志查看

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IS_MAC } from '@/lib/platform'
import { Card, CardContent } from '@/components/ui/card'
import { getSetting } from '@/services/store'
import { getRuntimeEvents, type RuntimeEvent } from '@/services/debugLog'
import { getWorkMode } from '@/services/transcription'
import { FolderOpen, RefreshCw, CheckCircle2, XCircle, MinusCircle, CircleSlash, Info, HelpCircle, ChevronDown } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { providerLabel } from './aiProviderCatalog'
import { asrCardIdOfLegacyProvider, findAsrProvider } from './asrProviderCatalog'
import DiagnosticsReportPanel from './DiagnosticsReportPanel'
import { t } from '@/i18n'
import { RichText } from '@/i18n/RichText'
import { useLocale } from '@/i18n/useT'

type HealthStatus = 'ok' | 'error' | 'unknown' | 'disabled'

interface HealthItem {
  id: 'workMode' | 'asr' | 'localEngine' | 'compute' | 'ai'
  label: string
  status: HealthStatus
  detail: string
}

// 本地 GGUF 引擎的诊断信息（Rust 命令 gguf_asr_diagnostics）
interface GgufDevice {
  kind: string
  name: string
  memory_mb: number
  id: string
  index: number
  is_gpu: boolean
}

interface GgufDiagnostics {
  devices: GgufDevice[]
  current_backend: string | null
  /** 实际绑定的设备描述。多显卡机器上"选了哪张"和"真的用了哪张"可能不同，
   *  诊断报告里必须是这个。 */
  current_device: string | null
  /** 正在加载中的模型 id。非 null 时 current_backend 一定是 null。 */
  loading_model: string | null
  native_version: string
  process_memory_mb: number
}

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 text-green-500" />
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-500" />
  // 未开启：灰色「关闭」图标，明确区别于「正常（绿勾）」和「失败（红叉）」
  if (status === 'disabled') return <CircleSlash className="h-4 w-4 text-muted-foreground/50" />
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
  const locale = useLocale()
  const [health, setHealth] = useState<HealthItem[]>([])
  const [checking, setChecking] = useState(false)
  const [events, setEvents] = useState<RuntimeEvent[]>([])
  const [logFilter, setLogFilter] = useState<LogFilter>('errors')
  const [logContent, setLogContent] = useState('')
  const [showFileLog, setShowFileLog] = useState(true)
  // 默认全部折叠（null）。展开第一条会让整页在打开时就顶出一大段排查步骤，
  // 而多数人进诊断页是来看上面的状态自检的 —— 问题清单该等人来点。
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  // AI 整理处于「未开启」状态时，给出温和提示（依赖 AI 的功能不会生效）
  const aiProofreadDisabled = health.some((item) => item.id === 'ai' && item.status === 'disabled')

  const faqItems: { q: string; answer: React.ReactNode }[] = [{
    q: t('diagnostics.faq.insertQuestion'),
    answer: (
      <>
        {/* 每条都是「**症状** ：动作」—— 加粗的是症状，用户扫一眼粗体就能对上自己
            的情况，不必逐条读完。加粗位置交给译文决定（见 i18n/RichText）。 */}
        <ol className="list-decimal space-y-1.5 pl-5">
          <li><RichText text={t('diagnostics.faq.insert1')} /></li>
          <li><RichText text={t('diagnostics.faq.insert2')} /></li>
          <li><RichText text={t(IS_MAC ? 'diagnostics.faq.insert3Mac' : 'diagnostics.faq.insert3')} /></li>
          <li><RichText text={t(IS_MAC ? 'diagnostics.faq.insert4Mac' : 'diagnostics.faq.insert4')} /></li>
          <li><RichText text={t('diagnostics.faq.insert5')} /></li>
        </ol>
        {/* 收尾这句刻意放在列表外：前五条是用户能自己处理的，这句是"处理不了时
            该怎么把现场交给我们"。合进列表会让它看起来像第六种排查手段。 */}
        <p className="mt-2.5">{t('diagnostics.faq.insertFooter')}</p>
      </>
    ),
  }]

  useEffect(() => {
    void doHealthCheck()
    setEvents(getRuntimeEvents())
    void loadFileLog()
  }, [locale])

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
    items.push({
      id: 'workMode',
      label: t('diagnostics.health.workMode'),
      status: 'ok',
      detail: t(workMode === 'server' ? 'diagnostics.mode.server' : workMode === 'cloud_api' ? 'diagnostics.mode.cloud' : 'diagnostics.mode.local'),
    })

    // ASR 检查
    if (workMode === 'cloud_api') {
      const asrProvider = await getSetting('cloudAsr.provider', '') as string
      if (!asrProvider) {
        items.push({ id: 'asr', label: t('diagnostics.health.asr'), status: 'error', detail: t('diagnostics.notConfiguredProvider') })
      } else {
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const asrModel = await getSetting('cloudAsr.model', '') as string
        // 运行时键存的是分发 key（不是卡片 id），所以查表要先换算一次。
        // 模型名直接用运行时那份 —— 那才是这次真正会发出去的。
        const provider = findAsrProvider(asrCardIdOfLegacyProvider(asrProvider))
        const displayName = provider
          ? `${provider.label} (${asrModel || asrProvider})`
          : asrProvider
        if (!asrApiKey) {
          items.push({ id: 'asr', label: t('diagnostics.health.asr'), status: 'error', detail: t('diagnostics.missingKey', { provider: displayName }) })
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
            items.push({ id: 'asr', label: t('diagnostics.health.asr'), status: result.ok ? 'ok' : 'error', detail: result.ok ? displayName : `${displayName} — ${result.message}` })
          } catch (err) {
            items.push({ id: 'asr', label: t('diagnostics.health.asr'), status: 'error', detail: `${displayName} — ${String(err)}` })
          }
        }
      }
    } else if (workMode === 'local') {
      const modelId = await getSetting('localAsr.modelId', '') as string
      items.push({ id: 'asr', label: t('diagnostics.health.asr'), status: modelId ? 'ok' : 'error', detail: modelId || t('diagnostics.noModel') })
      // 本地引擎实况：实际绑定的后端（确认 GPU 用上了没）+ 进程内存（模型常驻的真实占用）
      try {
        const d = await invoke<GgufDiagnostics>('gguf_asr_diagnostics')
        items.push({
          id: 'localEngine',
          label: t('diagnostics.health.localEngine'),
          status: 'ok',
          detail: t('diagnostics.localEngineDetail', {
            // 多显卡机器上光有 "vulkan" 答不了"用的哪张卡"，把实际绑定的设备一起写上
            backend: d.loading_model
              ? t('diagnostics.loadingModel', { model: d.loading_model })
              : d.current_backend
                ? d.current_device ? `${d.current_backend} · ${d.current_device}` : d.current_backend
                : t('diagnostics.modelUnloaded'),
            memory: d.process_memory_mb,
            version: d.native_version,
          }),
        })
        items.push({
          id: 'compute',
          label: t('diagnostics.health.compute'),
          status: d.devices.length > 0 ? 'ok' : 'error',
          detail: d.devices.length > 0
            ? d.devices.map((dev) => t('diagnostics.deviceDetail', {
              name: dev.name,
              kind: dev.kind,
              memory: dev.memory_mb > 0
                ? t('diagnostics.deviceMemory', { memory: (dev.memory_mb / 1024).toFixed(0) })
                : '',
            })).join(t('diagnostics.deviceSeparator'))
            : t('diagnostics.noCompute'),
        })
      } catch (err) {
        items.push({ id: 'localEngine', label: t('diagnostics.health.localEngine'), status: 'error', detail: String(err) })
      }
    } else {
      items.push({ id: 'asr', label: t('diagnostics.health.asr'), status: 'ok', detail: t('diagnostics.fromServer') })
    }

    // AI 检查：所有模式都先看「AI 整理」总开关。关闭即极速模式（不经 AI），
    // 无论服务器/云 API/本地都应显示「未开启」。此前服务器模式跳过该判断、
    // 固定显示「由服务器提供」，导致用户关掉 AI 整理后诊断页看不出未开启。
    const aiEnabled = await getSetting('aiEnabled', false) as boolean
    if (!aiEnabled) {
      items.push({ id: 'ai', label: t('diagnostics.health.ai'), status: 'disabled', detail: t('diagnostics.aiDisabled') })
    } else if (workMode === 'server') {
      items.push({ id: 'ai', label: t('diagnostics.health.ai'), status: 'ok', detail: t('diagnostics.fromServer') })
    } else {
      const aiProvider = await getSetting('cloudAi.provider', '') as string
      const aiApiKey = await getSetting('cloudAi.apiKey', '') as string
      const aiApiUrl = await getSetting('cloudAi.apiUrl', '') as string
      const aiModel = await getSetting('cloudAi.model', '') as string
      // 供应商显示名只有一份真相（aiProviderCatalog）。这里原先另有一张 AI_DISPLAY 表，
      // 少了小米 MiMo、Ollama 的写法也和设置页不一致。
      const displayName = aiProvider ? providerLabel(aiProvider) : ''

      if (!aiProvider || (!aiApiKey && aiProvider !== 'ollama') || !aiApiUrl) {
        items.push({ id: 'ai', label: t('diagnostics.health.ai'), status: 'error', detail: t('diagnostics.incomplete') })
      } else {
        // 实际测试连通性
        try {
          const result = await invoke<{ ok: boolean; message: string }>('test_ai_connection', {
            config: { provider: aiProvider, api_url: aiApiUrl, api_key: aiApiKey, model: aiModel },
          })
          items.push({ id: 'ai', label: t('diagnostics.health.ai'), status: result.ok ? 'ok' : 'error', detail: result.ok ? t('diagnostics.providerModel', { provider: displayName, model: aiModel }) : `${displayName} — ${result.message}` })
        } catch (err) {
          items.push({ id: 'ai', label: t('diagnostics.health.ai'), status: 'error', detail: `${displayName} — ${String(err)}` })
        }
      }
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
        setLogContent(t('diagnostics.fileEmpty'))
      } else {
        // 最新的日志放上面
        const lines = content.split('\n').filter(Boolean)
        setLogContent(lines.reverse().join('\n'))
      }
      setShowFileLog(true)
    } catch (err) {
      setLogContent(t('diagnostics.readFailed', { message: String(err) }))
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
    { value: 'errors', label: t('diagnostics.errors'), count: events.filter((e) => e.level === 'error').length },
    { value: 'warnings', label: t('diagnostics.warnings'), count: events.filter((e) => e.level === 'error' || e.level === 'warn').length },
    { value: 'all', label: t('diagnostics.all'), count: events.length },
  ]

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">{t('diagnostics.title')}</h1>

      <div className="space-y-6">
        {/* 系统状态 */}
        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{t('diagnostics.systemStatus')}</h2>
              <Tooltip content={checking ? t('diagnostics.checking') : t('diagnostics.refreshStatus')}>
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
              {health.map((item) => (
                <div key={item.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <StatusIcon status={item.status} />
                  <span className="text-sm font-medium">{item.label}</span>
                  <span className="ml-auto text-sm text-muted-foreground">{item.detail}</span>
                </div>
              ))}
            </div>
            {aiProofreadDisabled && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t('diagnostics.aiDisabledHint')}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 常见问题 */}
        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <HelpCircle className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold">{t('diagnostics.faqTitle')}</h2>
            </div>
            <div className="space-y-2">
              {faqItems.map((item, i) => {
                const open = openFaq === i
                return (
                  <div key={i} className="overflow-hidden rounded-md border">
                    <button
                      type="button"
                      onClick={() => setOpenFaq(open ? null : i)}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent"
                    >
                      <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
                      <span className="flex-1">{item.q}</span>
                    </button>
                    {open && (
                      <div className="border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                        {item.answer}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* 运行日志 */}
        <Card>
          <CardContent className="p-6">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{t('diagnostics.runtimeLog')}</h2>
              <div className="flex items-center gap-1.5">
                {filterTabs.map((tab) => (
                  <button
                    key={tab.value}
                    onClick={() => setLogFilter(tab.value)}
                    className={`rounded-md px-2.5 py-1 text-xs transition-colors ${logFilter === tab.value
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                      }`}
                  >
                    {tab.label}{tab.count > 0 ? ` (${tab.count})` : ''}
                  </button>
                ))}
              </div>
            </div>

            {/* mac-selectable：mac 上界面文字默认不可选，运行日志要能选中拷贝（index.css） */}
            <div className="mac-selectable custom-scrollbar max-h-64 min-h-[3rem] space-y-1 overflow-y-auto">
              {filteredEvents().length === 0 ? (
                <div className="flex h-12 items-center justify-center text-sm text-muted-foreground/50">
                  {t(logFilter === 'errors' ? 'diagnostics.noErrors' : logFilter === 'warnings' ? 'diagnostics.noWarnings' : 'diagnostics.noLogs')}
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
              <span className="text-xs text-muted-foreground/50">{t('diagnostics.recentLog')}</span>
              <div className="flex items-center gap-0.5">
                <Tooltip content={t('diagnostics.refreshLog')}>
                  <button
                    onClick={() => void loadFileLog()}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content={t('diagnostics.openLogFolder')}>
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
