// Provider 管理器 — 根据 workMode 返回对应的 TranscriptionProvider

import { getSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import { ServerProvider } from './ServerProvider'
import { CloudAPIProvider } from './CloudAPIProvider'
import { LocalProvider } from './LocalProvider'
import type { TranscriptionProvider, WorkMode } from './types'

export type { TranscriptionProvider, TranscriptionCallbacks, StartOptions, StopOptions, FinalResult, ASRResult, WorkMode, ProviderState } from './types'

let currentProvider: TranscriptionProvider | null = null
let currentMode: WorkMode = 'server'

function createProvider(mode: WorkMode): TranscriptionProvider {
  switch (mode) {
    case 'server':
      return new ServerProvider()
    case 'cloud_api':
      return new CloudAPIProvider()
    case 'local':
      return new LocalProvider()
    default:
      addRuntimeEvent('warn', 'transcription', `未知工作模式 "${mode}"，回退到服务器模式`)
      return new ServerProvider()
  }
}

/** 获取当前 Provider 实例（懒初始化） */
export function getProvider(): TranscriptionProvider {
  if (!currentProvider) {
    currentProvider = createProvider(currentMode)
  }
  return currentProvider
}

/** 获取当前工作模式 */
export function getWorkMode(): WorkMode {
  return currentMode
}

/**
 * 切换工作模式。
 * 会断开旧 Provider 并创建新的。
 * 调用方需要重新 connect。
 */
export async function switchProvider(mode: WorkMode): Promise<TranscriptionProvider> {
  if (mode === currentMode && currentProvider) {
    return currentProvider
  }

  addRuntimeEvent('info', 'transcription', '切换工作模式', { from: currentMode, to: mode })

  // 断开旧 Provider
  if (currentProvider) {
    try {
      currentProvider.disconnect()
    } catch {
      // ignore
    }
  }

  currentMode = mode
  currentProvider = createProvider(mode)
  return currentProvider
}

/** 从 store 读取保存的 workMode 并初始化 */
export async function initProviderFromStore(): Promise<void> {
  const stored = await getSetting('workMode', 'server')
  const mode = (stored === 'server' || stored === 'cloud_api' || stored === 'local') ? stored : 'server'
  currentMode = mode as WorkMode
  currentProvider = createProvider(currentMode)
  addRuntimeEvent('info', 'transcription', 'Provider 已初始化', { mode: currentMode })
}
