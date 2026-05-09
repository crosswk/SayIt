import { Button } from '@/components/ui/button'
import type { SimpleUpdateStatus } from './useUpdateStatus'

function formatTimestamp(value: number | null) {
  if (!value) return '尚未检查'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

interface UpdatePanelProps {
  currentVersion: string
  status: SimpleUpdateStatus
  onCheckForUpdates: () => void
}

export default function UpdatePanel({
  currentVersion,
  status,
  onCheckForUpdates,
}: UpdatePanelProps) {
  const { checking, checkedAt, versionInfo } = status

  const statusText = (() => {
    if (checking) return '正在检查更新...'
    if (!versionInfo) return ''
    if (versionInfo.error) return '检查更新失败'
    if (versionInfo.hasUpdate) return `发现新版本 v${versionInfo.latestVersion}`
    return '当前已是最新版本'
  })()

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">应用更新</p>
        <Button variant="outline" size="sm" onClick={onCheckForUpdates} disabled={checking}>
          {checking ? '检查中...' : '检查更新'}
        </Button>
      </div>
      <div className="space-y-0.5">
        <p className="text-xs text-muted-foreground">当前版本 v{currentVersion}</p>
        {statusText && (
          <p className={`text-xs ${versionInfo?.hasUpdate ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
            {statusText}
          </p>
        )}
        {checkedAt && (
          <p className="text-xs text-muted-foreground/60">上次检查：{formatTimestamp(checkedAt)}</p>
        )}
      </div>
    </div>
  )
}
