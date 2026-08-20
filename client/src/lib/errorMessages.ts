/**
 * 把底层异常翻译成用户能据此行动的一句话。
 *
 * 为什么需要这个：设置页原来直接把 `String(error)` 贴到界面上，用户看到的是
 * 「连接失败：TypeError: Failed to fetch」——这句话不区分「网址打错了」「本机没网」
 * 「服务挂了」「被 WAF 拦了」，四种情况的下一步完全不同，用户无从下手。
 *
 * 原始文本不丢弃：`detail` 保留原文给能看懂的人排查，UI 以次要字号展示。
 */

import { t } from '@/i18n'

export type ErrorActionHint = 'reset_url' | 'check_key' | 'switch_source' | 'retry' | 'none'

export type FriendlyErrorCode =
  | 'server_timeout'
  | 'server_unreachable'
  | 'server_forbidden'
  | 'server_not_sayit'
  | 'server_internal'
  | 'provider_timeout'
  | 'provider_unreachable'
  | 'provider_bad_key'
  | 'provider_forbidden'
  | 'provider_rate_limit'
  | 'provider_no_model'
  | 'download_network'
  | 'download_busy'
  | 'download_source_mismatch'
  | 'download_no_space'
  | 'download_permission'
  | 'download_checksum'
  | 'download_failed'
  | 'connect_failed'

export interface FriendlyError {
  /** 稳定分类；可持久化，展示时再按当前界面语言取文案。 */
  code: FriendlyErrorCode
  /** 一句话说清发生了什么，以及该往哪个方向查 */
  message: string
  /** 原始异常文本，供排查用；UI 以次要字号展示 */
  detail: string
  /** 建议提供的动作按钮类型，由调用方决定要不要渲染 */
  action: ErrorActionHint
}

const ERROR_PROTOCOL_PREFIX = 'sayit_error:'

interface DecodedError {
  code: FriendlyErrorCode | null
  text: string
}

const FRIENDLY_ERROR_CODES = new Set<FriendlyErrorCode>([
  'server_timeout',
  'server_unreachable',
  'server_forbidden',
  'server_not_sayit',
  'server_internal',
  'provider_timeout',
  'provider_unreachable',
  'provider_bad_key',
  'provider_forbidden',
  'provider_rate_limit',
  'provider_no_model',
  'download_network',
  'download_busy',
  'download_source_mismatch',
  'download_no_space',
  'download_permission',
  'download_checksum',
  'download_failed',
  'connect_failed',
])

/**
 * Rust/Tauri errors use `sayit_error:<stable-code>:<diagnostic detail>`.
 * The code is the contract; the detail may change language and remains useful for diagnostics.
 * Unknown codes deliberately fall back to legacy text classification for forward compatibility.
 */
function decodeError(error: unknown): DecodedError {
  const value = error instanceof Error ? (error.message || String(error)) : String(error)
  if (!value.startsWith(ERROR_PROTOCOL_PREFIX)) return { code: null, text: value }

  const separator = value.indexOf(':', ERROR_PROTOCOL_PREFIX.length)
  if (separator < 0) return { code: null, text: value }
  const candidate = value.slice(ERROR_PROTOCOL_PREFIX.length, separator)
  const text = value.slice(separator + 1)
  return FRIENDLY_ERROR_CODES.has(candidate as FriendlyErrorCode)
    ? { code: candidate as FriendlyErrorCode, text }
    : { code: null, text }
}

/**
 * 从各种异常文本里抠出 HTTP 状态码（`HTTP 401` / `status: 403` / `http=403` / `(404)`）。
 *
 * `http=403` 这一种是**我们自己**的格式：Rust 侧 `diag::http_summary` 写的就是
 * `[http=403 x-request-id=…]`。原来的正则把 `[:=]?` 只挂在 status 那个分支上，
 * 于是 `http=403` 认不出来 —— 我们自己产出的诊断串，自己的解析器读不懂。
 * 平时不显形是因为 Rust 会把稳定错误码一起带过来（走 stableCode 分支），
 * 只有拿不到错误码、退回按文本分类时才会暴露成"认不出的错误"。
 */
function extractHttpStatus(text: string): number | null {
  const match = text.match(/\b(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i)
    || text.match(/\((\d{3})\)/)
  if (!match) return null
  const code = Number(match[1])
  return code >= 100 && code <= 599 ? code : null
}

function isNetworkFailure(text: string): boolean {
  return /failed to fetch|networkerror|error sending request|econnrefused|enotfound|dns|connection refused|unreachable|websocket 连接失败/i // i18n-allow: 匹配底层中文错误串
    .test(text)
}

function isTimeout(text: string): boolean {
  return /timeout|timed out|超时/i.test(text) // i18n-allow: 匹配底层中文错误串
}

/**
 * 服务器地址类错误（健康检查、WebSocket 连接）。
 * `hasCustomUrl` 为 true 时才建议「恢复默认地址」——地址本来就是默认值时这个动作没意义。
 */
export function describeServerError(error: unknown, hasCustomUrl: boolean): FriendlyError {
  const { code: stableCode, text } = decodeError(error)
  const status = extractHttpStatus(text)

  if (stableCode === 'server_timeout' || isTimeout(text)) {
    return {
      code: 'server_timeout',
      message: t('err.server.timeout'),
      detail: text,
      action: 'retry',
    }
  }
  if (stableCode === 'server_unreachable' || isNetworkFailure(text)) {
    return {
      code: 'server_unreachable',
      message: t('err.server.unreachable'),
      detail: text,
      action: hasCustomUrl ? 'reset_url' : 'retry',
    }
  }
  if (stableCode === 'server_forbidden' || status === 401 || status === 403) {
    return {
      code: 'server_forbidden',
      message: t('err.server.forbidden', { status: String(status) }),
      detail: text,
      action: 'retry',
    }
  }
  if (stableCode === 'server_not_sayit' || status === 404) {
    return {
      code: 'server_not_sayit',
      message: t('err.server.notSayIt'),
      detail: text,
      action: hasCustomUrl ? 'reset_url' : 'retry',
    }
  }
  if (stableCode === 'server_internal' || (status && status >= 500)) {
    return {
      code: 'server_internal',
      message: t('err.server.internal', { status: String(status) }),
      detail: text,
      action: 'retry',
    }
  }
  return {
    code: 'connect_failed',
    message: t('err.connectFailed'),
    detail: text,
    action: hasCustomUrl ? 'reset_url' : 'retry',
  }
}

/** 云 API 供应商类错误（密钥校验、试拨一次识别） */
export function describeProviderError(error: unknown): FriendlyError {
  const { code: stableCode, text } = decodeError(error)
  const status = extractHttpStatus(text)

  if (stableCode === 'provider_timeout' || isTimeout(text)) {
    return { code: 'provider_timeout', message: t('err.provider.timeout'), detail: text, action: 'retry' }
  }
  if (stableCode === 'provider_unreachable' || isNetworkFailure(text)) {
    return {
      code: 'provider_unreachable',
      message: t('err.provider.unreachable'),
      detail: text,
      action: 'retry',
    }
  }
  // 401 才是明确的鉴权失败。403 单独一类（见下方分支）：403 的常见成因是
  // 「这个请求根本不该到这儿」——CDN 按地区拒绝、账号没开通该模型，响应里
  // 一个字都不提密钥。把它报成密钥问题只会让用户反复重建密钥。
  if (stableCode === 'provider_bad_key' || status === 401 || /invalid.*(key|token)|unauthorized|认证失败|鉴权/i.test(text)) { // i18n-allow: 匹配底层中文错误串
    return {
      code: 'provider_bad_key',
      message: t('err.provider.badKey'),
      detail: text,
      action: 'check_key',
    }
  }
  if (stableCode === 'provider_rate_limit' || status === 429 || /rate.?limit|quota|欠费|余额/i.test(text)) { // i18n-allow: 匹配底层中文错误串
    return {
      code: 'provider_rate_limit',
      message: t('err.provider.rateLimit'),
      detail: text,
      action: 'retry',
    }
  }
  // 排在限流之后：403 + quota 字样更可能是配额问题。
  // action 用 switch_source 而不是 retry —— 地区不可用重试一万次也是同一个结果，
  // 能解决问题的动作是换一家供应商。
  if (stableCode === 'provider_forbidden' || status === 403) {
    return {
      code: 'provider_forbidden',
      message: t('err.provider.forbidden'),
      detail: text,
      action: 'switch_source',
    }
  }
  if (stableCode === 'provider_no_model' || status === 404 || /model.*not.*(found|exist)/i.test(text)) {
    return {
      code: 'provider_no_model',
      message: t('err.provider.noModel'),
      detail: text,
      action: 'retry',
    }
  }
  return { code: 'connect_failed', message: t('err.connectFailed'), detail: text, action: 'retry' }
}

/** 模型下载类错误 */
export function describeDownloadError(error: unknown): FriendlyError {
  const { code: stableCode, text } = decodeError(error)

  if (stableCode === 'download_busy') {
    return {
      code: 'download_busy',
      message: t('err.download.generic'),
      detail: text,
      action: 'retry',
    }
  }
  if (stableCode === 'download_source_mismatch') {
    return {
      code: 'download_source_mismatch',
      message: t('err.download.checksum'),
      detail: text,
      action: 'switch_source',
    }
  }
  if (stableCode === 'download_network' || isTimeout(text) || isNetworkFailure(text)) {
    return {
      code: 'download_network',
      message: t('err.download.network'),
      detail: text,
      action: 'switch_source',
    }
  }
  if (stableCode === 'download_no_space' || /no space|磁盘|disk full|not enough space/i.test(text)) { // i18n-allow: 匹配底层中文错误串
    return {
      code: 'download_no_space',
      message: t('err.download.noSpace'),
      detail: text,
      action: 'none',
    }
  }
  if (stableCode === 'download_permission' || /permission|denied|access is denied|拒绝访问/i.test(text)) { // i18n-allow: 匹配底层中文错误串
    return {
      code: 'download_permission',
      message: t('err.download.permission'),
      detail: text,
      action: 'none',
    }
  }
  if (stableCode === 'download_checksum' || /checksum|sha256|校验/i.test(text)) { // i18n-allow: 匹配底层中文错误串
    return {
      code: 'download_checksum',
      message: t('err.download.checksum'),
      detail: text,
      action: 'switch_source',
    }
  }
  return {
    code: 'download_failed',
    message: t('err.download.generic'),
    detail: text,
    action: 'switch_source',
  }
}
