import * as bridge from '@/services/bridge'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { OverlayService } from '@/services/recorder/OverlayService'
import { PasteService, type PasteResult, type ProbeResult } from '@/services/recorder/PasteService'
import {
  captureActiveInsertionTarget,
  clearCapturedInsertionTarget,
} from '@/services/textInsertion'
import { elapsedSecFromPerf } from '@/services/timeModel'
import { setLabEnabled } from '@/services/webviewKeyboardFallback'

type LabState = 'armed' | 'holding' | 'resolving'

function formatTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

export default function PTTLab() {
  const [state, setState] = useState<LabState>('armed')
  const [testText, setTestText] = useState('PTT Lab 注入测试文本 ✅')
  const [logs, setLogs] = useState<string[]>([])
  const [holdElapsed, setHoldElapsed] = useState(0)
  const [lastProbe, setLastProbe] = useState<ProbeResult | null>(null)
  const [lastPaste, setLastPaste] = useState<PasteResult | null>(null)
  const [internalText, setInternalText] = useState('')
  const [lastEventSummary, setLastEventSummary] = useState('等待右 Ctrl 按键...')

  const testTextRef = useRef('PTT Lab 注入测试文本 ✅')
  const holdStartPerfRef = useRef(0)
  const holdElapsedRef = useRef(0)
  const holdTickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pasteServiceRef = useRef(new PasteService())
  const overlayServiceRef = useRef(new OverlayService(() => holdElapsedRef.current))
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const cachedProbeRef = useRef<ProbeResult | null>(null)
  const stateRef = useRef<LabState>('armed')

  testTextRef.current = testText
  stateRef.current = state

  const appendLog = (message: string, detail?: unknown) => {
    const suffix = detail === undefined
      ? ''
      : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
    const line = `[${formatTime()}] ${message}${suffix}`
    setLogs((prev) => [line, ...prev].slice(0, 80))
  }

  const stopHoldTicker = () => {
    if (!holdTickerRef.current) return
    clearInterval(holdTickerRef.current)
    holdTickerRef.current = null
  }

  const resetToArmed = () => {
    stopHoldTicker()
    holdStartPerfRef.current = 0
    holdElapsedRef.current = 0
    setHoldElapsed(0)
    cachedProbeRef.current = null
    setState('armed')
  }

  const copyFallbackText = async (reason: string) => {
    const text = testTextRef.current
    await bridge.copyText(text)
    appendLog('已复制测试文本到剪贴板', { reason, textLen: text.length })
  }

  /** Core inject logic */
  const doInject = async (probe: ProbeResult) => {
    const text = testTextRef.current
    setLastProbe(probe)
    appendLog('probe 完成', {
      editable: probe.editable,
      hwnd: probe.hwnd,
      focusHwnd: probe.focusHwnd,
      pid: probe.pid,
      process: probe.process,
      verdict: probe.verdict,
      focusClass: probe.focusClass,
      windowClass: probe.windowClass,
      controlType: probe.controlType,
      isValuePatternAvailable: probe.isValuePatternAvailable,
      isKeyboardFocusable: probe.isKeyboardFocusable,
    })

    if (probe.isCurrentAppProcess) {
      // SayIt 自身是 Chromium 窗口，renderer 直插对 React 受控组件无效，
      // 走和外部窗口一样的 Rust paste（Ctrl+V）路径。
      appendLog('命中 SayIt 自身进程，走 Rust paste', { hwnd: probe.hwnd })
      // Fall through to normal editable / not_editable flow
    }

    if (!probe.editable) {
      await copyFallbackText('not_editable')
      overlayServiceRef.current.showFallback(text, 'not_editable')
      setLastPaste({ ok: false, reason: 'not_editable', detail: probe.detail })
      appendLog('目标不可编辑，已显示复制卡片', { process: probe.process, verdict: probe.verdict })
      setLastEventSummary(`❌ not_editable (${probe.process || '-'})`)
      resetToArmed()
      return
    }

    // Pass probe so Rust uses pre-probed hwnd (same as real PTT flow)
    const result = await pasteServiceRef.current.pasteText(text, probe)
    setLastPaste(result)
    if (result.ok) {
      overlayServiceRef.current.hide()
      appendLog('外部注入成功', { strategy: result.strategy, detail: result.detail })
      setLastEventSummary(`✅ ${result.strategy || 'paste_success'}`)
      resetToArmed()
      return
    }

    await copyFallbackText(result.reason || 'paste_failed')
    overlayServiceRef.current.showFallback(text, result.reason || 'paste_failed')
    appendLog('外部注入失败，回退到复制卡片', result)
    setLastEventSummary(`❌ ${result.reason || 'paste_failed'}`)
    resetToArmed()
  }

  // ── Lab event handlers (right Ctrl via dedicated hook) ──

  const handleLabDown = async () => {
    if (stateRef.current !== 'armed') return

    // Capture probe NOW while target window is focused
    let probe: ProbeResult
    try {
      probe = await pasteServiceRef.current.getProbeResult()
    } catch {
      probe = { editable: false, hwnd: '0', process: '-', detail: 'probe_error' }
    }
    cachedProbeRef.current = probe

    holdStartPerfRef.current = performance.now()
    holdElapsedRef.current = 0
    setHoldElapsed(0)
    setState('holding')

    captureActiveInsertionTarget(undefined, { preserveExistingOnFailure: true })
    overlayServiceRef.current.clearFallbackHideTimer()
    overlayServiceRef.current.showWaiting()
    overlayServiceRef.current.startListeningTicker()

    stopHoldTicker()
    holdTickerRef.current = setInterval(() => {
      if (!holdStartPerfRef.current) return
      const sec = elapsedSecFromPerf(holdStartPerfRef.current)
      holdElapsedRef.current = sec
      setHoldElapsed(Math.round(sec * 10) / 10)
    }, 100)

    appendLog('右 Ctrl down — 开始按住', {
      probe: { editable: probe.editable, process: probe.process, verdict: probe.verdict },
    })
    setLastEventSummary('🔴 按住中...')
  }

  const handleLabUp = async () => {
    if (stateRef.current !== 'holding') return
    setState('resolving')
    stopHoldTicker()

    const elapsed = holdStartPerfRef.current > 0 ? elapsedSecFromPerf(holdStartPerfRef.current) : 0
    holdElapsedRef.current = elapsed
    setHoldElapsed(Math.round(elapsed * 10) / 10)

    overlayServiceRef.current.stopListeningTicker()
    overlayServiceRef.current.showThinking(elapsed)

    appendLog('右 Ctrl up — 开始注入', { holdSec: elapsed.toFixed(1) })
    setLastEventSummary('⏳ 注入中...')

    const probe = cachedProbeRef.current
      ?? await pasteServiceRef.current.getProbeResult()
    await doInject(probe)
  }

  // ── Lifecycle ──

  useEffect(() => {
    let mounted = true
    void overlayServiceRef.current.refreshSettings()

    // Start dedicated lab keyboard hook (right Ctrl = 0xA3)
    console.log('[PTTLab] useEffect mount, calling setPTTLabConfig')
    bridge.setPTTLabConfig({ enabled: true, vkCode: 0xA3 })
    setLabEnabled(true)
    appendLog('PTT Lab 已启用，测试热键: 右 Ctrl')
    appendLog('按住右 Ctrl → 切到目标窗口 → 松手 → 自动注入测试文本')

    // Listen to lab-specific events (independent from main PTT)
    bridge.onPTTLabEvent((payload: unknown) => {
      if (!mounted) return
      const event = (payload && typeof payload === 'object') ? payload as { phase?: string } : {}
      if (event.phase === 'down') {
        void handleLabDown()
      } else if (event.phase === 'up') {
        void handleLabUp()
      }
    })

    return () => {
      mounted = false
      // Stop lab hook
      bridge.setPTTLabConfig({ enabled: false })
      setLabEnabled(false)
      stopHoldTicker()
      clearCapturedInsertionTarget()
      overlayServiceRef.current.dispose()
    }
  }, [])

  const handleShowFallbackOnly = async () => {
    await copyFallbackText('manual_preview')
    overlayServiceRef.current.showFallback(testText, 'manual_preview')
    appendLog('已手动展示复制卡片')
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">PTT Lab</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          测试 probe → 文本注入 → fallback 流程，不经过录音和转录。测试热键：右 Ctrl（不影响按住说话热键）。
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleShowFallbackOnly} variant="outline" className="gap-2">
              <SquareTerminal className="h-4 w-4" />
              预览复制卡片
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border bg-card p-3">
              <div className="text-xs font-medium text-muted-foreground">状态</div>
              <div className="mt-1 text-sm font-medium text-foreground">
                {state === 'armed' && '✅ 就绪'}
                {state === 'holding' && `🔴 按住中 ${holdElapsed.toFixed(1)}s`}
                {state === 'resolving' && '⏳ 注入中...'}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">{lastEventSummary}</div>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="text-xs font-medium text-muted-foreground">使用方法</div>
              <div className="mt-1 text-xs text-muted-foreground space-y-1">
                <div>1. 切到目标窗口，光标放在输入框里</div>
                <div>2. 按住右 Ctrl → 松手 → 自动注入测试文本</div>
                <div>3. 按住说话（右 Alt）不受影响，可以同时使用</div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">测试文本</label>
            <textarea
              value={testText}
              onChange={(e) => { setTestText(e.target.value); testTextRef.current = e.target.value }}
              rows={2}
              className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm outline-none focus:border-input-focus-border"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">内部可编辑目标</div>
              <div className="text-xs text-muted-foreground">
                聚焦此输入框后按右 Ctrl，松手后应直接写入测试文本。
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => textAreaRef.current?.focus()}>
              聚焦
            </Button>
          </div>
          <textarea
            ref={textAreaRef}
            value={internalText}
            onChange={(e) => setInternalText(e.target.value)}
            onFocus={(e) => {
              captureActiveInsertionTarget(e.currentTarget, { preserveExistingOnFailure: true })
              appendLog('内部目标已聚焦')
            }}
            rows={3}
            className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm outline-none focus:border-input-focus-border"
            placeholder="SayIt 内部可编辑目标"
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CheckCircle2 className="h-4 w-4 text-success" />
              最近 Probe
            </div>
            {lastProbe ? (
              <div className="space-y-1 rounded-lg border bg-card p-3 text-xs text-foreground">
                <div>editable: <span className={lastProbe.editable ? 'text-success font-medium' : 'text-destructive font-medium'}>{String(lastProbe.editable)}</span></div>
                <div>verdict: {lastProbe.verdict || '-'}</div>
                <div>process: {lastProbe.process || '-'} (pid: {lastProbe.pid ?? '-'})</div>
                <div>hwnd: {lastProbe.hwnd || '-'} / focus: {lastProbe.focusHwnd || '-'}</div>
                <div>focusClass: {lastProbe.focusClass || '-'}</div>
                <div>windowClass: {lastProbe.windowClass || '-'}</div>
                <div>controlType: {lastProbe.controlType || '-'}</div>
                <div>isValuePattern: {String(lastProbe.isValuePatternAvailable ?? '-')}</div>
                <div>isKeyboardFocusable: {String(lastProbe.isKeyboardFocusable ?? '-')}</div>
                <div>hasCaret: {String(lastProbe.hasCaret ?? '-')}</div>
                <div className="break-all text-muted-foreground">{lastProbe.detail}</div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">还没有 probe 结果。</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle className="h-4 w-4 text-warning" />
              最近注入
            </div>
            {lastPaste ? (
              <div className="space-y-1 rounded-lg border bg-card p-3 text-xs text-foreground">
                <div>ok: <span className={lastPaste.ok ? 'text-success font-medium' : 'text-destructive font-medium'}>{String(lastPaste.ok)}</span></div>
                <div>strategy: {lastPaste.strategy || '-'}</div>
                <div>reason: {lastPaste.reason || '-'}</div>
                <div className="break-all text-muted-foreground">{lastPaste.detail || '-'}</div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">还没有注入结果。</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="mb-2 text-sm font-medium text-foreground">实验日志</div>
          <div className="h-72 overflow-y-auto rounded-lg bg-[#1a1a1a] p-3 font-mono text-xs text-emerald-400">
            {logs.length > 0 ? (
              logs.map((line, i) => <div key={`${line}-${i}`}>{line}</div>)
            ) : (
              <div className="text-muted-foreground">等待右 Ctrl 事件...</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
