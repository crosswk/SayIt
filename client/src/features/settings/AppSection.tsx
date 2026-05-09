import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'

export default function AppSection({
  autoLaunch,
  onToggleAutoLaunch,
  autoCheckUpdate,
  onToggleAutoCheckUpdate,
}: {
  autoLaunch: boolean
  onToggleAutoLaunch: () => void
  autoCheckUpdate: boolean
  onToggleAutoCheckUpdate: () => void
}) {
  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">应用</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">开机自启动</p>
              <p className="text-xs text-muted-foreground">系统启动时自动运行 SayIt</p>
            </div>
            <Switch checked={autoLaunch} onChange={onToggleAutoLaunch} />
          </div>
          <div className="flex items-center justify-between border-t border-border pt-4">
            <div>
              <p className="text-sm font-medium">自动检测更新</p>
              <p className="text-xs text-muted-foreground">启动时自动检查是否有新版本可用</p>
            </div>
            <Switch checked={autoCheckUpdate} onChange={onToggleAutoCheckUpdate} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
