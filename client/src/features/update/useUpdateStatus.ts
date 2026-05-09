import { useCallback, useEffect, useState } from 'react'
import { checkVersionUpdate, type VersionInfo } from './updateChecker'
import { getSetting } from '@/services/store'
import * as bridge from '@/services/bridge'

export interface SimpleUpdateStatus {
  checking: boolean
  checkedAt: number | null
  versionInfo: VersionInfo | null
  downloading: boolean
  downloadError: string | null
  downloaded: boolean
  downloadedFilePath: string | null
  installing: boolean
}

export function useUpdateStatus() {
  const currentVersion = __APP_VERSION__
  const [status, setStatus] = useState<SimpleUpdateStatus>({
    checking: false,
    checkedAt: null,
    versionInfo: null,
    downloading: false,
    downloadError: null,
    downloaded: false,
    downloadedFilePath: null,
    installing: false,
  })

  const checkForUpdates = useCallback(async () => {
    setStatus((prev) => ({ ...prev, checking: true, downloadError: null }))
    const info = await checkVersionUpdate(currentVersion)
    setStatus((prev) => ({ ...prev, checking: false, checkedAt: Date.now(), versionInfo: info }))
    return info
  }, [currentVersion])

  const downloadAndInstall = useCallback(async () => {
    const url = status.versionInfo?.downloadUrl
    if (!url) return

    setStatus((prev) => ({ ...prev, downloading: true, downloadError: null }))
    try {
      const filePath = await bridge.downloadUpdate(url)
      setStatus((prev) => ({ ...prev, downloading: false, downloaded: true, downloadedFilePath: filePath }))
    } catch (err) {
      setStatus((prev) => ({ ...prev, downloading: false, downloadError: String(err) }))
    }
  }, [status.versionInfo?.downloadUrl])

  const installUpdate = useCallback(async () => {
    if (!status.downloadedFilePath) return
    setStatus((prev) => ({ ...prev, installing: true }))
    try {
      await bridge.installDownloadedUpdate(status.downloadedFilePath)
    } catch (err) {
      setStatus((prev) => ({ ...prev, installing: false, downloadError: String(err) }))
    }
  }, [status.downloadedFilePath])

  // 启动时自动检查一次（仅在设置开启时），发现新版本自动下载并安装
  useEffect(() => {
    getSetting('autoCheckUpdate', true).then((enabled) => {
      if (enabled) {
        void checkForUpdates().then((info) => {
          if (info?.hasUpdate && info.downloadUrl) {
            // 自动开始下载
            setStatus((prev) => ({ ...prev, downloading: true, downloadError: null }))
            bridge.downloadUpdate(info.downloadUrl).then((filePath) => {
              setStatus((prev) => ({ ...prev, downloading: false, downloaded: true, downloadedFilePath: filePath, installing: true }))
              // 下载完成后自动安装
              void bridge.installDownloadedUpdate(filePath)
            }).catch((err) => {
              setStatus((prev) => ({ ...prev, downloading: false, downloadError: String(err) }))
            })
          }
        })
      }
    })
  }, [checkForUpdates])

  return {
    currentVersion,
    status,
    checkForUpdates,
    downloadAndInstall,
    installUpdate,
  }
}
