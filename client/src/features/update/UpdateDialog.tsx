/**
 * 自动更新弹窗
 * 下载完成后弹出，通知用户即将安装更新
 */

import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { onAutoUpdateChange, getAutoUpdateState, type AutoUpdateState } from './autoUpdate'

export default function UpdateDialog() {
  const [state, setState] = useState<AutoUpdateState>(getAutoUpdateState)

  useEffect(() => {
    return onAutoUpdateChange(setState)
  }, [])

  if (state.phase === 'idle' || state.phase === 'checking') return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        {state.phase === 'downloading' && (
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <Download className="h-7 w-7 text-primary animate-bounce" />
            </div>
            <h3 className="text-lg font-semibold">发现新版本</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              正在下载 v{state.version}，请稍候...
            </p>
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full animate-pulse rounded-full bg-primary" style={{ width: '60%' }} />
            </div>
          </div>
        )}
        {state.phase === 'installing' && (
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
              <RefreshCw className="h-7 w-7 text-emerald-500 animate-spin" />
            </div>
            <h3 className="text-lg font-semibold">准备安装</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              v{state.version} 下载完成，即将自动安装并重启应用...
            </p>
            <p className="mt-3 text-xs text-muted-foreground/60">
              请勿关闭应用
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
