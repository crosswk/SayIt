import { useEffect, useRef, useState } from 'react'
import { Mic, Sparkles, Globe, ArrowRight, ArrowLeft, CheckCircle2, AlertCircle, Keyboard } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { getSetting, setSetting } from '@/services/store'
import { getWorkMode } from '@/services/transcription'
import { healthCheck } from '@/services/api'
import { setPttSuppressed } from '@/services/recorder'
import * as bridge from '@/services/bridge'
import {
  displayShortcut,
  getSingleKeyDisplay,
  isSingleKeySetting,
  keyEventToShortcutCandidate,
  pttShortcutConflictsWithAccelerator,
} from '@/lib/shortcutKeys'
import {
  ComboShortcutInput,
  checkShortcutBeforeCommit,
} from '@/features/settings/ShortcutInputs'
import { refreshPTTSetting, setShortcutCaptureActive } from '@/services/webviewKeyboardFallback'
import appIcon from '@/assets/icon-128.png'
import { t, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { IS_MAC } from '@/lib/platform'
import { getDefault } from '@/services/defaults'
import { MacPermissionsPanel } from '@/components/MacPermissionsPanel'

/** 免提的默认键（Windows 右 Alt，mac 右 ⌘） */
const DEFAULT_HANDS_FREE: string = getDefault<string>('shortcutHandsFree') || 'AltRight'

/**
 * 免提键与「按住说话」撞在同一个键上时，两个功能会被同一次按键同时触发。
 *
 * 模块级函数而不是 useCallback：它进 effect 的依赖数组，引用一变就会把整个录制
 * effect（连带 begin/endShortcutCapture）重启一遍。PTT 设置在这里现读现用，
 * 不需要组件 state。
 */
async function validateHandsFreeAgainstPTT(value: string): Promise<string | null> {
  if (!value) return null
  const ptt = await getSetting('shortcutPTT', 'ControlRight') as string
  return pttShortcutConflictsWithAccelerator(ptt, value)
    ? t('settings.shortcuts.conflictPtt')
    : null
}

/** 保存免提键并让原生侧立刻用上：三步缺一不可，所以只留这一个出口。 */
async function persistHandsFreeShortcut(value: string): Promise<void> {
  await setSetting('shortcutHandsFree', value)
  bridge.notifyShortcutsChanged()
  // 同步刷新 webview 回退缓存，否则向导内（SayIt 窗口聚焦）测试时新键不生效
  await refreshPTTSetting()
}

/** 简化键盘布局，高亮当前快捷键（可以是一组 —— 组合键会同时按住几个） */
function KeyboardHint({ activeKeys, pressed }: { activeKeys: string[]; pressed?: boolean }) {
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
    IS_MAC
      ? [
        // MacBook 的最下面一行：fn ⌃ ⌥ ⌘ 空格 ⌘ ⌥（右侧没有 ⌃）
        { code: 'Fn', label: 'fn', w: 30 },
        { code: 'ControlLeft', label: '⌃', w: 30 },
        { code: 'AltLeft', label: '⌥', w: 30 },
        { code: 'MetaLeft', label: '⌘', w: 38 },
        { code: 'Space', label: t('keyName.Space'), w: 140 },
        { code: 'MetaRight', label: '⌘', w: 38 },
        { code: 'AltRight', label: '⌥', w: 30 },
      ]
      : [
        { code: 'ControlLeft', label: 'Ctrl', w: 42 },
        { code: 'MetaLeft', label: 'Win', w: 34 },
        { code: 'AltLeft', label: 'Alt', w: 34 },
        { code: 'Space', label: t('keyName.Space'), w: 148 },
        { code: 'AltRight', label: 'Alt', w: 34 },
        { code: 'ControlRight', label: 'Ctrl', w: 42 },
      ],
  ]

  return (
    <div className="flex flex-col items-center gap-1">
      {rows.map((row, ri) => (
        <div key={ri} className="flex items-center justify-center gap-1">
          {row.map((key) => {
            const isActive = activeKeys.includes(key.code)
            const isPressed = isActive && pressed
            return (
              <div
                key={key.code}
                className={`flex items-center justify-center rounded-md transition-all ${isPressed
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

const MODE_LABEL_KEYS: Record<string, TranslationKey> = {
  server: 'mode.server',
  cloud_api: 'mode.cloudApi',
  local: 'mode.local',
}

/**
 * 把带 `{key}` 占位的句子渲染成「文字 + 加粗键名 + 文字」。
 * 按占位符切分，键名在句中的位置就由译文决定（中英语序不同）。
 */
function HotkeyPrompt({ template, keyLabel }: { template: string; keyLabel: string }) {
  const [before, after = ''] = template.split('{key}')
  return (
    <>
      {before}
      <span className="font-medium text-foreground">{keyLabel}</span>
      {after}
    </>
  )
}

/** 同 HotkeyPrompt，只是键名用键帽样式。 */
function ReadyHint({ template, keyLabel }: { template: string; keyLabel: string }) {
  const [before, after = ''] = template.split('{key}')
  return (
    <>
      {before}
      <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-medium text-foreground">{keyLabel}</span>
      {after}
    </>
  )
}

interface WelcomeGuideProps {
  onComplete: () => void
}

/** 向导步骤。mac 多一步「权限」：没有辅助功能授权，热键和插字都用不了。 */
const STEP_IDS = ['welcome', 'features', ...(IS_MAC ? ['permissions'] : []), 'hotkey', 'try', 'done'] as const
type StepId = (typeof STEP_IDS)[number]

export default function WelcomeGuide({ onComplete }: WelcomeGuideProps) {
  const t = useT()
  const [step, setStep] = useState(0)
  const stepId: StepId = STEP_IDS[step] ?? 'welcome'
  const [hfKey, setHfKey] = useState(DEFAULT_HANDS_FREE)
  const hfLabel = displayShortcut(hfKey).join(' + ')
  const [workMode, setWorkMode] = useState('')
  const [serverOk, setServerOk] = useState<boolean | null>(null)
  const [testText, setTestText] = useState('')
  // 热键确认步骤的状态
  const [keyConfirmed, setKeyConfirmed] = useState(false)
  /** 手指还按着的那个候选值（未提交）。空串 = 没在按 */
  const [capturing, setCapturing] = useState('')
  /** 当前物理按住的 DOM code。组合键会同时有多个，键盘图靠它高亮 */
  const [pressedCodes, setPressedCodes] = useState<string[]>([])
  /** 这次按键为什么没被采纳（系统保留组合、被别的程序占用、和 PTT 撞） */
  const [captureError, setCaptureError] = useState('')
  const hfKeyRef = useRef(DEFAULT_HANDS_FREE)
  const settingsDirtyRef = useRef(false)

  /** 手指还按着时大号键帽跟着候选走，松开后回到已确认的那个 */
  const shownKey = capturing || hfKey
  const shownLabel = displayShortcut(shownKey).join(' + ')
  const isPressing = pressedCodes.length > 0
  /**
   * 键盘示意图只在「单键」时留着。
   *
   * 它的用途是帮新手找到"右 Alt 在哪"，而图上只有 Shift 那行和最下面一行 ——
   * 组合键的主键（D）本来就不在图上，把图补成整块键盘会把这一步的卡片撑爆。
   * 已经会按组合键的用户也不需要这张图。按下过程中保持显示，避免中途闪一下。
   */
  const showKeyboardHint = isPressing || isSingleKeySetting(shownKey)
  const hintActiveKeys = isPressing ? pressedCodes : [shownKey]

  useEffect(() => {
    getSetting('shortcutHandsFree', DEFAULT_HANDS_FREE).then((k) => {
      const key = k as string
      setHfKey(key)
      hfKeyRef.current = key
    })
    const mode = getWorkMode()
    setWorkMode(mode)
    if (mode === 'server') {
      healthCheck().then(() => setServerOk(true)).catch(() => setServerOk(false))
    }
  }, [])

  // 热键确认步骤：录制免提热键。
  //
  // **单键和组合键（Ctrl+D）都要能录。** 判定与提交校验都复用设置页那两个函数，
  // 口径必须一致 —— 这里以前自己写了一份只认单键白名单的版本，于是按 Ctrl+D 时
  // Ctrl 的 keydown 先到、`ControlLeft` 恰好在白名单里，免提键被静默存成「左 Ctrl」，
  // D 根本没轮到，而用户看到的现象是"组合键不支持"。
  //
  // 只依赖 step，避免 hfKey 等 state 变化导致 effect 反复运行、钩子反复重启。
  useEffect(() => {
    if (stepId !== 'hotkey') return
    setPttSuppressed(true)
    // 挂起本应用自己的全部热键（同设置页录制）：不挂起的话，按一个已经注册过的组合键
    // 会被 RegisterHotKey 抢走、webview 收不到 keydown，等于永远录不进来。
    // 副作用是这一步里热键都不响应 —— 正好，这一步只确认键位，不该开始录音。
    setShortcutCaptureActive(true)
    void bridge.beginShortcutCapture()

    /** 当前按住的物理 code：既给键盘图高亮用，也用来判断某条事件路径是否该让位 */
    const pressed = new Set<string>()
    /** 本次按键周期的状态。用普通对象而非 state：读写要同步，且不能触发 effect 重启 */
    const session = { candidate: '', committing: false }

    const syncPressed = () => setPressedCodes([...pressed])

    const commit = (value: string) => {
      if (session.committing) return
      session.committing = true
      void (async () => {
        const error = await checkShortcutBeforeCommit(value, validateHandsFreeAgainstPTT)
        if (error) {
          setCaptureError(error)
        } else {
          // 存进 ref：state 更新不会重启 effect（state 不在依赖里），ref 才是 cleanup 落盘时的真相
          hfKeyRef.current = value
          settingsDirtyRef.current = true
          setHfKey(value)
          setKeyConfirmed(true)
          setCaptureError('')
        }
        session.candidate = ''
        session.committing = false
        setCapturing('')
      })()
    }

    const isModifierKey = (event: KeyboardEvent) =>
      event.key === 'Control' || event.key === 'Alt'
      || event.key === 'Shift' || event.key === 'Meta'

    // 路径 1：webview 收到的按键。捕获模式下原生钩子会放行已绑定的单键，
    // 所以右 Alt 这类平时被吞掉的键在这一步也走这条路。
    const onDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      const candidate = keyEventToShortcutCandidate(event)
      // **录不成快捷键的键一律放行，不要 preventDefault。**
      // 裸 Tab、裸 Enter 都不是合法的免提键（candidate 为 null），拦下来只会把
      // 键盘用户困在这一步：Tab 移不了焦点，Enter 点不了「下一步」。
      // 修饰键自己也返回 null，但它是组合键的一半，要照常吞掉并记账。
      if (!candidate && !isModifierKey(event)) return
      event.preventDefault()
      pressed.add(event.code)
      syncPressed()
      // candidate 为 null（单按 Ctrl）时保留上一个候选，别覆盖成空 ——
      // 否则 Ctrl+D 里任何一个不成型的中间事件都会把已经录到的组合键抹掉。
      if (candidate) {
        session.candidate = candidate
        setCapturing(candidate)
        setCaptureError('')
      }
    }
    const onUp = (event: KeyboardEvent) => {
      // delete 返回 false = 这个键的 down 被放行过（如 Tab），它的 up 也不该拦
      if (!pressed.delete(event.code)) return
      event.preventDefault()
      syncPressed()
      // 第一次松开就提交本次按住过的候选；session.committing 挡掉后续 keyup
      if (session.candidate) commit(session.candidate)
    }

    // 路径 2：兜底。万一某个键仍被原生钩子吞掉（只 emit 事件、webview 收不到 keydown），
    // 就按老办法确认一次，让这一步不至于卡死。webview 已经在处理时让位，避免重复提交。
    const unlistenHf = bridge.listen('toggle-hands-free', () => {
      if (pressed.size === 0) commit(hfKeyRef.current || DEFAULT_HANDS_FREE)
    })
    const unlistenPttDown = bridge.listen('ptt-down', (event: unknown) => {
      const payload = event as { payload?: { pttSetting?: string } }
      const setting = payload?.payload?.pttSetting
      if (setting && pressed.size === 0) commit(setting)
    })

    // 路径 3：鼠标侧键/中键。webview 收不到（会被当成前进/后退导航），由 Rust 底层
    // 鼠标钩子在 OS 层吞掉后回报。延迟提交见 ShortcutInputs 里的同一处说明；
    // 原生侧捕到一次就自动退出捕获模式，所以提交完要重新打开，否则后面就录不动了。
    const offMouse = bridge.onMouseShortcutCaptured(({ setting }) => {
      if (!setting) return
      window.setTimeout(() => {
        commit(setting)
        void bridge.beginShortcutCapture()
      }, 400)
    })

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      setPttSuppressed(false)
      setShortcutCaptureActive(false)
      setCapturing('')
      setPressedCodes([])
      unlistenHf.then((fn) => fn())
      unlistenPttDown.then((fn) => fn())
      offMouse()

      // 立刻退出捕获模式，**不等落盘**。
      //
      // 顺序反过来（先 await 落盘）会留一个竞态：下一步那个录制控件自己会
      // beginShortcutCapture，而这边迟到的 endShortcutCapture 会把它刚开的捕获关掉，
      // 于是用户在「试一试」里按组合键录不进去。
      // 两个命令都是「从存储读当前值重新注册一遍」，谁后执行都不会注册到错的键上：
      // notifyShortcutsChanged 一定排在 setSetting 之后发出。
      //
      // **退出必须无条件执行** —— 漏掉的话用户走完向导会发现所有热键都不响应了。
      void bridge.endShortcutCapture()
      if (settingsDirtyRef.current) {
        settingsDirtyRef.current = false
        void persistHandsFreeShortcut(hfKeyRef.current)
      }
    }
  }, [stepId])

  const canTest = workMode === 'server' && serverOk === true
  const totalSteps = STEP_IDS.length
  const isLast = step === totalSteps - 1

  const renderStep = () => {
    switch (stepId) {
      // Step 0: 欢迎
      case 'welcome':
        return (
          <div className="flex flex-col items-center text-center">
            <img src={appIcon} alt="SayIt" className="mb-6 h-20 w-20 rounded-2xl" />
            <h1 className="text-3xl font-bold tracking-tight" style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800 }}>{t('welcome.title')}</h1>
            <p className="mt-3 text-base text-muted-foreground">{t('welcome.tagline')}</p>
            <p className="mt-1.5 text-sm text-muted-foreground/70">{t('welcome.subtitle')}</p>
          </div>
        )

      // Step 1: 核心功能
      case 'features':
        return (
          <div>
            <h2 className="mb-5 text-center text-xl font-bold">{t('welcome.featuresTitle')}</h2>
            <div className="space-y-3">
              {[
                { icon: Mic, title: t('welcome.feature.handsFree.title'), desc: t('welcome.feature.handsFree.desc'), color: 'text-blue-500 bg-blue-500/10' },
                { icon: Sparkles, title: t('welcome.feature.ai.title'), desc: t('welcome.feature.ai.desc'), color: 'text-amber-500 bg-amber-500/10' },
                { icon: Globe, title: t('welcome.feature.deploy.title'), desc: t('welcome.feature.deploy.desc'), color: 'text-emerald-500 bg-emerald-500/10' },
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

      // macOS：辅助功能 + 麦克风授权（Windows 没有这一步）
      case 'permissions':
        return (
          <div>
            <h2 className="mb-2 text-center text-xl font-bold">{t('welcome.permissionsTitle')}</h2>
            <p className="mb-5 text-center text-sm text-muted-foreground">{t('welcome.permissionsDesc')}</p>
            <MacPermissionsPanel />
          </div>
        )

      // Step 2: 热键确认
      case 'hotkey':
        return (
          <div className="flex flex-col items-center text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Keyboard className="h-7 w-7 text-primary" />
            </div>
            <h2 className="text-xl font-bold">{t('welcome.hotkeyTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {keyConfirmed
                ? t('welcome.hotkeyConfirmed')
                : <HotkeyPrompt template={t('welcome.hotkeyPrompt')} keyLabel={getSingleKeyDisplay(DEFAULT_HANDS_FREE)} />}
            </p>

            {/* 大号按键展示 */}
            <div className="my-6">
              <div
                className={`inline-flex items-center justify-center rounded-xl border-2 px-8 py-4 text-lg font-bold transition-all ${isPressing
                  ? 'border-foreground bg-foreground text-background scale-105 shadow-xl'
                  : keyConfirmed
                    ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600'
                    : 'border-primary/40 bg-primary/5 text-primary animate-pulse'
                  }`}
              >
                {isPressing ? `${shownLabel} ⬇` : keyConfirmed ? `✓ ${shownLabel}` : shownLabel}
              </div>
            </div>

            {/* 键盘位置示意 */}
            {showKeyboardHint && (
              <div className="w-full rounded-xl border bg-card p-3">
                <p className="mb-2 text-[11px] text-muted-foreground">{t('welcome.keyPosition')}</p>
                <KeyboardHint activeKeys={hintActiveKeys} pressed={isPressing} />
              </div>
            )}

            {/* 按键没被采纳时必须说清为什么：不然用户只看到"按了没变化" */}
            {captureError && (
              <p role="alert" className="mt-4 text-xs text-destructive">{captureError}</p>
            )}
            {!keyConfirmed && !captureError && (
              <p className="mt-4 text-xs text-muted-foreground/60">
                {t(IS_MAC ? 'welcome.supportedKeysMac' : 'welcome.supportedKeys')}
              </p>
            )}
            {keyConfirmed && !captureError && (
              <p className="mt-4 text-xs text-muted-foreground">
                {t('welcome.changeHint')}
              </p>
            )}
          </div>
        )

      // Step 3: 试一试
      case 'try':
        return (
          <div>
            <h2 className="mb-5 text-center text-xl font-bold">{t('welcome.tryTitle')}</h2>

            {/* 用设置页那个录制控件，不再自己写一份：组合键、系统保留组合校验、
                「已被别的程序占用」探测全都在里面。allowClear=false —— 向导的目的是
                让用户拿到一个能用的键，一个把它清成"未设置"的按钮在这里只会制造问题。 */}
            <Card className="mb-4">
              <CardContent className="p-4">
                <ComboShortcutInput
                  value={hfKey}
                  onChange={(value) => {
                    setHfKey(value)
                    hfKeyRef.current = value
                    void persistHandsFreeShortcut(value)
                  }}
                  label={t('welcome.handsFreeShortcut')}
                  description={t('welcome.clickToChange')}
                  allowClear={false}
                  validate={validateHandsFreeAgainstPTT}
                />
              </CardContent>
            </Card>

            <Card className="mb-4">
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">{t('welcome.currentMode')}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{MODE_LABEL_KEYS[workMode] ? t(MODE_LABEL_KEYS[workMode]) : workMode}</p>
                </div>
                {workMode === 'server' && (
                  <div className="flex items-center gap-1.5">
                    {serverOk === null ? (
                      <span className="text-xs text-muted-foreground">{t('common.checking')}</span>
                    ) : serverOk ? (
                      <><CheckCircle2 className="h-4 w-4 text-emerald-500" /><span className="text-xs text-emerald-600">{t('welcome.connected')}</span></>
                    ) : (
                      <><AlertCircle className="h-4 w-4 text-destructive" /><span className="text-xs text-destructive">{t('welcome.notConnected')}</span></>
                    )}
                  </div>
                )}
                {workMode !== 'server' && (
                  <span className="text-xs text-muted-foreground">{t('welcome.needsSetup')}</span>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <p className="mb-2 text-sm font-medium">{canTest ? t('welcome.voiceTestReady') : t('welcome.voiceTest')}</p>
                {canTest && (
                  <p className="mb-2 text-xs text-muted-foreground">{t('welcome.testHint', { key: hfLabel })}</p>
                )}
                <textarea
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  placeholder={canTest
                    ? t('welcome.testPlaceholder', { key: hfLabel })
                    : t('welcome.testUnavailable')}
                  className="w-full resize-none rounded-lg border border-input-border bg-input-bg p-3 text-sm leading-relaxed placeholder:text-muted-foreground/40 focus:border-input-focus-border focus:outline-none"
                  rows={4}
                  readOnly={!canTest}
                />
                {!canTest && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('welcome.testUnavailableHint', { key: hfLabel })}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )

      // Step 4: 完成
      case 'done':
        return (
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            </div>
            <h2 className="text-xl font-bold">{t('welcome.readyTitle')}</h2>
            <p className="mt-3 text-sm text-muted-foreground">
              <ReadyHint template={t('welcome.readyHint')} keyLabel={hfLabel} />
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground/70">{t('welcome.readySubHint')}</p>
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
                className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-primary' : 'w-1.5 bg-muted-foreground/20'
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
                {t('common.back')}
              </button>
            )}
            {!isLast && step === 0 && (
              <button
                onClick={onComplete}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('common.skip')}
              </button>
            )}
            <button
              onClick={() => isLast ? onComplete() : setStep(step + 1)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {isLast ? t('welcome.start') : t('common.next')}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
