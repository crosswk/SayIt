// AI 校对开关卡片（独立组件）

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { getSetting, setSetting } from '@/services/store'
import { refreshRecorderSettings } from '@/services/recorder'
import { getWorkMode } from '@/services/transcription'

export default function AIProofreadToggle() {
  const [aiEnabled, setAiEnabled] = useState(true)
  const [workMode, setWorkMode] = useState(getWorkMode)

  useEffect(() => {
    getSetting('aiEnabled', false).then((v) => setAiEnabled(v as boolean))
    getSetting('workMode', 'server').then((v) => {
      const m = v as string
      if (m === 'server' || m === 'cloud_api' || m === 'local') setWorkMode(m as typeof workMode)
    })
  }, [])

  function handleToggleAi() {
    const next = !aiEnabled
    setAiEnabled(next)
    void setSetting('aiEnabled', next).then(() => refreshRecorderSettings())
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">AI 校对</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {aiEnabled
                ? workMode === 'server'
                  ? '已开启，语音识别后将由服务器端 AI 进行润色'
                  : '已开启，语音识别后将使用下方配置的 AI 服务进行润色'
                : '已关闭，将直接返回语音识别原文'}
            </p>
          </div>
          <Switch checked={aiEnabled} onChange={() => { void handleToggleAi() }} />
        </div>
      </CardContent>
    </Card>
  )
}
