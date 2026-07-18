// 「热词注入提示词」开关卡片
// 开启后，AI 整理阶段会把用户热词表注入系统提示词，帮助纠正/保留专有名词。默认关闭。

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { getSetting, setSetting } from '@/services/store'

export default function HotwordPromptInjectToggle() {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    getSetting('injectHotwordsToPrompt', false).then((v) => setEnabled(Boolean(v)))
  }, [])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    void setSetting('injectHotwordsToPrompt', next)
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="pr-4">
            <h2 className="text-lg font-semibold">热词注入提示词</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              把热词表注入 AI 提示词，进一步提升这些热词的识别准确率。需先开启「AI 整理」。
            </p>
          </div>
          <Switch checked={enabled} onChange={toggle} />
        </div>
      </CardContent>
    </Card>
  )
}
