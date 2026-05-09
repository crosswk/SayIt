/**
 * 敏感字段脱敏工具
 * 用于导出、诊断报告等场景，防止 API Key 等凭据泄露
 */

/** 匹配敏感 key 的模式（不区分大小写） */
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /apikey/i,
  /access[_-]?token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /app[_-]?id/i,
]

/** 判断一个 key 是否为敏感字段 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/** 对敏感值进行脱敏（保留前 3 位 + 后 2 位，中间用 *** 替代） */
export function maskValue(value: unknown): string {
  const str = String(value ?? '')
  if (str.length <= 8) return '***'
  return `${str.slice(0, 3)}***${str.slice(-2)}`
}

/**
 * 递归脱敏对象中的敏感字段
 * 返回新对象，不修改原对象
 */
export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as unknown as T
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveKey(key) && typeof value === 'string' && value.length > 0) {
      result[key] = maskValue(value)
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeObject(value)
    } else {
      result[key] = value
    }
  }
  return result as T
}
