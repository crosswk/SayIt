import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Mic, Clock, Type, Zap } from 'lucide-react'
import { getStats, type Stats, getSetting } from '@/services/store'
import { SHORTCUTS_CHANGED_EVENT, listen } from '@/services/bridge'
import FeedbackSection from '@/components/FeedbackSection'
import NoticeBanner from '@/components/NoticeBanner'
import { displayShortcut } from '@/lib/shortcutKeys'
import { getLocale } from '@/i18n'
import { useT } from '@/i18n/useT'

/**
 * 把带 `{key}` 占位的文案渲染成「文字 + 键帽 + 文字」。
 *
 * 不能把整句塞进一个 t() 就完事：键帽是个带样式的 <span>，而中英文里键帽出现的
 * 位置不同（"按下 X 开始…" vs "Press X to start…"）。按占位符切分，位置就由
 * 译文自己决定，不用为每种语言各写一份 JSX。
 */
function WithKeyChip({ template, keyLabel, chipClassName }: {
  template: string
  keyLabel: string
  chipClassName: string
}) {
  const [before, after = ''] = template.split('{key}')
  return (
    <>
      {before}
      <span className={chipClassName}>{keyLabel}</span>
      {after}
    </>
  )
}

export default function Home() {
  const t = useT()
  const [stats, setStats] = useState<Stats>({ totalDurationSec: 0, totalChars: 0 })
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')

  useEffect(() => {
    const loadStats = () => getStats().then(setStats)
    void loadStats()
    // 累计统计由 Rust 在写入/删除历史记录的同一事务里更新，事件在写完之后才发，
    // 收到时读到的就是新值。以前只在挂载时读一次：主窗口停在首页、或从托盘重新打开
    // （页面不会重新挂载）时，口述完数字一直不动，要切走再切回来才更新。
    const unlistenHistory = listen('history-updated', () => { void loadStats() })

    const loadHandsFreeKey = () =>
      getSetting('shortcutHandsFree', 'AltRight').then((value) => setHandsFreeKey(value as string))
    void loadHandsFreeKey()
    // 快捷键变化时（向导 / 设置页修改）实时刷新首页提示，无需切换路由
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, loadHandsFreeKey)
    return () => {
      window.removeEventListener(SHORTCUTS_CHANGED_EVENT, loadHandsFreeKey)
      void unlistenHistory.then((fn) => fn())
    }
  }, [])

  // Format time display
  const formatTime = (seconds: number) => {
    const totalMinutes = Math.round(seconds / 60)
    if (totalMinutes >= 60) {
      const hours = Math.floor(totalMinutes / 60)
      const minutes = totalMinutes % 60
      return {
        value: `${hours}`,
        extraValue: minutes > 0 ? `${minutes}` : null,
        unit: t('home.unitHours'),
        extraUnit: minutes > 0 ? t('home.unitMinutes') : null
      }
    }
    return { value: `${totalMinutes}`, extraValue: null, unit: t('home.unitMinutes'), extraUnit: null }
  }

  /**
   * 大数字缩写。
   *
   * 中文分档保持原样（万 / 千）—— 这是中文读者的习惯，不要动。
   * 英文没有"万"这一档，按 k / M 分；用 Intl 的 compact 记数法也能出结果，
   * 但它在 zh-CN 下不会给"千"这一档，会改掉现有中文显示，所以这里手写分支。
   */
  const formatCompactNumber = (num: number) => {
    if (getLocale() === 'zh-CN') {
      if (num >= 10000) return t('home.compactTenThousand', { value: (num / 10000).toFixed(1) })
      if (num >= 1000) return t('home.compactThousand', { value: (num / 1000).toFixed(1) })
      return `${num}`
    }
    return new Intl.NumberFormat(getLocale(), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(num)
  }

  const totalTime = formatTime(stats.totalDurationSec)
  const avgWordsPerMin =
    stats.totalDurationSec > 60
      ? Math.round(stats.totalChars / (stats.totalDurationSec / 60))
      : 0
  const savedTime = formatTime(Math.round(stats.totalChars / 50) * 60)

  const handsFreeKeyLabel = displayShortcut(handsFreeKey).join(' + ')

  const cards = [
    { icon: Clock, label: t('home.statTotalTime'), ...totalTime },
    { icon: Mic, label: t('home.statChars'), value: formatCompactNumber(stats.totalChars), extraValue: null, unit: t('home.unitChars'), extraUnit: null },
    { icon: Zap, label: t('home.statSavedTime'), ...savedTime },
    { icon: Type, label: t('home.statSpeed'), value: `${avgWordsPerMin}`, extraValue: null, unit: t('home.unitCharsPerMinute'), extraUnit: null },
  ]

  const isNewUser = stats.totalDurationSec === 0 && stats.totalChars === 0

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="mb-4 text-2xl font-bold">{t('home.title')}</h1>
      <p className="mb-8 text-sm text-muted-foreground">
        <WithKeyChip
          template={t('home.subtitle')}
          keyLabel={handsFreeKeyLabel}
          chipClassName="px-1.5 py-0.5 text-muted-foreground bg-secondary border border-border rounded"
        />
      </p>

      <NoticeBanner />

      {isNewUser && (
        <div className="mb-6 rounded-xl border border-border bg-muted/30 px-5 py-5 text-center">
          <p className="text-sm text-muted-foreground">
            <WithKeyChip
              template={t('home.newUserHint')}
              keyLabel={handsFreeKeyLabel}
              chipClassName="px-1.5 py-0.5 text-muted-foreground bg-secondary border border-border rounded text-xs"
            />
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {cards.map(({ icon: Icon, label, value, extraValue, unit, extraUnit }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-lg bg-secondary p-3">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-bold">
                  {value} <span className="text-sm font-normal text-muted-foreground">{unit}</span>
                  {extraValue && (
                    <>
                      {' '}{extraValue} <span className="text-sm font-normal text-muted-foreground">{extraUnit}</span>
                    </>
                  )}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6">
        <FeedbackSection />
      </div>
    </div>
  )
}
