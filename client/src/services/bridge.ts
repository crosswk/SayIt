/**
 * Tauri IPC Bridge — 所有前端代码通过这个模块与 Rust 后端通信。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

import type { AsrHotwordCapability } from '../lib/asrModels'
import type { DiagnosticOccurrence, DiagnosticsPreview } from '../types/appApi'
import type { UpdateNotificationSnapshot } from '@/features/update/notificationTypes'

// Re-export for convenience
export { invoke, listen, emit }

export function syncUpdateNotification(snapshot: UpdateNotificationSnapshot) {
  return invoke<void>('sync_update_notification', { snapshot })
}

export function getUpdateNotification() {
  return invoke<UpdateNotificationSnapshot>('get_update_notification')
}

export function fitUpdateNotification(revision: number, width: number, height: number, devicePixelRatio: number) {
  return invoke<void>('fit_update_notification', { revision, width, height, devicePixelRatio })
}

// ─── Window Controls ───

export function minimize() {
  getCurrentWindow().minimize()
}

export function maximize() {
  getCurrentWindow().toggleMaximize()
}

export function close() {
  getCurrentWindow().close()
}

// ─── Overlay ───

/**
 * Bug 003 diagnostic helper — log overlay IPC failures to runtime events
 * (which mirror to sayit.log via appendDebugLog).
 */
function logOverlayIpcError(op: string, err: unknown) {
  try {
    // Lazy import to avoid circular dep with debugLog
    void import('./debugLog').then(({ addRuntimeEvent }) => {
      addRuntimeEvent('error', 'overlay-ipc', `${op} failed`, { error: String(err) })
    })
  } catch {
    console.error(`[overlay-ipc] ${op} failed:`, err)
  }
}

export interface OverlayHealthSnapshot {
  showId: number
  activeShowId: number
  activeGeneration: number
  acked: boolean
  ackGeneration: number
  ackLatencyMs: number
  recoveryStarted: boolean
  recoverySucceeded: boolean
  window: {
    handleExists: boolean
    visible?: boolean | null
    intersectsPrimary?: boolean
    position?: { x: number; y: number } | null
    size?: { width: number; height: number } | null
  }
}

/** 原子地更新状态并显示悬浮窗，返回本次显示的关联 id。 */
export function presentOverlay(data: unknown) {
  return invoke<number>('present_overlay', { data }).catch((err) => {
    logOverlayIpcError('present_overlay', err)
    return 0
  })
}

/** 兼容旧调用；新显示流程应优先使用 presentOverlay。 */
export function showOverlay() {
  return invoke<number>('show_overlay').catch((err) => {
    logOverlayIpcError('show_overlay', err)
    return 0
  })
}

export function hideOverlay() {
  return invoke<void>('hide_overlay').catch((err) => {
    logOverlayIpcError('hide_overlay', err)
  })
}

export function updateOverlay(data: unknown) {
  return invoke<void>('update_overlay_state', { data }).catch((err) => {
    logOverlayIpcError('update_overlay_state', err)
  })
}

// devicePixelRatio 在这里就上报：预热时（还没有任何一次显示）是原生侧唯一能在第一次
// 显示之前拿到 webview 真实缩放的时机，否则用户第一次口述会看到尺寸不对的悬浮窗。
export function overlayReady(devicePixelRatio?: number) {
  return invoke<void>('overlay_ready', { devicePixelRatio })
}

export function overlayRenderAck(data: unknown) {
  return invoke<void>('overlay_render_ack', { data })
}

export function getOverlayHealth(showId: number) {
  return invoke<OverlayHealthSnapshot>('get_overlay_health', { showId })
}

export type EscapeActionMode =
  | 'off'
  | 'cancel_recording'
  | 'cancel_processing'
  | 'dismiss_fallback'
  | 'abandon_late_result'

/** 只在悬浮窗需要响应全局 Esc 时开启；Rust 侧带超时保险，避免异常后永久吞键。 */
export function setEscapeActionMode(mode: EscapeActionMode, token = 0) {
  return invoke<void>('set_escape_action_mode', { mode, token })
}

/** 悬浮窗卡片上的临时组合键。字符串值是与 Rust 的契约，见 keyboard::card_hotkey_action_name。 */
export type CardHotkeyAction = 'copy'

/**
 * 开启/续期/解除卡片快捷键；传空数组即解除。
 *
 * 为什么要经过原生：悬浮窗不抢焦点，按键始终发给用户原来的程序，webview 里的
 * keydown 永远不会触发。Rust 侧带硬 TTL（20s）兜底，所以**卡片可见期间必须周期性
 * 续期**，间隔要明显小于 TTL。
 */
export function setCardHotkeys(actions: CardHotkeyAction[], token = 0) {
  return invoke<void>('set_card_hotkeys', { actions, token })
}

// ─── Paste / Context ───

export function pasteText(text: string, hwnd?: string, focusHwnd?: string, restoreClipboard?: boolean) {
  return invoke<{
    ok: boolean
    strategy?: string
    reason?: string
    detail?: string
    attempts?: Array<{ strategy: string; ok: boolean; reason?: string; detail?: string }>
  }>('paste_text', { text, hwnd: hwnd || null, focusHwnd: focusHwnd || null, restoreClipboard: restoreClipboard ?? false })
}

export function getProbeResult() {
  return invoke<Record<string, unknown>>('get_probe_result')
}

/** 一次原生捕获同时返回录音目标上下文与插字探测结果。 */
export function getRecordingContext(includeTextContext = false) {
  return invoke<{
    appContext: Record<string, unknown>
    probe: Record<string, unknown>
  }>('get_recording_context', { includeTextContext })
}

export function getActiveAppContext() {
  return invoke<Record<string, unknown> | null>('get_active_app_context')
}

/** 系统权限状态（macOS：辅助功能 / 麦克风 / 安全输入；Windows 恒为已授权）。 */
export interface PlatformPermissions {
  platform: string
  accessibility: boolean
  hotkeyActive: boolean
  microphone: 'not_determined' | 'restricted' | 'denied' | 'authorized' | 'unknown'
  secureInput: boolean
  translocated: boolean
  bundlePath: string
}

export function getPlatformPermissions() {
  return invoke<PlatformPermissions>('get_platform_permissions')
}

/** 请求「辅助功能」授权（没授权时系统会弹出引导框）。返回当前是否已授权。 */
export function requestAccessibilityPermission() {
  return invoke<boolean>('request_accessibility_permission')
}

/** 打开系统设置的隐私面板：accessibility / microphone / input_monitoring。 */
export function openPrivacySettings(pane: 'accessibility' | 'microphone' | 'input_monitoring') {
  return invoke<void>('open_privacy_settings', { pane })
}

/** 界面语言切换后重建 mac 的原生菜单（菜单栏图标菜单、顶部应用菜单）。Windows 上是空操作。 */
export function refreshNativeMenus() {
  return invoke<void>('refresh_native_menus')
}

export function getClientRuntimeInfo() {
  return invoke<{
    userId: string
    userName: string
    deviceId: string
    hostname: string
    clientVersion: string
    platform: string
    arch?: string
    osVersion: string
    localIp: string
    systemLocale: string
    cpuCores: number
    memoryMb: number
  }>('get_client_runtime_info')
}

/**
 * 系统**显示语言**，返回 `zh-CN` / `en`。
 *
 * 与 `getClientRuntimeInfo().systemLocale` 不是一回事：那个是**区域格式**
 * （日期货币怎么写），诊断用；这个是 Windows 界面本身的语言，决定界面语言。
 * 判定只在 Rust 一处（`locale::system_ui_lang`），托盘和界面才不会各说一套。
 */
export function getSystemUiLanguage() {
  return invoke<string>('get_system_ui_language')
}

export function copyText(text: string) {
  return invoke('copy_text', { text })
}

// ─── 系统输出静音（录音期间防回采）───

/** 记录当前默认输出设备静音状态并将其静音。返回是否已处理。 */
export function muteSystemOutput() {
  return invoke<boolean>('mute_system_output')
}

/** 恢复到 muteSystemOutput 之前记录的静音状态。 */
export function restoreSystemOutput() {
  return invoke<boolean>('restore_system_output')
}

export function appendDebugLog(payload: unknown) {
  invoke('append_debug_log', { payload })
}

// ─── Store ───

export function storeGet(key: string) {
  return invoke<unknown>('store_get', { key })
}

export function storeSet(key: string, value: unknown) {
  return invoke('store_set', { key, value })
}

export function storeDelete(key: string) {
  return invoke('store_delete', { key })
}

// ─── History ───

export function historyList(query?: {
  keyword?: string
  favoriteOnly?: boolean
  limit?: number
  offset?: number
}) {
  return invoke<unknown[]>('history_list', { query })
}

export function historyCount(query?: {
  keyword?: string
  favoriteOnly?: boolean
}) {
  return invoke<number>('history_count', { query })
}

export function historyAdd(record: unknown) {
  return invoke('history_add', { record })
}

export function historyUpdate(id: string, patch: Record<string, unknown>) {
  return invoke('history_update', { id, patch })
}

export function historyDelete(id: string) {
  return invoke('history_delete', { id })
}

export function historySetFavorite(id: string, favorite: boolean) {
  return invoke('history_set_favorite', { id, favorite })
}

// ─── Export ───

export function saveTextExport(payload: {
  defaultPath: string
  content: string
  filters?: Array<{ name: string; extensions: string[] }>
}) {
  return invoke<string | null>('save_text_export', { payload })
}

export function saveExportBundle(payload: {
  defaultPath: string
  files: Array<{ name: string; content: string }>
}) {
  return invoke<string | null>('save_export_bundle', { payload })
}

// ─── Shortcuts ───

/** 前端内部广播：快捷键设置已变化，供页面（如首页提示）实时刷新显示。 */
export const SHORTCUTS_CHANGED_EVENT = 'sayit:shortcuts-changed'

export function notifyShortcutsChanged() {
  invoke('shortcuts_changed')
  // 同时在前端广播，让依赖快捷键显示的页面无需切换路由即可刷新
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGED_EVENT))
  }
}

export function testShortcut(accelerator: string) {
  return invoke<boolean>('test_shortcut', { accelerator })
}

/** 查询 PTT DOM code 对应按键当前是否真实物理按下（顺序与输入一致）。 */
export function getPTTPhysicalKeyStates(codes: string[]) {
  return invoke<boolean[]>('get_ptt_physical_key_states', { codes })
}

/**
 * 开始快捷键录制捕获（设置页点开录制时调用）。Rust 侧会：
 * - 底层鼠标钩子吞掉下一个侧键并通过 mouse-shortcut-captured 回报；
 * - 键盘钩子在录制期间放行 PTT/免提单键，不触发录音；
 * - 注销全部 global_shortcut，避免已绑定的组合键被系统抢走、录不进来。
 */
export function beginShortcutCapture() {
  return invoke('begin_shortcut_capture').catch(() => { })
}

/** 结束快捷键录制捕获（录制结束/取消时调用），并恢复 Rust 侧的热键注册。 */
export function endShortcutCapture() {
  return invoke('end_shortcut_capture').catch(() => { })
}

// ─── System ───

export function getAutoLaunch() {
  return invoke<boolean>('get_auto_launch')
}

export function setAutoLaunch(enable: boolean) {
  return invoke('set_auto_launch', { enable })
}

/**
 * 拉起安装程序并退出应用。
 * relaunch=true 装完自动重开（用户主动点更新时）；退出路径上的兜底安装走 Rust 内部，
 * 传 false —— 用户是要关掉 SayIt，装完再拉起来会表现成"这软件关不掉"。
 */
export function installDownloadedUpdate(filePath: string, relaunch: boolean) {
  return invoke('install_downloaded_update', { filePath, relaunch })
}

/** 下载安装包到临时目录，返回完整路径。传了 sha512（Base64）就由 Rust 侧校验完整性。 */
export function downloadUpdate(url: string, sha512?: string | null) {
  return invoke<string>('download_update', { url, sha512: sha512 ?? null })
}

/** 磁盘上那个安装包还能不能用（存在 + 哈希对得上）。用于启动时复用上次下载的包。 */
export function verifyUpdatePackage(filePath: string, sha512?: string | null) {
  return invoke<boolean>('verify_update_package', { filePath, sha512: sha512 ?? null })
}

// ─── Tray ───

/**
 * 把托盘右键菜单里「AI 整理」那一项刷成给定状态（文字上的开/关 + 状态图标）。
 *
 * 托盘菜单只在启动时建一次（Tauri v2 没有「菜单即将弹出」的钩子），
 * 所以界面里每次切开关都要主动回写，否则右键看到的是上一次的状态。
 */
export function setTrayAiEnabled(enabled: boolean) {
  return invoke<void>('set_tray_ai_enabled', { enabled }).catch(() => { })
}

/** 托盘右键切换了「AI 整理」（Rust 已落库，payload 是切换后的值）。 */
export function onAiCleanupChanged(cb: (enabled: boolean) => void) {
  const unlisten = listen<{ enabled?: boolean }>('ai-cleanup-changed', (event) => {
    cb(Boolean(event.payload?.enabled))
  })
  return () => { unlisten.then((fn) => fn()) }
}

/** AI 整理快捷键被触发；前端负责更新内存、持久化和悬浮窗提示。 */
export function onAiCleanupToggleRequested(cb: () => void) {
  const unlisten = listen('toggle-ai-cleanup', () => cb())
  return () => { unlisten.then((fn) => fn()) }
}

export function setPTTLabConfig(data: unknown) {
  console.log('[bridge] setPTTLabConfig called', data)
  invoke('set_ptt_lab_config', { data }).catch((err) => {
    console.error('[bridge] setPTTLabConfig failed:', err)
  })
}

// ─── Audio Files ───

export function saveAudioFile(id: string, wavBase64: string) {
  return invoke<string>('save_audio_file', { id, wavBase64 })
}

export function savePcmAsWav(id: string, pcmBase64: string, sampleRate?: number) {
  return invoke<string>('save_pcm_as_wav', { id, pcmBase64, sampleRate: sampleRate ?? null })
}

/**
 * 二进制请求体：`[4 字节小端 JSON 长度][JSON 参数][原始字节]`，与 Rust 的 ipc_body 对应。
 *
 * 音频原来先转 base64 再塞进 JSON。lib/encoding 那个转码是逐字节拼字符串，2 分钟录音约
 * 0.4 秒、5 分钟约 0.7 秒，跑在主窗主线程上（悬浮窗那段时间也跟着卡），本地 / 云 API
 * 模式录完还要转两次。直接发原始字节就没有这一段了。
 */
export function framedBody(meta: unknown, payload: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + json.length + payload.length)
  new DataView(out.buffer).setUint32(0, json.length, true)
  out.set(json, 4)
  out.set(payload, 4 + json.length)
  return out
}

/** 读录音的原始字节。文件不在（保留期过了、被删了）时返回 null。 */
export async function readAudioFileBytes(filePath: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const buffer = await invoke<ArrayBuffer>('read_audio_file_bytes', { filePath })
  return buffer && buffer.byteLength > 0 ? new Uint8Array(buffer) : null
}

/** 把录音直接复制到「下载」文件夹（由 Rust 复制文件，不经过网页）。 */
export function saveRecordingToDownloads(filePath: string, filename: string) {
  return invoke<string>('save_recording_to_downloads', { filePath, filename })
}

export function savePcmAsWavRaw(id: string, pcm: Uint8Array, sampleRate?: number) {
  return invoke<string>('save_pcm_as_wav_raw', framedBody({ id, sampleRate: sampleRate ?? null }, pcm))
}

export function localTranscribeRaw(
  pcm: Uint8Array,
  opts: { modelId: string; language?: string; accelerator?: string; gpuDevice?: string },
) {
  return invoke<{ text: string; elapsed_ms: number }>('local_transcribe_raw', framedBody(opts, pcm))
}

export function cloudTranscribeRaw<T>(
  pcm: Uint8Array,
  request: { sample_rate: number; asr_config: unknown; hotwords: string[] },
) {
  return invoke<T>('cloud_transcribe_raw', framedBody(request, pcm))
}

export function readAudioFile(filePath: string) {
  return invoke<string | null>('read_audio_file', { filePath })
}

/**
 * 录音文件是否还在。
 *
 * 保留期到了之后 Rust 只删文件、不清历史记录里的 audioFilePath，
 * 所以「记录里有路径」不等于「文件还在」，凡是依赖录音的入口都要先问这一句。
 */
export function audioFileExists(filePath: string) {
  return invoke<boolean>('audio_file_exists', { filePath })
}

export function deleteAudioFile(filePath: string) {
  return invoke('delete_audio_file', { filePath })
}

// ─── Diagnostics ───

export function collectSettings() {
  return invoke<Record<string, unknown>>('collect_settings')
}

export function getDiagnosticsPreview(data: {
  settings: Record<string, unknown>
  issueOccurrence: DiagnosticOccurrence
}) {
  return invoke<DiagnosticsPreview>('get_diagnostics_preview', { data })
}

export function createDiagnosticsZip(data: unknown) {
  return invoke<string>('create_diagnostics_zip', { data })
}

/** 截图走二进制：参数里每张图只带 name / type / size，字节按顺序拼在后面（见 framedBody）。 */
export function createDiagnosticsZipRaw(
  meta: { description: string; issueType: string; settings: unknown; issueOccurrence: string },
  images: Array<{ name: string; type: string; bytes: Uint8Array }>,
) {
  const total = images.reduce((sum, image) => sum + image.bytes.length, 0)
  const payload = new Uint8Array(total)
  let offset = 0
  for (const image of images) {
    payload.set(image.bytes, offset)
    offset += image.bytes.length
  }
  const imageMeta = images.map((image) => ({ name: image.name, type: image.type, size: image.bytes.length }))
  return invoke<string>('create_diagnostics_zip_raw', framedBody({ ...meta, images: imageMeta }, payload))
}

/** 读诊断包的原始字节；文件不在时返回 null。 */
export async function readDiagnosticsZipBytes(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const buffer = await invoke<ArrayBuffer>('read_diagnostics_zip_bytes', { path })
  return buffer && buffer.byteLength > 0 ? new Uint8Array(buffer) : null
}

export function readDiagnosticsZip(path: string) {
  return invoke<number[] | null>('read_diagnostics_zip', { path })
}

export function copyDiagnosticsZip(source: string, destination: string) {
  return invoke<void>('copy_diagnostics_zip', { source, destination })
}

export function readLogFile(logType: string) {
  return invoke<string | null>('read_log_file', { logType })
}

export function openLogFolder() {
  return invoke('open_log_folder')
}

// ─── Event Listeners ───

export function onOverlayState(cb: (data: unknown) => void) {
  const unlisten = listen<unknown>('overlay-state', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTDown(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-down', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTUp(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-up', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTToggle(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-toggle', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTTimeoutWarning(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-timeout-warning', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onToggleHandsFree(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('toggle-hands-free', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onEscapeAction(cb: (data: { mode: EscapeActionMode; token: number }) => void) {
  const unlisten = listen<{ mode: EscapeActionMode; token: number }>('escape-action', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onCardHotkey(cb: (data: { action: CardHotkeyAction; token: number }) => void) {
  const unlisten = listen<{ action: CardHotkeyAction; token: number }>('card-hotkey', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

/** 事件名：悬浮窗自己收起了卡片（点关闭、或复制完成后自动收起）。 */
export const OVERLAY_CARD_DISMISSED = 'overlay-card-dismissed'

/**
 * 悬浮窗收起卡片后回报主窗。
 *
 * 为什么必须回报：卡片的**生命周期归主窗的 OverlayService 管**（它持有续期定时器）。
 * 悬浮窗那边只是一个渲染端，它 hideOverlay() 之后主窗毫不知情，8 秒后续期定时器
 * 又会把 Esc / Ctrl+C 重新注册一遍 —— 卡片早就没了，用户的按键却还被接管着，
 * 而且原生侧会重新抓一次前台窗口（此时可能已经是别的程序）。
 */
export function notifyCardDismissed(reason: string, token: number) {
  return emit(OVERLAY_CARD_DISMISSED, { reason, token })
}

export function onCardDismissed(cb: (data: { reason: string; token: number }) => void) {
  const unlisten = listen<{ reason: string; token: number }>(OVERLAY_CARD_DISMISSED, (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onMouseShortcutCaptured(cb: (data: { setting: string; vk: number }) => void) {
  const unlisten = listen<{ setting: string; vk: number }>('mouse-shortcut-captured', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

export function onPTTLabEvent(cb: (data?: unknown) => void) {
  const unlisten = listen<unknown>('ptt-lab-event', (event) => cb(event.payload))
  return () => { unlisten.then((fn) => fn()) }
}

/**
 * 这家 ASR 拿用户的热词做什么。**权威声明在 Rust**（providers/capabilities.rs）。
 *
 * 前端刻意不自己维护一份「哪家支持热词」的清单：issue #67 的成因正是实现在 Rust、
 * 声明在前端一张手写表格，两者无人对账，结果 6 家云服务被漏掉，界面平静地告诉
 * 用户热词生效。
 *
 * 失败时返回 null（而不是编一个"不支持"）—— 让调用方能把"查不到"和"确定不传"
 * 分开显示。老版本 Rust 没有这个 command 时也走这条。
 */
export function asrHotwordCapability(provider: string, extra?: Record<string, unknown>) {
  return invoke<AsrHotwordCapability>('asr_hotword_capability', { provider, extra })
    .catch(() => null)
}

/**
 * 全部服务的热词行为，供「各服务对热词的支持」对照表使用。
 *
 * 这张表因此是**实现的投影**，不是界面里的第二份手写清单 —— 后者就是 issue #67：
 * 表格漏了 6 家、还把「不支持」说成只是本地模型的问题，而没人会在改实现时想起它。
 *
 * 失败返回 null，调用方据此显示"暂时取不到"，不要退化成一张空表（空表看起来像
 * "所有服务都不支持"）。
 */
export function asrHotwordCapabilityMatrix() {
  return invoke<Record<string, AsrHotwordCapability>>('asr_hotword_capability_matrix')
    .catch(() => null)
}

/**
 * 前端内部广播：刚走完一次一次性云端转写，热词能力的答案可能已经变了。
 *
 * 只有「OpenAI 兼容」的 auto 协议会这样：它的答案在探测之前是 `undecided_protocol`，
 * 而探测就发生在 `cloud_transcribe` 内部（结果进 `asr_openai_compat` 的 PROTOCOL_CACHE）。
 * 热词页开着不动的时候完成首次录音，页面上那句"还没探测出来"会一直挂着 —— 它的查询
 * 只在挂载时跑过一次。
 *
 * 广播点刻意只放在 `cloud_transcribe` 之后，不放在录音结束：流式路径不碰协议探测
 * （`openai_compat` 没有流式实现），本地与服务器模式更不会。
 */
export const ASR_CAPABILITY_MAYBE_CHANGED_EVENT = 'sayit:asr-capability-maybe-changed'

export function notifyAsrCapabilityMaybeChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ASR_CAPABILITY_MAYBE_CHANGED_EVENT))
  }
}
