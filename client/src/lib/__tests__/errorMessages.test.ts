import { describe, expect, it } from 'vitest'
import {
  describeDownloadError,
  describeProviderError,
  describeServerError,
} from '../errorMessages'

/**
 * 这些断言守住一条规则：设置页里不再出现原始异常文本作为主文案。
 * 每条错误都必须给出「发生了什么 + 往哪查」，并把原文降级到 detail。
 */
describe('describeServerError', () => {
  it('把 Failed to fetch 翻译成可行动的提示，并建议恢复默认地址', () => {
    const result = describeServerError(new TypeError('Failed to fetch'), true)
    expect(result.message).not.toContain('Failed to fetch')
    expect(result.message).toContain('连不上这个地址')
    expect(result.detail).toBe('Failed to fetch')
    expect(result.action).toBe('reset_url')
    expect(result.code).toBe('server_unreachable')
  })

  it('地址本来就是默认值时不提议恢复默认', () => {
    expect(describeServerError(new TypeError('Failed to fetch'), false).action).toBe('retry')
  })

  it('401/403 说清是权限问题而不是网络问题', () => {
    const result = describeServerError(new Error('HTTP 403'), true)
    expect(result.message).toContain('拒绝')
    expect(result.message).toContain('403')
  })

  it('404 指出这里要填服务根地址', () => {
    expect(describeServerError(new Error('HTTP 404'), true).message).toContain('根地址')
  })

  it('5xx 把责任指向服务端', () => {
    expect(describeServerError(new Error('HTTP 502'), true).message).toContain('服务端')
  })

  it('超时单独成一类', () => {
    expect(describeServerError(new Error('超时'), true).message).toContain('超时')
  })

  it('认不出来的错误也不把原文当主文案', () => {
    const result = describeServerError(new Error('weird internal thing'), false)
    expect(result.message).toBe('连接失败。')
    expect(result.detail).toBe('weird internal thing')
  })
})

describe('describeProviderError', () => {
  it('优先使用 Rust 稳定错误码，并从 detail 中剥掉协议前缀', () => {
    const result = describeProviderError('sayit_error:provider_bad_key:HTTP 418 translated detail')
    expect(result.code).toBe('provider_bad_key')
    expect(result.action).toBe('check_key')
    expect(result.detail).toBe('HTTP 418 translated detail')
  })

  it('密钥类失败指向密钥本身', () => {
    const result = describeProviderError('Invalid API key')
    expect(result.message).toContain('密钥被拒绝')
    expect(result.action).toBe('check_key')
    expect(result.code).toBe('provider_bad_key')
  })

  it('限流/欠费与密钥错误区分开', () => {
    expect(describeProviderError(new Error('HTTP 429 rate limit')).message).toContain('限流')
  })

  // 实测：Groq 在中国大陆 IP 上返回 403 {"error":{"message":"Forbidden"}}，
  // 而假密钥、真密钥、完全不带鉴权头三种情况的响应**完全相同** —— 请求在边缘节点
  // 就被拒了，密钥从未被验证。归成「密钥被拒绝」会把用户引去反复重建密钥。
  it('403 不报成密钥问题，而是指出可能是地区或权限', () => {
    // 实际链路：Rust 已经分好类，前端只按错误码取文案
    const tagged = describeProviderError('sayit_error:provider_forbidden:API error 403 Forbidden [http=403]')
    expect(tagged.code).toBe('provider_forbidden')
    expect(tagged.message).not.toContain('密钥被拒绝')
    expect(tagged.action).toBe('switch_source')

    // 退路：拿不到错误码时按文本分类，也不能落回「密钥被拒绝」。
    // 这里刻意用 `[http=403]` —— 那是 diag::http_summary 的格式，
    // 曾经因为正则认不出来而被归成"认不出的错误"。
    const raw = describeProviderError(new Error('API error 403 Forbidden [http=403]: {"error":{"message":"Forbidden"}}'))
    expect(raw.code).toBe('provider_forbidden')
  })

  it('403 但服务端明确说密钥无效时，仍然算密钥问题', () => {
    expect(describeProviderError(new Error('HTTP 403: Invalid API key')).code).toBe('provider_bad_key')
  })

  it('模型未开通给出换供应商的方向', () => {
    expect(describeProviderError(new Error('model not found')).message).toContain('模型')
  })
})

describe('describeDownloadError', () => {
  it('错误分类不依赖 Rust detail 使用哪种语言', () => {
    const result = describeDownloadError('sayit_error:download_no_space:write failed')
    expect(result.code).toBe('download_no_space')
    expect(result.action).toBe('none')
    expect(result.detail).toBe('write failed')
  })

  it('网络中断建议换下载源', () => {
    const result = describeDownloadError('error sending request for url (https://hf-mirror.com/...)')
    expect(result.message).toContain('换一个下载源')
    expect(result.action).toBe('switch_source')
    expect(result.code).toBe('download_network')
    expect(result.detail).toContain('hf-mirror.com')
  })

  it('磁盘空间不足单独成一类，不建议换源', () => {
    const result = describeDownloadError('No space left on device')
    expect(result.message).toContain('磁盘空间不足')
    expect(result.action).toBe('none')
  })

  it('校验失败建议换源重下', () => {
    expect(describeDownloadError('sha256 mismatch').action).toBe('switch_source')
  })

  it('重复下载只建议稍后重试，不误导用户切换下载源', () => {
    const result = describeDownloadError('sayit_error:download_busy:already downloading')
    expect(result.code).toBe('download_busy')
    expect(result.action).toBe('retry')
  })

  it('远端大小与目录不一致时建议切换下载源', () => {
    const result = describeDownloadError('sayit_error:download_source_mismatch:size changed')
    expect(result.code).toBe('download_source_mismatch')
    expect(result.action).toBe('switch_source')
  })
})
