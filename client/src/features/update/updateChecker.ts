// 前端版本检查 — 直接请求后端 manifest API 比较版本号

import { getOfficialUpdateBaseUrl, getUpdateBaseUrl, isOfficialUpdateChannel } from '@/services/runtimeConfig'
import { getClientRuntimeInfo } from '@/services/bridge'
import { IS_MAC } from '@/lib/platform'

export interface VersionInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string | null
  downloadUrl: string | null
  releaseDate: string | null
  /** 安装包的 SHA-512（Base64）。下载后由 Rust 侧校验，manifest 没给就是 null。 */
  sha512: string | null
  error: string | null
  /** 实际取到 manifest 的地址。回落发生时它是官方地址，不等于服务器设置里那个。 */
  sourceUrl: string | null
}

/**
 * 返回 >0 表示 latest 比 current 新。
 *
 * 只认纯数字的点分段。非数字段（预发布后缀之类）按 0 处理而不是让 NaN 传下去：
 * NaN 参与减法永远得 NaN，`NaN !== 0` 为真，会让循环在第一段就返回 NaN，
 * 而 `NaN > 0` 是 false —— 结果是"有更新也不报"，且没有任何报错。
 */
export function compareVersions(current: string, latest: string): number {
  const parse = (value: string) => value.split('.').map((segment) => {
    const parsed = Number.parseInt(segment, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  const a = parse(current)
  const b = parse(latest)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] || 0) - (a[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 检查更新。先问服务器设置里那个地址，拿不到有效 manifest 就回落到官方地址。
 *
 * **回落不是优化，是「更新地址跟随服务器地址」这个设计能成立的前提。**
 * 把服务器指向自建后端的用户，那台机器上不会有 manifest；没有这一步，他们每次检查都
 * 拿到 404、被当成"已是最新版"，从此永远收不到更新，而且毫无征兆。
 *
 * 只在「没拿到版本号」时回落 —— 包括 404、网络失败、以及返回了 JSON 但没有 version
 * 字段。已经拿到版本号就用它，哪怕版本比当前的旧（那是测试指向旧通道的正常情况，
 * 不该悄悄换成官方的答案）。
 */
export async function checkVersionUpdate(currentVersion: string): Promise<VersionInfo> {
  const configured = await fetchManifest(currentVersion, getUpdateBaseUrl())
  if (configured.latestVersion || isOfficialUpdateChannel()) return configured

  const fallback = await fetchManifest(currentVersion, getOfficialUpdateBaseUrl())
  // 两边都没拿到就报第一次的结果：错误信息应该指向用户实际配置的那个地址。
  return fallback.latestVersion ? fallback : configured
}

/**
 * 安装包地址只能是 manifest 所在服务器上的路径。
 *
 * 原来是 `${baseUrl}${download_path}` 直接拼字符串：download_path 写成 `.attacker.example/x.exe`，
 * 拼出来就是 `https://sayitapp.site.attacker.example/x.exe`，域名已经换了。
 * 现在按 URL 解析后比 origin，不同源就当没有下载地址。Rust 的 download_update 下载前还会再查一次。
 */
export function resolveDownloadUrl(baseUrl: string, downloadPath: string | undefined | null): string | null {
  if (!downloadPath || !downloadPath.startsWith('/') || downloadPath.startsWith('//')) return null
  try {
    const base = new URL(baseUrl)
    const resolved = new URL(downloadPath, base)
    return resolved.origin === base.origin ? resolved.toString() : null
  } catch {
    return null
  }
}

/**
 * 更新通道 `{platform}/{arch}`，与服务端 releases 目录对应（server/backend/app/releases.py）。
 * Windows 只发 x64；mac 按 CPU 架构分 arm64 / x64（WKWebView 的 UA 在 Apple 芯片上也写 Intel，
 * 所以架构问 Rust）。
 */
async function updateChannel(): Promise<string> {
  if (!IS_MAC) return 'win32/x64'
  const info = await getClientRuntimeInfo().catch(() => null)
  return info?.arch === 'x86_64' ? 'darwin/x64' : 'darwin/arm64'
}

async function fetchManifest(currentVersion: string, baseUrl: string): Promise<VersionInfo> {
  const base: VersionInfo = {
    hasUpdate: false,
    currentVersion,
    latestVersion: null,
    downloadUrl: null,
    releaseDate: null,
    sha512: null,
    error: null,
    sourceUrl: baseUrl,
  }

  try {
    const channel = await updateChannel()
    const resp = await fetch(`${baseUrl}/api/desktop-updates/${channel}/manifest`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) {
      base.error = resp.status === 404 ? null : `HTTP ${resp.status}`
      return base
    }
    const manifest = await resp.json() as {
      version?: string
      releaseDate?: string
      download_path?: string
      sha512?: string
    }
    const latestVersion = manifest.version
    if (!latestVersion) return base

    base.latestVersion = latestVersion
    base.releaseDate = manifest.releaseDate || null
    base.sha512 = manifest.sha512 || null
    base.downloadUrl = resolveDownloadUrl(baseUrl, manifest.download_path)
    if (manifest.download_path && !base.downloadUrl) {
      base.error = 'manifest download_path is not on this server'
    }
    base.hasUpdate = compareVersions(currentVersion, latestVersion) > 0
    return base
  } catch (err) {
    base.error = String(err)
    return base
  }
}
