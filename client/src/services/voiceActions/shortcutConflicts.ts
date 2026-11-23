// 应用内部快捷键互斥：语音翻译 / 随便问这两个键与其它快捷键之间的检查。
//
// 两个方向都要拦：在别处设快捷键时不能撞上这两个，在这两个上设时也不能撞上别处。
// 撞上的后果不显然 —— 组合键只会被注册一次，另一个功能按了没反应，用户只会觉得坏了。

import { t } from '@/i18n'
import { pttShortcutConflictsWithAccelerator } from '@/lib/shortcutKeys'
import { getPresetShortcuts, getSetting } from '../store'
import { VOICE_ACTION_KEYS } from './settings'

type VoiceActionKind = 'translate' | 'ask'

/**
 * 别的快捷键提交前调用：`matches(已设的键)` 为真时说明撞上了，返回错误文案。
 * 「按住说话」要用 pttShortcutConflictsWithAccelerator 比（它的格式和组合键不同），其余用相等即可。
 */
export async function voiceActionShortcutConflict(
  matches: (existing: string) => boolean,
  except?: VoiceActionKind,
): Promise<string | null> {
  const [translate, ask] = await Promise.all([
    getSetting<string>(VOICE_ACTION_KEYS.translateShortcut, ''),
    getSetting<string>(VOICE_ACTION_KEYS.askShortcut, ''),
  ])
  if (except !== 'translate' && translate && matches(translate)) return t('settings.shortcuts.conflictTranslate')
  if (except !== 'ask' && ask && matches(ask)) return t('settings.shortcuts.conflictAsk')
  return null
}

/** 语音翻译 / 随便问自己的快捷键提交前调用：检查本应用里所有别的快捷键。 */
export async function checkVoiceActionShortcut(value: string, self: VoiceActionKind): Promise<string | null> {
  if (!value) return null
  const [ptt, handsFree, aiToggle, presetShortcuts] = await Promise.all([
    getSetting<string>('shortcutPTT', ''),
    getSetting<string>('shortcutHandsFree', ''),
    getSetting<string>('shortcutToggleAi', ''),
    getPresetShortcuts(),
  ])
  if (ptt && pttShortcutConflictsWithAccelerator(ptt, value)) return t('settings.shortcuts.conflictPtt')
  if (handsFree && handsFree === value) return t('settings.shortcuts.conflictHandsFree')
  if (aiToggle && aiToggle === value) return t('settings.shortcuts.conflictAiToggle')
  if (Object.values(presetShortcuts).includes(value)) return t('settings.shortcuts.conflictPreset')
  return voiceActionShortcutConflict((existing) => existing === value, self)
}
