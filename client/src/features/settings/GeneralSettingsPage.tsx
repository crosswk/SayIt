// 通用设置页面 — 主题、快捷键、麦克风、悬浮窗、开机启动、音频保留、数据导出

import * as bridge from '@/services/bridge'
import { refreshPTTSetting } from '@/services/webviewKeyboardFallback'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Download, FolderOpen, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { listMicrophones } from '@/services/audio'
import { exportAllDataBundle, exportSettings } from '@/services/exports'
import { refreshRecorderSettings } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import { drawBars, resetWaveform } from '@/services/waveform'
import { Switch } from '@/components/ui/switch'
import AppSection from './AppSection'
import MicrophoneSection from './MicrophoneSection'
import type { MicVolumeLevel } from './MicrophoneSection'
import { ComboShortcutInput, PTTShortcutInput } from './ShortcutInputs'

export default function GeneralSettingsPage() {
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState('')
  const [testing, setTesting] = useState(false)
  const [volumeLevel, setVolumeLevel] = useState<MicVolumeLevel>('idle')
  const [micError, setMicError] = useState('')
  const [pttKey, setPttKey] = useState('AltLeft')
  const [handsFreeKey, setHandsFreeKey] = useState('Alt+L')
  const [audioRetentionEnabled, setAudioRetentionEnabled] = useState(true)
  const [audioRetentionDays, setAudioRetentionDays] = useState(30)
  const [logRetentionDays, setLogRetentionDays] = useState(30)
  const [readySoundEnabled, setReadySoundEnabled] = useState(true)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    bridge.getAutoLaunch().then(setAutoLaunch)
    getSetting('autoCheckUpdate', true).then((value) => setAutoCheckUpdate(Boolean(value)))
    getSetting('selectedMic', '').then(setSelectedMic)
    getSetting('shortcutPTT', 'AltRight').then((value) => setPttKey(value as string))
    getSetting('shortcutHandsFree', 'Alt+L').then((value) => setHandsFreeKey(value as string))
    getSetting('audioRetentionEnabled', true).then((value) => setAudioRetentionEnabled(Boolean(value)))
    getSetting('readySoundEnabled', true).then((value) => setReadySoundEnabled(Boolean(value)))
    getSetting('audioRetentionDays', -1).then((value) => {
      const v = Number(value)
      if (v === 7 || v === 30 || v === 90 || v === -1) setAudioRetentionDays(v)
    })
    getSetting('logRetentionDays', 30).then((value) => {
      const v = Number(value)
      if (v === 7 || v === 15 || v === 30 || v === 90) setLogRetentionDays(v)
    })
    listMicrophones().then(setMics).catch(() => {})
  }, [])

  const toggleAutoLaunch = async () => { const next = !autoLaunch; setAutoLaunch(next); await bridge.setAutoLaunch(next) }
  const toggleAutoCheckUpdate = async () => { const next = !autoCheckUpdate; setAutoCheckUpdate(next); await setSetting('autoCheckUpdate', next) }
  const handleMicChange = async (deviceId: string) => { setSelectedMic(deviceId); await setSetting('selectedMic', deviceId); await refreshRecorderSettings() }
  const toggleAudioRetention = async () => { const next = !audioRetentionEnabled; setAudioRetentionEnabled(next); await setSetting('audioRetentionEnabled', next) }
  const toggleReadySound = async () => { const next = !readySoundEnabled; setReadySoundEnabled(next); await setSetting('readySoundEnabled', next); await refreshRecorderSettings() }
  const handleAudioRetentionDaysChange = async (value: number) => { setAudioRetentionDays(value); await setSetting('audioRetentionDays', value) }
  const handleLogRetentionDaysChange = async (value: number) => { setLogRetentionDays(value); await setSetting('logRetentionDays', value) }
  const handlePTTChange = async (value: string) => { setPttKey(value); await setSetting('shortcutPTT', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }
  const handleHandsFreeChange = async (value: string) => { setHandsFreeKey(value); await setSetting('shortcutHandsFree', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }

  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current; if (!canvas) return
    const context = canvas.getContext('2d'); if (!context) return
    const draw = () => { drawBars(context, analyser, canvas.width, canvas.height); animRef.current = requestAnimationFrame(draw) }
    draw()
  }, [])

  const testMic = async () => {
    if (testing) return; setTesting(true); setVolumeLevel('idle'); setMicError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: selectedMic ? { deviceId: { exact: selectedMic } } : true })
      const context = new AudioContext(); const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.7
      source.connect(analyser); resetWaveform(); drawWaveform(analyser)

      // 音量检测：每 500ms 采样一次，取 5 秒内的峰值 RMS 判断级别
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      let peakRms = 0
      const volumeCheckId = setInterval(() => {
        analyser.getByteTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / dataArray.length)
        if (rms > peakRms) peakRms = rms
        // 实时更新级别
        if (peakRms < 0.002) setVolumeLevel('silent')
        else if (peakRms < 0.02) setVolumeLevel('low')
        else setVolumeLevel('normal')
      }, 500)

      setTimeout(() => {
        clearInterval(volumeCheckId)
        cancelAnimationFrame(animRef.current)
        stream.getTracks().forEach((t) => t.stop()); context.close(); setTesting(false)
      }, 5000)
    } catch (err) {
      const msg = err instanceof DOMException && err.name === 'NotFoundError'
        ? '未检测到麦克风设备，请连接麦克风后重试'
        : err instanceof DOMException && err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在系统设置中允许访问麦克风'
          : '麦克风访问失败，请检查设备连接'
      setMicError(msg)
      setTesting(false); setVolumeLevel('idle')
    }
  }

  const [exportResult, setExportResult] = useState<{ filePath: string | null; canceled: boolean } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null)

  const handleExportSettings = async () => {
    const r = await exportSettings()
    setExportResult(r)
    if (!r.canceled) setTimeout(() => setExportResult(null), 8000)
  }
  const handleExportAll = async () => {
    setExporting(true)
    setExportProgress(null)
    const unlisten = await listen<{ current: number; total: number }>('export-progress', (e) => {
      setExportProgress({ current: e.payload.current, total: e.payload.total })
    })
    try {
      const r = await exportAllDataBundle()
      setExportResult(r)
      if (!r.canceled) setTimeout(() => setExportResult(null), 15000)
    } finally {
      unlisten()
      setExporting(false)
      setExportProgress(null)
    }
  }
  const handleRevealExport = () => {
    if (exportResult?.filePath) {
      void invoke('reveal_file_in_folder', { filePath: exportResult.filePath })
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">设置</h1>
      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">键盘快捷键</h2>
            <div className="space-y-4">
              <ComboShortcutInput value={handsFreeKey} onChange={handleHandsFreeChange} label="免提模式" description="按一次开始，再按一次结束，支持单键或组合键" />
              <PTTShortcutInput value={pttKey} onChange={handlePTTChange} label="按住说话" description="按住按键开始录音，松开结束，支持单个按键" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">录音就绪提示音</p>
                <p className="text-xs text-muted-foreground">按下热键后，录音准备好时播放一声短促提示音</p>
              </div>
              <Switch checked={readySoundEnabled} onChange={() => void toggleReadySound()} />
            </div>
          </CardContent>
        </Card>

        <MicrophoneSection mics={mics} selectedMic={selectedMic} testing={testing} volumeLevel={volumeLevel}
          onCanvasRef={(node) => { canvasRef.current = node }} onMicChange={handleMicChange} onTestMic={testMic} errorMessage={micError} />

        <AppSection autoLaunch={autoLaunch} onToggleAutoLaunch={toggleAutoLaunch} autoCheckUpdate={autoCheckUpdate} onToggleAutoCheckUpdate={toggleAutoCheckUpdate} />

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">音频保留</h2>
                <p className="mt-1 text-sm text-muted-foreground">录音结束后自动保存音频文件到本地，可在历史记录中回放和重新识别。</p>
              </div>
              <Switch checked={audioRetentionEnabled} onChange={() => void toggleAudioRetention()} />
            </div>
            {audioRetentionEnabled && (
              <div className="mt-4">
                <label className="text-sm text-muted-foreground">保留时长</label>
                <div className="mt-2 flex gap-2">
                  {([{ value: 7, label: '7 天' }, { value: 30, label: '1 个月' }, { value: 90, label: '3 个月' }, { value: -1, label: '永久' }] as const).map((opt) => (
                    <button key={opt.value} type="button" onClick={() => void handleAudioRetentionDaysChange(opt.value)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${audioRetentionDays === opt.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-accent'}`}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div>
              <h2 className="text-lg font-semibold">日志保留</h2>
              <p className="mt-1 text-sm text-muted-foreground">运行日志用于排查问题，超过保留时长的日志将自动清理。</p>
            </div>
            <div className="mt-4">
              <div className="flex gap-2">
                {([{ value: 7, label: '7 天' }, { value: 15, label: '15 天' }, { value: 30, label: '1 个月' }, { value: 90, label: '3 个月' }] as const).map((opt) => (
                  <button key={opt.value} type="button" onClick={() => void handleLogRetentionDaysChange(opt.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${logRetentionDays === opt.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-accent'}`}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">数据导出</h2>
                <p className="mt-1 text-sm text-muted-foreground">可导出当前设置，或一键打包导出历史、收藏、热词和设置。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleExportSettings()}>
                  <Download className="mr-1 h-4 w-4" />导出设置
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleExportAll()} disabled={exporting}>
                  <Download className="mr-1 h-4 w-4" />{exporting ? '导出中...' : '导出全部（含音频）'}
                </Button>
              </div>
            </div>
            {exporting && exportProgress && (
              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.round((exportProgress.current / exportProgress.total) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {exportProgress.current} / {exportProgress.total} 文件
                </p>
              </div>
            )}
            {exportResult && !exportResult.canceled && exportResult.filePath && (
              <div className="mt-3 flex items-center gap-2 text-xs text-success">
                <Check className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">已保存到 {exportResult.filePath}</span>
                <button
                  onClick={handleRevealExport}
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {exportResult?.canceled && (
              <p className="mt-3 text-xs text-muted-foreground">已取消导出。</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
