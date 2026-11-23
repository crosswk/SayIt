/**
 * 更新服务：检查 → 后台静默下载 → 等用户点「立即更新」，或在退出时兜底安装。
 *
 * 设计要点（改动前后的差别，别不小心改回去）：
 *
 * · **不再自动安装。** 旧实现是"发现新版 → 下载 → 3 秒后 app.exit(0) 装掉"，
 *   用户正在按住说话时会被一个关不掉的全屏遮罩糊住、然后应用自己退出。
 *   现在下载完只是把包记进 pending，安装时机交给用户（桌面提醒卡片 / 关于页）
 *   或退出路径（Rust 的 install_pending_update_on_exit）。
 *
 * · **周期检查是必需的，不是加分项。** SayIt 常驻托盘 + 开机自启，很多用户几周不重启。
 *   只在启动时查一次，等于绝大多数人永远发现不了新版本。
 *
 * · **下载要幂等。** 旧实现下完立刻安装，所以"下载了但没装"不存在；现在这是常态，
 *   已下载的包必须记到设置里（pendingUpdate），重启后靠 verify_update_package 复用，
 *   否则每次开机都会把整包重下一遍。
 *
 * 全局单例状态：关于页、左下角图标、桌面提醒都订阅同一份，共用同一把并发锁，
 * 不会出现启动自动检查与用户手动点击各下载一遍的情况。
 */

import { listen } from '@tauri-apps/api/event'
import { checkVersionUpdate, compareVersions, type VersionInfo } from './updateChecker'
import { getSetting, setSetting } from '@/services/store'
import * as bridge from '@/services/bridge'
import { addRuntimeEvent } from '@/services/debugLog'
import { getOfficialUpdateBaseUrl, getUpdateBaseUrl, isOfficialUpdateChannel } from '@/services/runtimeConfig'
import { getState as getRecorderState } from '@/services/recorder'
import { t } from '@/i18n'

/** 已下载待安装的包。持久化到设置里，重启后仍然知道装过什么。 */
export interface PendingUpdate {
  version: string
  filePath: string
  sha512?: string | null
}

const PENDING_UPDATE_KEY = 'pendingUpdate'

/**
 * 周期检查间隔。6 小时是"当天内一定能收到"和"别没事就打服务器"之间的折中：
 * 常驻用户按天计算命中一次即可，检查本身只是一个几百字节的 manifest 请求。
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * 当前版本号。
 *
 * `__APP_VERSION__` 是 vite 的 define 注入的编译期常量。用 typeof 兜一层而不是直接读：
 * 直接读一旦注入没生效就是 ReferenceError，而这段代码跑在 `void startUpdateService()`
 * 里，异常会被 Promise 吞掉 —— 表现成"更新功能完全没反应"，且不留任何痕迹。
 *
 * 取不到时**不能假装成 0.0.0**：那会让每次检查都判定"有更新"，反复下载同一个包。
 * 返回 null，由调用方记一条错误后停掉检查。
 */
function readCurrentVersion(): string | null {
  const value = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null
  return value && /^\d+(\.\d+)*$/.test(value) ? value : null
}

/**
 * phase 只表示**此刻正在干什么**，不表示"有没有包等着装" —— 那件事由 pending 单独表示。
 *
 * 曾经有过一个 'ready' phase，是个 bug 温床：周期检查一开始就把 phase 从 'ready' 改成
 * 'checking'，而"包已存在、跳过下载"那条早退分支没人把它改回去，phase 就永久卡在
 * 'checking'（表现：关于页一直显示"正在检查更新"、提醒图标永远不亮）。
 * 一件事只能有一个真相来源，别把 'ready' 加回来。
 */
export type AutoUpdatePhase = 'idle' | 'checking' | 'downloading' | 'installing'

export interface AutoUpdateState {
  phase: AutoUpdatePhase
  versionInfo?: VersionInfo | null
  checkedAt?: number | null
  /** 已下载待安装的包。与 phase 正交：后台正在做别的事时它照样成立。 */
  pending?: PendingUpdate | null
  error?: string | null
  /** 安装失败独立于后台检查/下载错误，卡片只展示用户主动安装的结果。 */
  installError?: string | null
  /** 下载进度百分比（0-100），来自 Rust 的 update-download-progress 事件 */
  downloadPercent?: number
}

let currentState: AutoUpdateState = { phase: 'idle', versionInfo: null, checkedAt: null, pending: null }
const listeners: Set<(state: AutoUpdateState) => void> = new Set()
/** 正在进行中的检查/下载，防止启动自动检查与用户手动点击撞在一起重复下载 */
let inFlight: Promise<void> | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null

// 订阅 Rust 端下载真实进度事件，驱动进度显示
void listen<{ downloadedBytes: number; totalBytes: number; percent: number; status: string; error: string | null }>(
  'update-download-progress',
  (event) => {
    const { percent } = event.payload
    setState({ downloadPercent: percent })
  },
)

function setState(patch: Partial<AutoUpdateState>) {
  currentState = { ...currentState, ...patch }
  listeners.forEach((cb) => cb(currentState))
}

export function getAutoUpdateState() {
  return currentState
}

export function onAutoUpdateChange(cb: (state: AutoUpdateState) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * 是否有已下载、等着装的更新 —— 「关于」图标变绿和安装按钮出现的条件。
 * 只看 pending，**不看 phase**：后台在跑周期检查的时候，待安装这件事照样成立。
 */
export function hasPendingUpdate(state: AutoUpdateState = currentState): boolean {
  return !!state.pending
}

async function savePending(pending: PendingUpdate): Promise<void> {
  // Rust 的退出兜底安装直接读这一条设置，所以它必须先落盘、再进内存状态。
  await setSetting(PENDING_UPDATE_KEY, pending)
  setState({ pending, downloadPercent: 100, installError: null })
}

async function clearPending(): Promise<void> {
  await setSetting(PENDING_UPDATE_KEY, null).catch(() => { })
  setState({ pending: null, installError: null })
}

/**
 * 服务器地址变更时丢弃已下载的待安装包（更新来源跟随那个地址，见 getUpdateBaseUrl）。
 *
 * 必须做：`ensureDownloaded` 只按版本号判断"这个包已经在盘上了"，而版本号相同不代表
 * 来自同一台服务器、内容也相同。留着它的后果是"把地址指到测试服务器验一遍"实际装的
 * 还是上一个来源那个包 —— 测试看起来通过了，测的却不是目标产物。
 * versionInfo 一起清掉，否则界面还挂着旧地址那次检查的结论。
 */
export async function discardPendingForChannelSwitch(): Promise<void> {
  await clearPending()
  setState({ versionInfo: null, checkedAt: null, downloadPercent: 0, error: null })
}

/**
 * 恢复上次已下载的包。
 *
 * 两种情况要作废这条记录：
 *  · 它的版本已经不比当前版本新了（说明已经装上了，或用户手动装了更新的版本）；
 *  · 文件没了或哈希对不上（临时目录被清理软件扫过，或下载后被替换）。
 * 不作废的话，退出时会拿一个坏包或旧包去装。
 */
async function restorePending(current: string): Promise<PendingUpdate | null> {
  const raw = await getSetting<PendingUpdate | null>(PENDING_UPDATE_KEY, null).catch(() => null)
  if (!raw || !raw.filePath || !raw.version) return null

  if (compareVersions(current, raw.version) <= 0) {
    addRuntimeEvent('info', 'update', 'discarding a pending package that is no longer newer', {
      pending: raw.version,
      current,
    })
    await clearPending()
    return null
  }

  const usable = await bridge.verifyUpdatePackage(raw.filePath, raw.sha512 ?? null).catch(() => false)
  if (!usable) {
    addRuntimeEvent('info', 'update', 'previously downloaded package is gone or corrupt, will re-download')
    await clearPending()
    return null
  }
  return raw
}

/** 下载安装包。已经有同版本的待安装包就直接跳过，不重下。 */
async function ensureDownloaded(info: VersionInfo): Promise<void> {
  const version = info.latestVersion
  if (!version || !info.downloadUrl) return
  if (currentState.pending?.version === version) {
    addRuntimeEvent('info', 'update', 'package for this version is already on disk, not downloading again', { version })
    return
  }

  setState({ phase: 'downloading', error: null, downloadPercent: 0 })
  try {
    const filePath = await bridge.downloadUpdate(info.downloadUrl, info.sha512)
    await savePending({ version, filePath, sha512: info.sha512 })
    addRuntimeEvent('info', 'update', `version ${version} downloaded and ready to install`)
  } catch (err) {
    // 下载失败不打扰用户：下一次周期检查会重试。
    setState({ error: String(err) })
    addRuntimeEvent('warn', 'update', 'update download failed', { error: String(err) })
  }
}

/** 检查一次，发现新版本就在后台下载。所有触发路径最终都走这里。 */
async function runCheckAndDownload(): Promise<void> {
  if (currentState.phase === 'installing') return
  if (inFlight) { await inFlight; return }

  const current = readCurrentVersion()
  if (!current) {
    // 走到这里说明构建期的版本号注入没生效，检查无从进行。必须留声 ——
    // 静默返回的话，"没有新版本"和"读不到自己的版本"在外部看起来完全一样。
    addRuntimeEvent('error', 'update', 'cannot read the app version, update check skipped')
    return
  }

  const task = (async () => {
    setState({ phase: 'checking', error: null })
    const info = await checkVersionUpdate(current)
    setState({ versionInfo: info, checkedAt: Date.now() })

    // 无条件记一条：这是判断"更新到底跑没跑、看到了什么"的唯一依据。
    // source 是**实际**取到 manifest 的地址：与配置里的地址不一致就说明发生了回落
    // （配置的服务器上没有 manifest）。少了它，"回落了"和"配置的地址就是官方"
    // 在日志里长得一模一样。
    addRuntimeEvent(info.error ? 'warn' : 'info', 'update', 'update check finished', {
      current,
      latest: info.latestVersion,
      hasUpdate: info.hasUpdate,
      error: info.error,
      source: info.sourceUrl,
      configured: getUpdateBaseUrl(),
    })

    if (!info.hasUpdate || !info.downloadUrl) return
    await ensureDownloaded(info)
  })()

  inFlight = task
    .catch((err) => {
      addRuntimeEvent('error', 'update', 'update check threw', { error: String(err) })
      setState({ error: String(err) })
    })
    .finally(() => {
      inFlight = null
      // 无论走哪条分支、成功还是抛异常，活干完就回 idle。
      // 这里是唯一的收口点 —— 让每条早退分支各自记得复位 phase，就是上一版
      // 永久卡在 'checking' 的原因。'installing' 不能碰：那时应用正在退出。
      if (currentState.phase === 'checking' || currentState.phase === 'downloading') {
        setState({ phase: 'idle' })
      }
    })
  await inFlight
}

/**
 * 启动更新服务：恢复上次下载的包 → 立即检查一次 → 之后按 CHECK_INTERVAL_MS 周期检查。
 * 在 App.tsx 挂载时调用一次。
 */
export async function startUpdateService(): Promise<void> {
  // 整个函数包一层：调用方是 `void startUpdateService()`，没有 catch，
  // 这里任何一处抛异常都会被 Promise 静默吞掉，表现成"更新功能毫无反应"。
  try {
    const current = readCurrentVersion()
    // 第一条日志无条件写，且带上我们认为自己是哪个版本 —— 排查时先看这行在不在，
    // 不在就说明服务压根没启动，在就往下看 check finished 那行看到了什么。
    //
    // channel 也必须记：曾经排查过一次"新版没被检测到"，真相是包发到了 dev 通道而
    // 客户端查的是生产通道，而当时的日志里完全看不出查的是哪个地址，只能靠手动
    // curl 两个域名对比才发现（见 pitfalls #26）。
    addRuntimeEvent(current ? 'info' : 'error', 'update', 'update service starting', {
      currentVersion: current ?? '(unreadable)',
      channel: getUpdateBaseUrl(),
    })

    // 更新来源跟随服务器地址，被带到非官方地址时留一条痕迹。
    // 这不一定是错的（自建后端、或者故意指到测试服务器都会走到这里），但它是
    // "为什么没收到新版"最常见的原因，所以必须能从日志里一眼看到。
    if (!isOfficialUpdateChannel()) {
      addRuntimeEvent('info', 'update', 'update source follows a custom server address, not the official channel', {
        channel: getUpdateBaseUrl(),
        official: getOfficialUpdateBaseUrl(),
      })
    }

    // 这个开关的 UI 已经撤掉（更新不再让用户关），但**保留读取**：
    // 更新链路自己出故障时（0.0.8 那次把用户锁在死循环里），这是唯一不用发新版
    // 就能远程指导用户止血的通道。默认 true，绝大多数用户根本不知道它存在。
    const enabled = await getSetting('autoCheckUpdate', true).catch(() => true)
    if (!enabled) {
      addRuntimeEvent('warn', 'update', 'update checks disabled by the autoCheckUpdate setting')
      return
    }

    if (current) {
      const pending = await restorePending(current)
      if (pending) {
        addRuntimeEvent('info', 'update', 'reusing a package downloaded earlier', { version: pending.version })
        setState({ pending, downloadPercent: 100 })
      }
    }

    await runCheckAndDownload()

    if (checkTimer === null) {
      checkTimer = setInterval(() => { void runCheckAndDownload() }, CHECK_INTERVAL_MS)
    }
  } catch (err) {
    addRuntimeEvent('error', 'update', 'update service failed to start', { error: String(err) })
  }
}

/**
 * 手动检查（关于页「检查更新」按钮）。
 * 发现新版本同样会在后台开始下载 —— 与自动路径同一套行为，不再是"检查完直接装掉"。
 */
export async function checkForUpdateNow(): Promise<VersionInfo | null> {
  await runCheckAndDownload()
  return currentState.versionInfo ?? null
}

/**
 * 用户主动安装：Windows 上等安装进度窗口出现后应用才关闭（最多 30 秒），这期间保持 installing；
 * 装完自动打开。mac 上立刻关闭。
 * 调用方通过卡片或关于页的安装按钮说明重启行为；录音和转写期间禁止安装。
 */
export async function installPendingUpdate(): Promise<void> {
  const pending = currentState.pending
  if (!pending || currentState.phase === 'installing') return
  if (getRecorderState() !== 'idle') {
    setState({ installError: t('update.finishRecording'), error: t('update.finishRecording') })
    return
  }
  setState({ phase: 'installing', error: null, installError: null })
  try {
    // relaunch=true：这是用户当下主动要求的更新，装完把应用重新拉起来。
    await bridge.installDownloadedUpdate(pending.filePath, true)
  } catch (err) {
    // 装不起来就回 idle：pending 还在，用户可以再点一次，退出时也仍会兜底
    setState({ phase: 'idle', error: String(err), installError: String(err) })
    addRuntimeEvent('error', 'update', 'failed to launch the installer', { error: String(err) })
  }
}
