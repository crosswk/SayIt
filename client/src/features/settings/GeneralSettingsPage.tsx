// 通用设置页面 — 主题、快捷键、麦克风、悬浮窗、开机启动、音频保留、数据导出

import * as bridge from '@/services/bridge'
import { refreshPTTSetting } from '@/services/webviewKeyboardFallback'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { listMicrophones, normalizeSelectedMicId } from '@/services/audio'
import { refreshRecorderSettings } from '@/services/recorder'
import { getPresetShortcuts, getSetting, setSetting } from '@/services/store'
import { getDefault } from '@/services/defaults'
import { drawBars, resetWaveform } from '@/services/waveform'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import AppSection from './AppSection'
import BackupSection from './BackupSection'
import WebDavSection from './WebDavSection'
import MicrophoneSection from './MicrophoneSection'
import type { MicVolumeLevel } from './MicrophoneSection'
import { ComboShortcutInput, PTTShortcutInput } from './ShortcutInputs'
import { pttShortcutConflictsWithAccelerator } from '@/lib/shortcutKeys'
import { t, type LanguagePreference, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { getLanguagePreference, switchLanguage } from '@/stores/language'
import { IS_MAC } from '@/lib/platform'
import { MacPermissionsPanel } from '@/components/MacPermissionsPanel'

/** 语言名一律用该语言自己的写法（English / 简体中文），不做翻译 —— 看不懂当前
 *  界面语言的人，正是靠认出自己的语言名才能切回去的。 */
const LANGUAGE_OPTIONS = [
  { value: 'auto', labelKey: 'language.auto' },
  { value: 'zh-CN', labelKey: 'language.zhCN' },
  { value: 'en', labelKey: 'language.en' },
] as const satisfies readonly { value: LanguagePreference; labelKey: TranslationKey }[]

function ShortcutLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <Tooltip variant="light" content={help}>
        <Info
          aria-label={t('settings.helpAria', { label })}
          className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground"
        />
      </Tooltip>
    </span>
  )
}

export default function GeneralSettingsPage() {
  const t = useT()
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>('auto')
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState('')
  const [testing, setTesting] = useState(false)
  const [volumeLevel, setVolumeLevel] = useState<MicVolumeLevel>('idle')
  const [micError, setMicError] = useState('')
  const [muteSystemAudio, setMuteSystemAudio] = useState(false)
  const [protectClipboard, setProtectClipboard] = useState(true)
  // 兜底值统一从 defaults 取，不在这里写第二份字面量
  const [pttKey, setPttKey] = useState(() => getDefault<string>('shortcutPTT', ''))
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')
  const [aiToggleKey, setAiToggleKey] = useState('')
  const [historyEnabled, setHistoryEnabled] = useState(true)
  const [audioRetentionEnabled, setAudioRetentionEnabled] = useState(true)
  const [audioRetentionDays, setAudioRetentionDays] = useState(30)
  const [logRetentionDays, setLogRetentionDays] = useState(30)
  const [readySoundEnabled, setReadySoundEnabled] = useState(true)
  // 读到已保存值之前，开关先隐藏、不放动画：避免「默认值 → 已保存值」闪一下
  const [ready, setReady] = useState(false)
  // animate 与 ready 分开：ready 决定何时显示，animate 决定何时允许过渡。
  // 若在揭开/赋值的同一帧就把 transition 加回来，按 CSS 规范浏览器会认为
  // 「有过渡且值变了」，于是把「默认值→已保存值」真的动画一遍（看起来就是闪一下）。
  // 所以揭开那一帧仍不带过渡，隔两帧待值稳定后才开过渡。
  const [animate, setAnimate] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    let cancelled = false
    // 开关类设置：先把值全部取回，再在同一个同步块里一次性落值 + 置 ready，让 React
    // 合成一次渲染 —— 不存在「已显示但值还没到」的中间态（那正是开关闪一下的成因）。
    // 每项自带 catch 兜底：Promise.all 是 fail-fast，只要一项 reject 就会在其余项
    // 还没回来时提前放行 ready。也不用 rAF，避免 setReady 与赋值分到不同批次。
    void (async () => {
      const [launch, mute, clip, history, retention, readySound, audioDays, logDays] = await Promise.all([
        bridge.getAutoLaunch().catch(() => false),
        getSetting('muteSystemAudioWhileRecording', false).catch(() => false),
        getSetting('protectClipboard', true).catch(() => true),
        getSetting('historyEnabled', true).catch(() => true),
        getSetting('audioRetentionEnabled', true).catch(() => true),
        getSetting('readySoundEnabled', true).catch(() => true),
        getSetting('audioRetentionDays', -1).catch(() => -1),
        getSetting('logRetentionDays', 30).catch(() => 30),
      ])
      if (cancelled) return
      setAutoLaunch(Boolean(launch))
      setMuteSystemAudio(Boolean(mute))
      setProtectClipboard(Boolean(clip))
      setHistoryEnabled(Boolean(history))
      setAudioRetentionEnabled(Boolean(retention))
      setReadySoundEnabled(Boolean(readySound))
      const ad = Number(audioDays)
      if (ad === 7 || ad === 30 || ad === 90 || ad === -1) setAudioRetentionDays(ad)
      const ld = Number(logDays)
      if (ld === 7 || ld === 15 || ld === 30 || ld === 90) setLogRetentionDays(ld)
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setAnimate(true)
      }))
    })()
    getLanguagePreference().then(setLanguagePreference).catch(() => { })
    // 存量数据里有 `selectedMic = "default"`（老版本的下拉把 Chromium 的伪设备也列
    // 出来，用户点了它）。伪设备已经不在设备列表里，不折成空串的话下拉找不到选中项、
    // 显示成"没有选择麦克风"。折完写回一次，否则录音那侧读到的仍是旧值。
    getSetting('selectedMic', '').then(async (raw) => {
      if (cancelled) return
      const normalized = normalizeSelectedMicId(raw)
      setSelectedMic(normalized)
      if (typeof raw === 'string' && raw !== normalized) {
        await setSetting('selectedMic', normalized)
        await refreshRecorderSettings()
      }
    }).catch(() => { })
    getSetting<string>('shortcutPTT').then((value) => setPttKey(value))
    getSetting('shortcutHandsFree', 'AltRight').then((value) => setHandsFreeKey(value as string))
    getSetting('shortcutToggleAi', '').then((value) => setAiToggleKey(value as string))
    listMicrophones().then(setMics).catch(() => { })
    return () => { cancelled = true }
  }, [])

  // 先切内存里的语言让界面立刻响应，再落库。失败时把选中项回滚到真实的持久化值，
  // 不留「按钮已高亮但其实没保存」这种假成功。
  const handleLanguageChange = async (next: LanguagePreference) => {
    const previous = languagePreference
    setLanguagePreference(next)
    try {
      await switchLanguage(next)
    } catch {
      setLanguagePreference(previous)
      await switchLanguage(previous).catch(() => { })
    }
    // 托盘菜单（以及 mac 的顶部应用菜单）是原生的，不会跟着网页换语言，要让 Rust 改文字
    void bridge.refreshNativeMenus().catch(() => { })
  }
  const toggleAutoLaunch = async () => { const next = !autoLaunch; setAutoLaunch(next); await bridge.setAutoLaunch(next) }
  const handleMicChange = async (deviceId: string) => { setSelectedMic(deviceId); await setSetting('selectedMic', deviceId); await refreshRecorderSettings() }
  const toggleMuteSystemAudio = async () => { const next = !muteSystemAudio; setMuteSystemAudio(next); await setSetting('muteSystemAudioWhileRecording', next); await refreshRecorderSettings() }
  const toggleProtectClipboard = async () => { const next = !protectClipboard; setProtectClipboard(next); await setSetting('protectClipboard', next); await refreshRecorderSettings() }
  const toggleHistoryEnabled = async () => { const next = !historyEnabled; setHistoryEnabled(next); await setSetting('historyEnabled', next) }
  const toggleAudioRetention = async () => { const next = !audioRetentionEnabled; setAudioRetentionEnabled(next); await setSetting('audioRetentionEnabled', next) }
  const toggleReadySound = async () => { const next = !readySoundEnabled; setReadySoundEnabled(next); await setSetting('readySoundEnabled', next); await refreshRecorderSettings() }
  const handleAudioRetentionDaysChange = async (value: number) => { setAudioRetentionDays(value); await setSetting('audioRetentionDays', value) }
  const handleLogRetentionDaysChange = async (value: number) => { setLogRetentionDays(value); await setSetting('logRetentionDays', value) }
  const handlePTTChange = async (value: string) => { setPttKey(value); await setSetting('shortcutPTT', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }
  const handleHandsFreeChange = async (value: string) => { setHandsFreeKey(value); await setSetting('shortcutHandsFree', value); bridge.notifyShortcutsChanged(); refreshPTTSetting() }

  // 应用内部快捷键互斥：免提和按住说话绑同一个键，两个功能会同时被触发；
  // 预设切换的组合键同理。提交前拦下来，而不是等用户按了才发现行为诡异。
  const validatePTT = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(value, handsFreeKey)) {
      return t('settings.shortcuts.conflictHandsFree')
    }
    if (pttShortcutConflictsWithAccelerator(value, aiToggleKey)) {
      return t('settings.shortcuts.conflictAiToggle')
    }
    const presetShortcuts = await getPresetShortcuts()
    if (Object.values(presetShortcuts).some(
      (shortcut) => pttShortcutConflictsWithAccelerator(value, shortcut),
    )) return t('settings.shortcuts.conflictPreset')
    return null
  }, [handsFreeKey, aiToggleKey])
  const validateHandsFree = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(pttKey, value)) {
      return t('settings.shortcuts.conflictPtt')
    }
    if (value === aiToggleKey) return t('settings.shortcuts.conflictAiToggle')
    const presetShortcuts = await getPresetShortcuts()
    if (Object.values(presetShortcuts).includes(value)) return t('settings.shortcuts.conflictPreset')
    return null
  }, [pttKey, aiToggleKey])

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
      const dataArray = new Float32Array(analyser.frequencyBinCount)
      let peakRms = 0
      let sawNonZeroSignal = false
      const volumeCheckId = setInterval(() => {
        analyser.getFloatTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const v = dataArray[i]
          sum += v * v
          if (v !== 0) sawNonZeroSignal = true
        }
        const rms = Math.sqrt(sum / dataArray.length)
        if (rms > peakRms) peakRms = rms
        // 「没有声音」必须严格等于整段全 0；只要出现任何非零输入，就至少是声音偏低。
        if (!sawNonZeroSignal) setVolumeLevel('silent')
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
        ? t('mic.error.notFound')
        : err instanceof DOMException && err.name === 'NotAllowedError'
          ? t('mic.error.denied')
          : t('mic.error.failed')
      setMicError(msg)
      setTesting(false); setVolumeLevel('idle')
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">{t('settings.title')}</h1>
      <div className="space-y-6">
        {/* 界面语言排在最前：看不懂界面的人做不了下面任何一件事。
            这张卡自己走 t()，所以切换后它连自己的标题一起变，用户能立刻确认生效了。 */}
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{t('settings.general.language.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.general.language.hint')}</p>
              </div>
              <div className="shrink-0" style={ready ? undefined : { visibility: 'hidden' }}>
                <Segmented
                  label={t('settings.general.language.title')}
                  value={languagePreference}
                  options={LANGUAGE_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                  onChange={(value) => void handleLanguageChange(value)}
                  animated={animate}
                  className="justify-end"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* macOS：辅助功能 / 麦克风授权。没有它们热键和插字都用不了，所以紧跟在语言后面 */}
        {IS_MAC && (
          <Card>
            <CardContent className="space-y-4 p-6">
              <h2 className="text-lg font-semibold">{t('settings.macPermissions.title')}</h2>
              <MacPermissionsPanel compact />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold">{t('settings.shortcuts.title')}</h2>
            {/* ⚠ 这是「按 Esc 能取消」在整个界面上的**唯一**出处 —— 悬浮窗上那行提示已经
                去掉了（见 overlay/Overlay.tsx 的 thinking 分支）。删掉这句，这个能力就没有
                任何地方告诉用户了。
                录音上限不在这里讲 —— 最后一分钟悬浮窗会显示剩余时间、到点自动结束，界面自己会说。
                「录音也不会保留」要写明：取消和「录了但没出字」在用户眼里很容易混。
                「录音或识别处理」是两个阶段，别连写 —— Esc 在两个阶段都能按。 */}
            <p className="mb-4 mt-1 text-xs text-muted-foreground">
              {t('settings.shortcuts.escHint')}
            </p>
            <div className="space-y-4">
              <ComboShortcutInput
                value={handsFreeKey}
                onChange={handleHandsFreeChange}
                validate={validateHandsFree}
                label={<ShortcutLabel label={t('settings.shortcuts.handsFree')} help={t(IS_MAC ? 'settings.shortcuts.handsFreeHelpMac' : 'settings.shortcuts.handsFreeHelp')} />}
                description={t('settings.shortcuts.handsFreeDesc')}
              />
              <PTTShortcutInput
                value={pttKey}
                onChange={handlePTTChange}
                validate={validatePTT}
                label={<ShortcutLabel label={t('settings.shortcuts.ptt')} help={t(IS_MAC ? 'settings.shortcuts.pttHelpMac' : 'settings.shortcuts.pttHelp')} />}
                description={t('settings.shortcuts.pttDesc')}
              />
            </div>
          </CardContent>
        </Card>

        {/* 麦克风排在「偏好设置」前面：它是录音链路的入口，选错设备什么都录不到；
            而下面那三个开关（提示音、静音外放、剪贴板保护）都是可选的锦上添花。 */}
        <MicrophoneSection mics={mics} selectedMic={selectedMic} testing={testing} volumeLevel={volumeLevel}
          onCanvasRef={(node) => { canvasRef.current = node }} onMicChange={handleMicChange} onTestMic={testMic} errorMessage={micError} />

        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 className="text-lg font-semibold">{t('settings.prefs.title')}</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{t('settings.prefs.readySound')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.readySoundDesc')}</p>
              </div>
              <Switch checked={readySoundEnabled} onChange={() => void toggleReadySound()} noAnimation={!animate} hidden={!ready} />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">{t('settings.prefs.muteSystemAudio')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.muteSystemAudioDesc')}</p>
              </div>
              <Switch checked={muteSystemAudio} onChange={() => void toggleMuteSystemAudio()} noAnimation={!animate} hidden={!ready} />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">{t('settings.prefs.protectClipboard')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.protectClipboardDesc')}</p>
              </div>
              <Switch checked={protectClipboard} onChange={() => void toggleProtectClipboard()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>

        <AppSection autoLaunch={autoLaunch} onToggleAutoLaunch={toggleAutoLaunch} ready={ready} animate={animate} />

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{t('settings.history.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.history.desc')}</p>
              </div>
              <Switch checked={historyEnabled} onChange={() => void toggleHistoryEnabled()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{t('settings.audio.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.audio.desc')}</p>
              </div>
              <Switch checked={audioRetentionEnabled} onChange={() => void toggleAudioRetention()} noAnimation={!animate} hidden={!ready} />
            </div>
            {audioRetentionEnabled && (
              <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <label className="text-sm text-muted-foreground">{t('settings.audio.retentionLabel')}</label>
                <div className="shrink-0" style={ready ? undefined : { visibility: 'hidden' }}>
                  <Segmented
                    label={t('settings.audio.retentionLabel')}
                    value={audioRetentionDays}
                    options={([{ value: 7, labelKey: 'settings.retention.7d' }, { value: 30, labelKey: 'settings.retention.1m' }, { value: 90, labelKey: 'settings.retention.3m' }, { value: -1, labelKey: 'settings.retention.forever' }] as const satisfies readonly { value: number; labelKey: TranslationKey }[]).map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                    onChange={(value) => void handleAudioRetentionDaysChange(value)}
                    animated={animate}
                    className="justify-end"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{t('settings.log.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.log.desc')}</p>
              </div>
              <div className="shrink-0" style={ready ? undefined : { visibility: 'hidden' }}>
                <Segmented
                  label={t('settings.log.title')}
                  value={logRetentionDays}
                  options={([{ value: 7, labelKey: 'settings.retention.7d' }, { value: 15, labelKey: 'settings.retention.15d' }, { value: 30, labelKey: 'settings.retention.1m' }, { value: 90, labelKey: 'settings.retention.3m' }] as const satisfies readonly { value: number; labelKey: TranslationKey }[]).map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                  onChange={(value) => void handleLogRetentionDaysChange(value)}
                  animated={animate}
                  className="justify-end"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <BackupSection />

        <WebDavSection />
      </div>
    </div>
  )
}
