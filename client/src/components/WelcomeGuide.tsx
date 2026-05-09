import { useEffect, useState } from 'react'
import { Mic, Sparkles, Globe, ArrowRight, ArrowLeft, CheckCircle2, AlertCircle, Keyboard } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { getSetting, setSetting } from '@/services/store'
import { getWorkMode } from '@/services/transcription'
import { healthCheck } from '@/services/api'
import { setPttSuppressed } from '@/services/recorder'
import * as bridge from '@/services/bridge'
import appIcon from '@/assets/icon-128.png'

const KEY_MAP: Record<string, string> = {
  AltLeft: '左 Alt', AltRight: '右 Alt',
  ControlLeft: '左 Ctrl', ControlRight: '右 Ctrl',
  ShiftLeft: '左 Shift', ShiftRight: '右 Shift',
  MetaLeft: '左 Win', MetaRight: '右 Win',
  Space: '空格', CapsLock: 'Caps Lock',
}

/** 简化键盘布局，高亮当前快捷键 */
function KeyboardHint({ activeKey, pressed }: { activeKey: string; pressed?: boolean }) {
  const rows: { code: string; label: string; w?: number }[][] = [
    [
      { code: 'ShiftLeft', label: 'Shift', w: 52 },
      { code: 'KeyZ', label: 'Z' }, { code: 'KeyX', label: 'X' },
      { code: 'KeyC', label: 'C' }, { code: 'KeyV', label: 'V' },
      { code: 'KeyB', label: 'B' }, { code: 'KeyN', label: 'N' },
      { code: 'KeyM', label: 'M' }, { code: 'Comma', label: '<' },
      { code: 'Period', label: '>' }, { code: 'Slash', label: '?' },
      { code: 'ShiftRight', label: 'Shift', w: 52 },
    ],
    [
      { code: 'ControlLeft', label: 'Ctrl', w: 42 },
      { code: 'MetaLeft', label: 'Win', w: 34 },
      { code: 'AltLeft', label: 'Alt', w: 34 },
      { code: 'Space', label: '空格', w: 148 },
      { code: 'AltRight', label: 'Alt', w: 34 },
      { code: 'ControlRight', label: 'Ctrl', w: 42 },
    ],
  ]

  return (
    <div className="flex flex-col items-center gap-1">
      {rows.map((row, ri) => (
        <div key={ri} className="flex items-center justify-center gap-1">
          {row.map((key) => {
            const isActive = key.code === activeKey
            const isPressed = isActive && pressed
            return (
              <div
                key={key.code}
                className={`flex items-center justify-center rounded-md transition-all ${
                  isPressed
                    ? 'bg-foreground text-background font-bold shadow-lg ring-2 ring-foreground/30 scale-110'
                    : isActive
                      ? 'bg-primary text-primary-foreground font-semibold shadow-sm ring-2 ring-primary/30'
                      : 'border border-border/60 bg-muted/30 text-muted-foreground'
                }`}
                style={{
                  width: isActive ? (key.w || 30) + 4 : key.w || 30,
                  height: isActive ? 32 : 28,
                  fontSize: isActive ? 12 : 10,
                }}
              >
                {key.label}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

const MODE_LABELS: Record<string, string> = {
  server: '服务器模式',
  cloud_api: '云 API 模式',
  local: '本地模式',
}

interface WelcomeGuideProps {
  onComplete: () => void
}

export default function WelcomeGuide({ onComplete }: WelcomeGuideProps) {
  const [step, setStep] = useState(0)
  const [hfKey, setHfKey] = useState('AltRight')
  const [hfLabel, setHfLabel] = useState('右 Alt')
  const [workMode, setWorkMode] = useState('')
  const [serverOk, setServerOk] = useState<boolean | null>(null)
  const [testText, setTestText] = useState('')
  const [listeningKey, setListeningKey] = useState(false)
  // 热键确认步骤的状态
  const [keyConfirmed, setKeyConfirmed] = useState(false)
  const [keyPressed, setKeyPressed] = useState(false)

  useEffect(() => {
    getSetting('shortcutHandsFree', 'AltRight').then((k) => {
      const key = k as string
      setHfKey(key)
      setHfLabel(KEY_MAP[key] || key)
    })
    const mode = getWorkMode()
    setWorkMode(mode)
    if (mode === 'server') {
      healthCheck().then(() => setServerOk(true)).catch(() => setServerOk(false))
    }
  }, [])

  // 热键确认步骤：监听按键按下和松开，同时抑制录音系统响应热键
  useEffect(() => {
    if (step !== 2) return
    setPttSuppressed(true)
    let lastCode = hfKey
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault()
      const code = e.code
      const label = KEY_MAP[code]
      if (label) {
        lastCode = code
        setHfKey(code)
        setHfLabel(label)
        setKeyPressed(true)
      }
    }
    const onUp = (e: KeyboardEvent) => {
      e.preventDefault()
      if (keyPressed) {
        setKeyPressed(false)
        setKeyConfirmed(true)
        void (async () => {
          await setSetting('shortcutHandsFree', lastCode)
          bridge.notifyShortcutsChanged()
        })()
      }
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      setPttSuppressed(false)
    }
  }, [step, keyPressed, hfKey])

  // 试一试步骤：监听按键修改快捷键
  useEffect(() => {
    if (!listeningKey) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      const code = e.code
      const label = KEY_MAP[code]
      if (label) {
        setHfKey(code)
        setHfLabel(label)
        void (async () => {
          await setSetting('shortcutHandsFree', code)
          bridge.notifyShortcutsChanged()
        })()
      }
      setListeningKey(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [listeningKey])

  const canTest = workMode === 'server' && serverOk === true
  const totalSteps = 5
  const isLast = step === totalSteps - 1

  const renderStep = () => {
    switch (step) {
      // Step 0: 欢迎
      case 0:
        return (
          <div className="flex flex-col items-center text-center">
            <img src={appIcon} alt="SayIt" className="mb-6 h-20 w-20 rounded-2xl" />
            <h1 className="text-3xl font-bold tracking-tight" style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800 }}>欢迎使用 SayIt</h1>
            <p className="mt-3 text-base text-muted-foreground">语音输入，AI 润色</p>
            <p className="mt-1.5 text-sm text-muted-foreground/70">按一下开始说话，再按一下完成输入</p>
          </div>
        )

      // Step 1: 核心功能
      case 1:
        return (
          <div>
            <h2 className="mb-5 text-center text-xl font-bold">核心功能</h2>
            <div className="space-y-3">
              {[
                { icon: Mic, title: '免提语音输入', desc: '按一下开始说话，再按一下停止，文字自动输入到光标位置', color: 'text-blue-500 bg-blue-500/10' },
                { icon: Sparkles, title: 'AI 智能润色', desc: '口语自动转书面语，支持自定义 Prompt，完全掌控 AI 行为', color: 'text-amber-500 bg-amber-500/10' },
                { icon: Globe, title: '灵活部署', desc: '支持服务器、云 API、本地三种模式，按需选择，数据流向透明可控', color: 'text-emerald-500 bg-emerald-500/10' },
              ].map(({ icon: Icon, title, desc, color }) => (
                <Card key={title}>
                  <CardContent className="flex items-center gap-4 p-4">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${color}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )

      // Step 2: 热键确认
      case 2:
        return (
          <div className="flex flex-col items-center text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Keyboard className="h-7 w-7 text-primary" />
            </div>
            <h2 className="text-xl font-bold">设置免提热键</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {keyConfirmed
                ? '热键已确认，你可以继续下一步'
                : <>默认热键为 <span className="font-medium text-foreground">右 Alt</span>，按下即可确认；也可以按其他按键更换</>}
            </p>

            {/* 大号按键展示 */}
            <div className="my-6">
              <div
                className={`inline-flex items-center justify-center rounded-xl border-2 px-8 py-4 text-lg font-bold transition-all ${
                  keyPressed
                    ? 'border-foreground bg-foreground text-background scale-105 shadow-xl'
                    : keyConfirmed
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600'
                      : 'border-primary/40 bg-primary/5 text-primary animate-pulse'
                }`}
              >
                {keyPressed ? `${hfLabel} ⬇` : keyConfirmed ? `✓ ${hfLabel}` : hfLabel}
              </div>
            </div>

            {/* 键盘位置示意 */}
            <div className="w-full rounded-xl border bg-card p-3">
              <p className="mb-2 text-[11px] text-muted-foreground">按键位置</p>
              <KeyboardHint activeKey={hfKey} pressed={keyPressed} />
            </div>

            {!keyConfirmed && (
              <p className="mt-4 text-xs text-muted-foreground/60">
                支持的按键：左/右 Alt、左/右 Ctrl、左/右 Shift、空格、CapsLock、F1–F12
              </p>
            )}
            {keyConfirmed && (
              <p className="mt-4 text-xs text-muted-foreground">
                如需更换，直接按下其他按键即可
              </p>
            )}
          </div>
        )

      // Step 3: 试一试
      case 3:
        return (
          <div>
            <h2 className="mb-5 text-center text-xl font-bold">试一试</h2>

            <Card className="mb-4">
              <CardContent className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                    <Keyboard className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">免提快捷键</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">点击右侧按钮修改</p>
                  </div>
                </div>
                <button
                  onClick={() => setListeningKey(true)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-all ${
                    listeningKey
                      ? 'border-primary bg-primary/10 text-primary animate-pulse'
                      : 'border-border bg-muted/50 text-foreground hover:border-primary/50'
                  }`}
                >
                  {listeningKey ? '按下新按键...' : hfLabel}
                </button>
              </CardContent>
            </Card>

            <Card className="mb-4">
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">当前模式</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{MODE_LABELS[workMode] || workMode}</p>
                </div>
                {workMode === 'server' && (
                  <div className="flex items-center gap-1.5">
                    {serverOk === null ? (
                      <span className="text-xs text-muted-foreground">检测中...</span>
                    ) : serverOk ? (
                      <><CheckCircle2 className="h-4 w-4 text-emerald-500" /><span className="text-xs text-emerald-600">已连接</span></>
                    ) : (
                      <><AlertCircle className="h-4 w-4 text-destructive" /><span className="text-xs text-destructive">未连接</span></>
                    )}
                  </div>
                )}
                {workMode !== 'server' && (
                  <span className="text-xs text-muted-foreground">需在设置中配置</span>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <p className="mb-2 text-sm font-medium">{canTest ? '语音输入测试' : '语音测试'}</p>
                {canTest && (
                  <p className="mb-2 text-xs text-muted-foreground">请先点击下方文本框聚焦光标，然后按 {hfLabel} 开始说话，再按一次停止</p>
                )}
                <textarea
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  placeholder={canTest
                    ? `点击这里，然后按 ${hfLabel} 开始说话...`
                    : '当前模式暂不支持在此测试。完成向导后，可在设置中配置语音引擎，然后在任意应用中使用。'}
                  className="w-full resize-none rounded-lg border border-input-border bg-input-bg p-3 text-sm leading-relaxed placeholder:text-muted-foreground/40 focus:border-input-focus-border focus:outline-none"
                  rows={4}
                  readOnly={!canTest}
                />
                {!canTest && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    提示：完成向导后，前往「语音引擎」或「AI 服务」配置后即可在任何应用中按 {hfLabel} 使用
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )

      // Step 4: 完成
      case 4:
        return (
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            </div>
            <h2 className="text-xl font-bold">准备就绪</h2>
            <p className="mt-3 text-sm text-muted-foreground">
              在任何应用中按 <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-medium text-foreground">{hfLabel}</span> 开始说话
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground/70">再按一次停止，文字自动输入到光标位置</p>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="custom-scrollbar w-full max-w-lg max-h-[90vh] overflow-y-auto px-6 py-8">
        {renderStep()}

        {/* 底部导航 */}
        <div className="mt-8 flex items-center justify-between">
          <div className="flex gap-1.5">
            {Array.from({ length: totalSteps }, (_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-6 bg-primary' : 'w-1.5 bg-muted-foreground/20'
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                上一步
              </button>
            )}
            {!isLast && step === 0 && (
              <button
                onClick={onComplete}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                跳过
              </button>
            )}
            <button
              onClick={() => isLast ? onComplete() : setStep(step + 1)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {isLast ? '开始使用' : '下一步'}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
