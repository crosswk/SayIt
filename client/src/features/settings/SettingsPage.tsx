import * as bridge from '@/services/bridge'
import { refreshPTTSetting } from '@/services/webviewKeyboardFallback'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { listMicrophones } from '@/services/audio'
import { BUILTIN_APP_RULES, createDefaultUserStats } from '@/services/personalization/defaults'
import {
  getAppPromptRules,
  getUserStats,
  saveAppPromptRules,
} from '@/services/personalization/store'
import type { AppPromptRule, UserStats } from '@/services/personalization/types'
import { refreshPreset, refreshRecorderSettings } from '@/services/recorder'
import {
  deletePromptPreset,
  getActivePresetId,
  getPromptPresets,
  getSetting,
  savePromptPreset,
  setActivePresetId,
  setSetting,
  type PromptPreset,
} from '@/services/store'
import { drawBars, resetWaveform } from '@/services/waveform'
import AppSection from './AppSection'
import AppPromptRulesSection from './AppPromptRulesSection'
import DiagnosticsSection from './DiagnosticsSection'
import MicrophoneSection from './MicrophoneSection'
import type { MicVolumeLevel } from './MicrophoneSection'
import OverlaySection from './OverlaySection'
import PromptPresetSection from './PromptPresetSection'
import { ComboShortcutInput, PTTShortcutInput } from './ShortcutInputs'
import UserStatsSection from './UserStatsSection'
import { type OverlayWaveTheme } from './utils'

export default function SettingsPage() {
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState('')
  const [testing, setTesting] = useState(false)
  const [volumeLevel, setVolumeLevel] = useState<MicVolumeLevel>('idle')
  const [micError, setMicError] = useState('')
  const [pttKey, setPttKey] = useState('AltLeft')
  const [handsFreeKey, setHandsFreeKey] = useState('Alt+L')
  const [overlayWaveTheme, setOverlayWaveTheme] = useState<OverlayWaveTheme>('black-rainbow')
  const [overlayShowDuration, setOverlayShowDuration] = useState(true)
  const [readySoundEnabled, setReadySoundEnabled] = useState(true)
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [activePresetId, setActiveId] = useState('intent')
  const [editingPreset, setEditingPreset] = useState<PromptPreset | null>(null)
  const [appPromptRules, setAppPromptRules] = useState<AppPromptRule[]>([])
  const [userStats, setUserStats] = useState<UserStats>(createDefaultUserStats())

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    bridge.getAutoLaunch().then(setAutoLaunch)
    getSetting('autoCheckUpdate', true).then((value) => setAutoCheckUpdate(Boolean(value)))
    getSetting('selectedMic', '').then(setSelectedMic)
    getSetting('shortcutPTT', 'AltRight').then((value) => setPttKey(value as string))
    getSetting('shortcutHandsFree', 'Alt+L').then((value) => setHandsFreeKey(value as string))
    getSetting('overlayWaveTheme', 'black-rainbow').then((value) => {
      const next = value as OverlayWaveTheme
      if (next === 'black-white' || next === 'black-blue' || next === 'black-rainbow') {
        setOverlayWaveTheme(next)
      }
    })
    getSetting('overlayShowDuration', true).then((value) => setOverlayShowDuration(Boolean(value)))
    getSetting('readySoundEnabled', true).then((value) => setReadySoundEnabled(Boolean(value)))
    listMicrophones().then(setMics).catch(() => {})
    getPromptPresets().then(setPresets)
    getActivePresetId().then(setActiveId)
    getAppPromptRules().then(setAppPromptRules)
    getUserStats().then(setUserStats)
  }, [])

  const toggleAutoLaunch = async () => {
    const next = !autoLaunch
    setAutoLaunch(next)
    await bridge.setAutoLaunch(next)
  }

  const toggleAutoCheckUpdate = async () => {
    const next = !autoCheckUpdate
    setAutoCheckUpdate(next)
    await setSetting('autoCheckUpdate', next)
  }

  const handleMicChange = async (deviceId: string) => {
    setSelectedMic(deviceId)
    await setSetting('selectedMic', deviceId)
    await refreshRecorderSettings()
  }

  const handleOverlayThemeChange = async (theme: OverlayWaveTheme) => {
    setOverlayWaveTheme(theme)
    await setSetting('overlayWaveTheme', theme)
    await refreshRecorderSettings()
  }

  const toggleOverlayDuration = async () => {
    const next = !overlayShowDuration
    setOverlayShowDuration(next)
    await setSetting('overlayShowDuration', next)
    await refreshRecorderSettings()
  }

  const toggleReadySound = async () => {
    const next = !readySoundEnabled
    setReadySoundEnabled(next)
    await setSetting('readySoundEnabled', next)
    await refreshRecorderSettings()
  }

  const handlePTTChange = async (value: string) => {
    setPttKey(value)
    await setSetting('shortcutPTT', value)
    bridge.notifyShortcutsChanged()
    refreshPTTSetting()
  }

  const handleHandsFreeChange = async (value: string) => {
    setHandsFreeKey(value)
    await setSetting('shortcutHandsFree', value)
    bridge.notifyShortcutsChanged()
    refreshPTTSetting()
  }

  const handleSelectPreset = async (id: string) => {
    setActiveId(id)
    await setActivePresetId(id)
    await refreshPreset()
  }

  const handleSavePreset = async (preset: PromptPreset) => {
    await savePromptPreset(preset)
    setPresets(await getPromptPresets())
    setEditingPreset(null)
    if (preset.id === activePresetId) {
      await refreshPreset()
    }
  }

  const handleDeletePreset = async (id: string) => {
    await deletePromptPreset(id)
    setPresets(await getPromptPresets())
    if (id === activePresetId) {
      setActiveId('intent')
      await refreshPreset()
    }
  }

  const handleNewPreset = () => {
    setEditingPreset({
      id: Date.now().toString(36),
      name: '',
      systemPrompt: '',
    })
  }

  const handleSaveAppRule = async (rule: AppPromptRule) => {
    const nextRules = appPromptRules
      .map((item) => (item.id === rule.id ? rule : item))
      .sort((left, right) => right.priority - left.priority)
    setAppPromptRules(nextRules)
    await saveAppPromptRules(nextRules)
    await refreshRecorderSettings()
  }

  const handleResetAppRule = async (ruleId: string) => {
    const fallback = BUILTIN_APP_RULES.find((rule) => rule.id === ruleId)
    if (!fallback) return
    const nextRules = appPromptRules
      .map((rule) => (rule.id === ruleId ? { ...fallback, matcher: { ...fallback.matcher } } : rule))
      .sort((left, right) => right.priority - left.priority)
    setAppPromptRules(nextRules)
    await saveAppPromptRules(nextRules)
    await refreshRecorderSettings()
  }

  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const draw = () => {
      drawBars(context, analyser, canvas.width, canvas.height)
      animRef.current = requestAnimationFrame(draw)
    }

    draw()
  }, [])

  const testMic = async () => {
    if (testing) return
    setTesting(true); setVolumeLevel('idle'); setMicError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
      })

      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.7
      source.connect(analyser)
      resetWaveform()
      drawWaveform(analyser)

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
        if (peakRms < 0.002) setVolumeLevel('silent')
        else if (peakRms < 0.02) setVolumeLevel('low')
        else setVolumeLevel('normal')
      }, 500)

      setTimeout(() => {
        clearInterval(volumeCheckId)
        cancelAnimationFrame(animRef.current)
        stream.getTracks().forEach((track) => track.stop())
        context.close()
        setTesting(false)
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

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-6 text-2xl font-bold">设置</h1>

      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">键盘快捷键</h2>
            <div className="space-y-4">
              <PTTShortcutInput
                value={pttKey}
                onChange={handlePTTChange}
                label="按住说话"
                description="按住按键开始录音，松开结束，支持单个按键"
              />
              <ComboShortcutInput
                value={handsFreeKey}
                onChange={handleHandsFreeChange}
                label="免提模式"
                description="按一次开始，再按一次结束，支持单键或组合键"
              />
            </div>
          </CardContent>
        </Card>

        <PromptPresetSection
          presets={presets}
          activePresetId={activePresetId}
          editingPreset={editingPreset}
          onSelectPreset={handleSelectPreset}
          onStartNewPreset={handleNewPreset}
          onStartEditing={setEditingPreset}
          onEditingPresetChange={setEditingPreset}
          onCancelEditing={() => setEditingPreset(null)}
          onSavePreset={handleSavePreset}
          onDeletePreset={handleDeletePreset}
        />

        <AppPromptRulesSection
          presets={presets}
          rules={appPromptRules}
          onSaveRule={handleSaveAppRule}
          onResetRule={handleResetAppRule}
        />

        <UserStatsSection userStats={userStats} />

        <DiagnosticsSection />

        <MicrophoneSection
          mics={mics}
          selectedMic={selectedMic}
          testing={testing}
          volumeLevel={volumeLevel}
          onCanvasRef={(node) => {
            canvasRef.current = node
          }}
          onMicChange={handleMicChange}
          onTestMic={testMic}
          errorMessage={micError}
        />

        <OverlaySection
          overlayWaveTheme={overlayWaveTheme}
          overlayShowDuration={overlayShowDuration}
          readySoundEnabled={readySoundEnabled}
          onOverlayThemeChange={handleOverlayThemeChange}
          onToggleOverlayDuration={toggleOverlayDuration}
          onToggleReadySound={toggleReadySound}
        />

        <AppSection
          autoLaunch={autoLaunch}
          onToggleAutoLaunch={toggleAutoLaunch}
          autoCheckUpdate={autoCheckUpdate}
          onToggleAutoCheckUpdate={toggleAutoCheckUpdate}
        />
      </div>
    </div>
  )
}
