import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { UpdateStatus } from '@/types/update'

interface UpdateNoticeProps {
  updateStatus: UpdateStatus
  onInstallUpdate: () => void
}

function isVisiblePhase(phase: UpdateStatus['phase']) {
  return phase === 'available' || phase === 'downloading' || phase === 'downloaded' || phase === 'installing'
}

export default function UpdateNotice({ updateStatus, onInstallUpdate }: UpdateNoticeProps) {
  const [visible, setVisible] = useState(false)

  const noticeKey = `${updateStatus.phase}:${updateStatus.nextVersion || updateStatus.currentVersion}`

  useEffect(() => {
    setVisible(isVisiblePhase(updateStatus.phase))
  }, [noticeKey, updateStatus.phase])

  const content = useMemo(() => {
    switch (updateStatus.phase) {
      case 'available':
        return {
          title: `发现新版本 v${updateStatus.nextVersion || ''}`,
          description: '系统已开始在后台自动下载更新。下载完成后会再次提示你安装。',
        }
      case 'downloading':
        return {
          title: `正在下载新版本 v${updateStatus.nextVersion || ''}`,
          description: '更新正在后台下载。你可以继续正常使用当前应用。',
        }
      case 'downloaded':
        return {
          title: `新版本 v${updateStatus.nextVersion || ''} 已下载完成`,
          description: '现在可以立即安装。若暂不安装，关闭应用后也会自动完成更新。',
        }
      case 'installing':
        return {
          title: `正在安装更新 v${updateStatus.nextVersion || ''}`,
          description: '应用将自动关闭并完成安装，请稍候。',
        }
      default:
        return null
    }
  }, [updateStatus.phase, updateStatus.nextVersion])

  if (!visible || !content) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">{content.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{content.description}</p>
          {typeof updateStatus.progressPercent === 'number' ? (
            <div className="pt-2">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>下载进度</span>
                <span>{updateStatus.progressPercent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground transition-all"
                  style={{ width: `${updateStatus.progressPercent}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          {updateStatus.phase === 'downloaded' ? (
            <>
              <Button variant="outline" onClick={() => setVisible(false)}>
                稍后安装
              </Button>
              <Button onClick={onInstallUpdate}>
                立即安装
              </Button>
            </>
          ) : updateStatus.phase === 'installing' ? null : (
            <Button variant="outline" onClick={() => setVisible(false)}>
              我知道了
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
