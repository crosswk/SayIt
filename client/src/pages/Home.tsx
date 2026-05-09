import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Mic, Clock, Type, Zap } from 'lucide-react'
import { getStats, type Stats, getSetting } from '@/services/store'
import FeedbackSection from '@/components/FeedbackSection'

export default function Home() {
  const [stats, setStats] = useState<Stats>({ totalDurationSec: 0, totalChars: 0 })
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')

  useEffect(() => {
    getStats().then(setStats)
    getSetting('shortcutHandsFree', 'AltRight').then((value) => setHandsFreeKey(value as string))
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
        unit: '小时',
        extraUnit: minutes > 0 ? '分钟' : null
      }
    }
    return { value: `${totalMinutes}`, extraValue: null, unit: '分钟', extraUnit: null }
  }

  // Format number with Chinese units
  const formatChineseNumber = (num: number) => {
    if (num >= 10000) {
      return `${(num / 10000).toFixed(1)}万`
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}千`
    }
    return `${num}`
  }

  const totalTime = formatTime(stats.totalDurationSec)
  const avgWordsPerMin =
    stats.totalDurationSec > 60
      ? Math.round(stats.totalChars / (stats.totalDurationSec / 60))
      : 0
  const savedTime = formatTime(Math.round(stats.totalChars / 50) * 60)

  const formatKey = (key: string) => {
    const keyMap: Record<string, string> = {
      'AltLeft': '左 Alt',
      'AltRight': '右 Alt',
      'ControlLeft': '左 Ctrl',
      'ControlRight': '右 Ctrl',
      'ShiftLeft': '左 Shift',
      'ShiftRight': '右 Shift',
      'MetaLeft': '左 Win',
      'MetaRight': '右 Win',
      'Space': '空格',
      'CapsLock': 'Caps Lock',
      'Alt': 'Alt',
      'Control': 'Ctrl',
      'Shift': 'Shift',
    }
    // 处理组合键如 "Alt+L"
    if (key.includes('+')) {
      return key.split('+').map((k) => keyMap[k] || k).join(' + ')
    }
    return keyMap[key] || key
  }

  const cards = [
    { icon: Clock, label: '总口述时间', ...totalTime },
    { icon: Mic, label: '口述字数', value: formatChineseNumber(stats.totalChars), extraValue: null, unit: '字', extraUnit: null },
    { icon: Zap, label: '节省时间', ...savedTime },
    { icon: Type, label: '平均口述速度', value: `${avgWordsPerMin}`, extraValue: null, unit: '每分钟字数', extraUnit: null },
  ]

  const isNewUser = stats.totalDurationSec === 0 && stats.totalChars === 0

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="mb-4 text-2xl font-bold">随口说，出色写</h1>
      <p className="mb-8 text-sm text-muted-foreground">
        按下 <span className="px-1.5 py-0.5 text-muted-foreground bg-secondary border border-border rounded">{formatKey(handsFreeKey)}</span> 开始口述，再按一次结束并插入文本。
      </p>

      {isNewUser && (
        <div className="mb-6 rounded-xl border border-border bg-muted/30 px-5 py-5 text-center">
          <p className="text-sm text-muted-foreground">
            👋 在任意应用中按下 <span className="px-1.5 py-0.5 text-muted-foreground bg-secondary border border-border rounded text-xs">{formatKey(handsFreeKey)}</span> 即可开始口述，再按一次自动输入文本
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
