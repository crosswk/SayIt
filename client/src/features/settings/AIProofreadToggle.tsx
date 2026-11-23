// AI 整理开关、快捷键与短语音门槛（状态接入全局 store）

import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useAiEnabled } from '@/hooks/useAiEnabled'
import { toggleAiEnabled } from '@/stores/aiEnabled'
import { useT } from '@/i18n/useT'
import { ComboShortcutInput } from './ShortcutInputs'
import { useEffect, useState } from 'react'
import { getPresetShortcuts, getSetting, setSetting } from '@/services/store'
import { refreshRecorderSettings } from '@/services/recorder'
import { pttShortcutConflictsWithAccelerator } from '@/lib/shortcutKeys'
import * as bridge from '@/services/bridge'
import { MAX_RECORDING_SEC } from '@/services/recorder/types'
import { voiceActionShortcutConflict } from '@/services/voiceActions/shortcutConflicts'

export default function AIProofreadToggle() {
  const t = useT()
  const aiEnabled = useAiEnabled()
  const [shortcut, setShortcut] = useState('')
  const [minDurationSec, setMinDurationSec] = useState(0)

  useEffect(() => {
    void Promise.all([
      getSetting('shortcutToggleAi', ''),
      getSetting('aiMinDurationSec', 0),
    ]).then(([savedShortcut, savedMinDuration]) => {
      setShortcut(String(savedShortcut || ''))
      setMinDurationSec(Math.max(0, Math.min(MAX_RECORDING_SEC, Number(savedMinDuration) || 0)))
    })
  }, [])

  const validateShortcut = async (value: string) => {
    const [ptt, handsFree, presetShortcuts] = await Promise.all([
      getSetting<string>('shortcutPTT', ''),
      getSetting<string>('shortcutHandsFree', 'AltRight'),
      getPresetShortcuts(),
    ])
    if (pttShortcutConflictsWithAccelerator(ptt, value)) return t('aiProofread.shortcutConflictPtt')
    if (handsFree === value) return t('aiProofread.shortcutConflictHandsFree')
    if (Object.values(presetShortcuts).includes(value)) return t('aiProofread.shortcutConflictPreset')
    return voiceActionShortcutConflict((existing) => existing === value)
  }

  const saveShortcut = async (value: string) => {
    setShortcut(value)
    await setSetting('shortcutToggleAi', value)
    bridge.notifyShortcutsChanged()
  }

  const saveMinDuration = async (next: number) => {
    setMinDurationSec(next)
    await setSetting('aiMinDurationSec', next)
    await refreshRecorderSettings()
  }

  const handleMinDurationChange = (value: string, input: HTMLInputElement) => {
    const next = value === '' ? 0 : Math.max(0, Math.min(MAX_RECORDING_SEC, Math.round(Number(value) || 0)))
    // 数值不变时 React 会跳过重渲染，浏览器便会保留 `00` 之类的原始输入；
    // 直接回写规范值，使 0 始终只有一个，也顺便限制在 0–300 内。
    input.value = String(next)
    void saveMinDuration(next)
  }

  // 数字本身不如「实际会怎样」容易理解，所以把生效结果做成紧跟标签的小徽标。
  // 原先它单独占一行右对齐，既不贴标签也不贴输入框，还得靠手算的 margin 才对得齐
  // （中英各一套分支）——挪到标签后面之后那些魔法数就不需要了。
  const minDurationEffect = minDurationSec === 0
    ? t('aiProofread.minDurationDefaultHint')
    : t('aiProofread.minDurationActiveHint', { seconds: minDurationSec })
  // 只有非默认值才上主色：默认的「始终整理」是常态，不该抢注意力；
  // 用户真的设了门槛才值得被看见（与 ServerSection 的「未保存」徽标同一套逻辑）。
  const effectToneClass = minDurationSec === 0
    ? 'bg-muted text-muted-foreground'
    : 'bg-primary/10 text-primary'

  return (
    <Card>
      <CardContent className="p-6">
        {/* min-w-0 + gap：最小窗口下说明文字要能挤，不能把开关顶出卡片 */}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 id="ai-proofread-heading" className="text-lg font-semibold">{t('titleBar.aiCleanup')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {aiEnabled ? t('aiProofread.onDesc') : t('aiProofread.offDesc')}
            </p>
          </div>
          {/* 开关原来既没有 label 也没有 aria-label，相邻的标题也没关联——读屏念到的是
              一个没有名字的「切换按钮」 */}
          <Switch
            checked={aiEnabled}
            onChange={() => { void toggleAiEnabled() }}
            labelledBy="ai-proofread-heading"
            className="shrink-0"
          />
        </div>
        <div className="mt-5 space-y-4">
          <ComboShortcutInput
            value={shortcut}
            onChange={saveShortcut}
            validate={validateShortcut}
            comboOnly
            allowMouseShortcut
            label={t('aiProofread.shortcutLabel')}
            description={t('aiProofread.shortcutDesc')}
          />
          {/* 这一项只在 AI 整理开启时才有意义。关闭时不能只是留着让人填 ——
              原来照样可编辑，用户填完一个数字，它却根本不参与判断，界面还一声不响。
              所以关闭时真的 disabled（读屏也能听到），并把说明换成「不生效」的原因。
              上面的快捷键那行不跟着灰：它正是用来把 AI 整理打开的手段。 */}
          <div>
            <div className="flex items-center justify-between gap-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p
                    id="ai-min-duration-label"
                    className={`text-sm font-medium ${aiEnabled ? '' : 'text-muted-foreground'}`}
                  >
                    {t('aiProofread.minDurationLabel')}
                  </p>
                  {aiEnabled && (
                    <span
                      id="ai-min-duration-effect"
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${effectToneClass}`}
                    >
                      {minDurationEffect}
                    </span>
                  )}
                </div>
                <p id="ai-min-duration-desc" className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {aiEnabled ? t('aiProofread.minDurationDesc') : t('aiProofread.minDurationDisabled')}
                </p>
              </div>
              <label className="mr-2 flex shrink-0 items-center gap-1.5">
                <input
                  type="number"
                  min="0"
                  max={MAX_RECORDING_SEC}
                  step="1"
                  value={minDurationSec}
                  disabled={!aiEnabled}
                  placeholder={t('aiProofread.minDurationOff')}
                  onChange={(event) => handleMinDurationChange(event.target.value, event.currentTarget)}
                  className="h-8 w-16 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-labelledby="ai-min-duration-label"
                  aria-describedby={aiEnabled ? 'ai-min-duration-effect ai-min-duration-desc' : 'ai-min-duration-desc'}
                />
                <span className={`text-sm ${aiEnabled ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
                  {t('aiProofread.seconds')}
                </span>
              </label>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
