/**
 * 应用启动时自动检查、下载、安装更新
 * 在 App.tsx 中调用，不依赖任何页面挂载
 */

import { checkVersionUpdate } from './updateChecker'
import { getSetting } from '@/services/store'
import * as bridge from '@/services/bridge'

/** 更新状态，供 UI 层订阅 */
export type AutoUpdatePhase = 'idle' | 'checking' | 'downloading' | 'installing'
export interface AutoUpdateState {
  phase: AutoUpdatePhase
  version?: string
}

let currentState: AutoUpdateState = { phase: 'idle' }
const listeners: Set<(state: AutoUpdateState) => void> = new Set()

function setState(state: AutoUpdateState) {
  currentState = state
  listeners.forEach((cb) => cb(state))
}

export function getAutoUpdateState() {
  return currentState
}

export function onAutoUpdateChange(cb: (state: AutoUpdateState) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export async function runAutoUpdate() {
  const enabled = await getSetting('autoCheckUpdate', true)
  if (!enabled) return

  setState({ phase: 'checking' })

  const currentVersion = __APP_VERSION__
  const info = await checkVersionUpdate(currentVersion)

  if (!info?.hasUpdate || !info.downloadUrl) {
    setState({ phase: 'idle' })
    return
  }

  setState({ phase: 'downloading', version: info.latestVersion || undefined })

  try {
    const filePath = await bridge.downloadUpdate(info.downloadUrl)

    // 通知用户即将安装，给 3 秒缓冲
    setState({ phase: 'installing', version: info.latestVersion || undefined })
    await new Promise((r) => setTimeout(r, 3000))

    await bridge.installDownloadedUpdate(filePath)
  } catch {
    setState({ phase: 'idle' })
  }
}
