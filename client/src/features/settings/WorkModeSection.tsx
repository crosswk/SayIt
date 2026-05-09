// 工作模式切换卡片

import { Card, CardContent } from '@/components/ui/card'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { Monitor, Globe, HardDrive, type LucideIcon } from 'lucide-react'
import type { WorkMode } from '@/services/transcription'

const modes: Array<{ value: WorkMode; label: string; desc: string; privacy: string; icon: LucideIcon; iconColor: string }> = [
  {
    value: 'local', label: '本地模式',
    desc: '语音识别完全在本机运行',
    privacy: '不开启 AI 时数据完全在本地。开启 AI 后文本会发送到 AI 服务润色。',
    icon: Monitor, iconColor: 'text-primary',
  },
  {
    value: 'cloud_api', label: '云 API 模式',
    desc: '直接调用云端 ASR 和 AI 接口',
    privacy: '音频和文本会发送到你配置的云服务商处理。',
    icon: Globe, iconColor: 'text-primary',
  },
  {
    value: 'server', label: '服务器模式',
    desc: '连接自部署的远程服务器',
    privacy: '音频发送到服务器推理后不会保留，仅保存在客户端本地。',
    icon: HardDrive, iconColor: 'text-primary',
  },
]

const statusConfig = {
  connected:    { dot: 'bg-success', text: '已连接', bg: 'bg-success/10 text-success' },
  connecting:   { dot: 'bg-warning animate-pulse', text: '连接中', bg: 'bg-warning/10 text-warning' },
  disconnected: { dot: 'bg-muted-foreground', text: '未连接', bg: 'bg-muted text-muted-foreground' },
  error:        { dot: 'bg-destructive', text: '连接失败', bg: 'bg-destructive/10 text-destructive' },
} as const

interface Props {
  value: WorkMode
  onChange: (mode: WorkMode) => void
}

export default function WorkModeSection({ value, onChange }: Props) {
  const wsStatus = useConnectionStatus()

  const statusText = value === 'server'
    ? statusConfig[wsStatus].text
    : '就绪'

  const statusBg = value === 'server'
    ? statusConfig[wsStatus].bg
    : 'bg-success/10 text-success'

  const statusDot = value === 'server'
    ? statusConfig[wsStatus].dot
    : 'bg-success'

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">工作模式</h2>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusBg}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot}`} />
            {statusText}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {modes.map((m) => {
            const isActive = value === m.value
            const Icon = m.icon
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => onChange(m.value)}
                className={`relative rounded-lg border p-4 text-left transition-colors ${
                  isActive
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent'
                }`}
              >
                <Icon className={`absolute right-3 top-3 h-5 w-5 ${isActive ? m.iconColor : 'text-muted-foreground/30'} transition-colors`} />
                <div className="text-sm font-medium">{m.label}</div>
                <div className="mt-1 text-xs text-muted-foreground">{m.desc}</div>
                <div className="mt-2 border-t border-border/50 pt-2 text-xs leading-relaxed text-muted-foreground/80">
                  {m.privacy}
                </div>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
