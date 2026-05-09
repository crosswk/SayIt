import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Github, Download, Loader2, CheckCircle } from 'lucide-react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { useUpdateStatus } from '@/features/update/useUpdateStatus'
import appIcon from '@/assets/icon-128.png'

function formatTimestamp(value: number | null) {
  if (!value) return '尚未检查'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export default function About() {
  const { currentVersion, status, checkForUpdates, downloadAndInstall, installUpdate } = useUpdateStatus()
  const { checking, checkedAt, versionInfo, downloading, downloadError, downloaded, installing } = status

  const updateStatusText = (() => {
    if (checking) return '正在检查更新...'
    if (!versionInfo) return null
    if (versionInfo.error) return '检查更新失败'
    if (installing) return '正在安装更新...'
    if (downloaded) return `新版本 v${versionInfo.latestVersion} 已下载完成`
    if (downloading) return `正在下载 v${versionInfo.latestVersion}...`
    if (versionInfo.hasUpdate) return `发现新版本 v${versionInfo.latestVersion}`
    return '当前已是最新版本'
  })()

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold">关于</h1>

      <Card>
        <CardContent className="p-6">
          {/* 品牌 */}
          <div className="flex items-center gap-4">
            <img src={appIcon} alt="SayIt" className="h-16 w-16 rounded-2xl" />
            <div>
              <h2 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800 }}>
                SayIt
              </h2>
              <p className="text-sm text-muted-foreground">语音输入，AI 润色</p>
              <p className="mt-0.5 text-xs text-muted-foreground/60">by Liu Qianglong & Claude</p>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="rounded-full bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground">v{currentVersion}</span>
                <button
                  type="button"
                  onClick={() => void shellOpen('https://github.com/crosswk/')}
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/50 text-muted-foreground transition-colors hover:bg-foreground/15 hover:text-foreground"
                  title="GitHub"
                >
                  <Github className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* 更新 */}
          <div className="mt-5 border-t border-border pt-5">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                {updateStatusText && (
                  <p className={`text-sm ${versionInfo?.hasUpdate ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                    {updateStatusText}
                  </p>
                )}
                {downloadError && (
                  <p className="text-xs text-red-500">{downloadError}</p>
                )}
                {checkedAt && (
                  <p className="text-xs text-muted-foreground/60">上次检查：{formatTimestamp(checkedAt)}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* 已下载：显示安装按钮 */}
                {downloaded && !installing && (
                  <Button size="sm" onClick={() => void installUpdate()}>
                    <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                    立即安装
                  </Button>
                )}
                {/* 有更新但未下载：显示下载按钮 */}
                {versionInfo?.hasUpdate && !downloaded && !downloading && (
                  <Button size="sm" onClick={() => void downloadAndInstall()}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    下载更新
                  </Button>
                )}
                {/* 下载中 */}
                {downloading && (
                  <Button size="sm" disabled>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    下载中...
                  </Button>
                )}
                {/* 安装中 */}
                {installing && (
                  <Button size="sm" disabled>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    安装中...
                  </Button>
                )}
                {/* 检查更新按钮 */}
                {!downloading && !installing && (
                  <Button variant="outline" size="sm" onClick={() => void checkForUpdates()} disabled={checking}>
                    {checking ? '检查中...' : '检查更新'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
