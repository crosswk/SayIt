// 云 API 模式配置面板

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { Eye, EyeOff, ExternalLink, AlertTriangle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getSetting, setSetting } from '@/services/store'
import { isQwenOmniProvider, resolveQwenOmniModel } from '@/lib/asrModels'

const ASR_PROVIDERS = [
  { value: 'doubao_v2', label: '豆包 ASR（Doubao-Seed-ASR-2.0）' },
  { value: 'qwen', label: '千问 ASR（qwen3-asr-flash）' },
  { value: 'qwen_realtime', label: '千问 ASR 流式（qwen3-asr-flash-realtime）' },
  { value: 'qwen_omni_35_plus', label: '千问 3.5 Omni Plus（qwen3.5-omni-plus，ASR+AI）' },
  { value: 'qwen_omni_35_flash', label: '千问 3.5 Omni Flash（qwen3.5-omni-flash，ASR+AI）' },
]

interface TestResult {
  ok: boolean
  message: string
  elapsed_ms: number
}

function PasswordInput({ value, onChange, placeholder, className }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={className}
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/50 hover:text-muted-foreground"
        tabIndex={-1}
      >
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

const DEFAULT_OMNI_PROMPT = '你是一个语音转文字助手。请将用户的语音内容准确转写为文字，保持原意，适当添加标点符号，不要添加任何额外的解释或评论。'

const OMNI_PROMPT_POLISH = `你是语音文本精炼助手。输入是 ASR 语音识别的原始转写，你的任务是清洗为可直接使用的干净文本。
核心原则：保留用户全部有效信息，只清除语音噪声和识别错误。
处理规则：
1. 移除口语填充词（嗯、啊、那个、就是说、然后呢）和无意义的重复、犹豫。
2. 识别自我修正——"不对"、"不是"、"应该是"、"改到"后以最终表达为准，删除前序错误。
3. 修正明显的语音识别错误：同音字、音近字、专有名词、英文大小写、数字和时间。
4. 添加标点符号，必要时分段。中英文混合保留合理空格。
5. 检测到"第一/第二/首先/然后"等结构化表达时，输出为有序列表。
约束：不添加原文没有的内容，不改变用户核心语义；不回答、解释、总结或续写文本中提到的问题。
只输出精炼后的文本。`

const OMNI_PROMPT_PRESETS = [
  { id: 'faithful', label: '忠实转录', prompt: DEFAULT_OMNI_PROMPT },
  { id: 'polish', label: '口语润色', prompt: OMNI_PROMPT_POLISH },
] as const

// 供应商按平台分组，同平台共享 API Key
function asrKeyGroup(provider: string): string {
  if (provider === 'doubao_v2' || provider === 'doubao') return 'doubao'
  return 'qwen' // qwen, qwen_omni_flash, qwen_omni_plus 都用百炼 key
}

/** 根据供应商检查 API Key 格式，返回提示文字（空字符串表示格式正常） */
function checkAsrKeyFormat(provider: string, key: string): string {
  const k = key.trim()
  if (!k) return ''
  if (provider === 'doubao_v2' || provider === 'doubao') {
    // 豆包 Access Token：32 位字母数字
    if (!/^[A-Za-z0-9]+$/.test(k)) {
      return '豆包 Access Token 通常为纯字母数字组合，请确认是否包含了多余字符'
    }
    if (k.length !== 32) {
      return `豆包 Access Token 通常为 32 位（当前 ${k.length} 位），请确认是否正确`
    }
  } else {
    // 百炼平台 API Key：通常以 sk- 开头
    if (!/^sk-/.test(k)) {
      return '百炼 API Key 通常以 sk- 开头，请确认格式是否正确'
    }
  }
  return ''
}

/** 检查豆包 App ID 格式 */
function checkAsrAppIdFormat(appId: string): string {
  const id = appId.trim()
  if (!id) return ''
  if (!/^\d+$/.test(id)) {
    return 'App ID 通常为纯数字，请确认是否包含了多余字符'
  }
  if (id.length !== 10) {
    return `App ID 通常为 10 位数字（当前 ${id.length} 位），请确认是否正确`
  }
  return ''
}

export default function CloudAPISection() {
  // ASR 配置
  const [asrProvider, setAsrProvider] = useState('doubao_v2')
  const [asrApiKey, setAsrApiKey] = useState('')
  const [asrAppId, setAsrAppId] = useState('')
  const [asrTesting, setAsrTesting] = useState(false)
  const [asrMessage, setAsrMessage] = useState('')
  const [omniSystemPrompt, setOmniSystemPrompt] = useState(DEFAULT_OMNI_PROMPT)

  // 加载指定平台的 ASR key
  async function loadAsrKeys(provider: string) {
    const group = asrKeyGroup(provider)
    // 先尝试读分组 key，fallback 到旧的全局 key（向后兼容）
    const groupKey = await getSetting(`cloudAsr.${group}.apiKey`, '') as string
    const groupAppId = await getSetting(`cloudAsr.${group}.appId`, '') as string
    if (groupKey) {
      setAsrApiKey(groupKey)
      setAsrAppId(groupAppId)
    } else {
      // 向后兼容：读旧的全局 key
      setAsrApiKey(await getSetting('cloudAsr.apiKey', '') as string)
      setAsrAppId(await getSetting('cloudAsr.appId', '') as string)
    }
  }

  useEffect(() => {
    void loadSettings()
  }, [])

  async function loadSettings() {
    const provider = await getSetting('cloudAsr.provider', 'doubao_v2') as string
    setAsrProvider(provider)
    await loadAsrKeys(provider)
    setOmniSystemPrompt(await getSetting('cloudAsr.omniSystemPrompt', DEFAULT_OMNI_PROMPT) as string)
  }

  // 切换供应商时自动保存 provider 并加载对应平台的 key，同步到全局 key
  function handleAsrProviderChange(newProvider: string) {
    setAsrProvider(newProvider)
    setAsrMessage('')
    void (async () => {
      await setSetting('cloudAsr.provider', newProvider)
      const group = asrKeyGroup(newProvider)
      const groupKey = await getSetting(`cloudAsr.${group}.apiKey`, '') as string
      const groupAppId = await getSetting(`cloudAsr.${group}.appId`, '') as string
      if (groupKey) {
        setAsrApiKey(groupKey)
        setAsrAppId(groupAppId)
        // 自动同步到全局 key，这样 CloudAPIProvider 能读到
        await setSetting('cloudAsr.apiKey', groupKey)
        await setSetting('cloudAsr.appId', groupAppId)
      } else {
        const globalKey = await getSetting('cloudAsr.apiKey', '') as string
        const globalAppId = await getSetting('cloudAsr.appId', '') as string
        setAsrApiKey(globalKey)
        setAsrAppId(globalAppId)
      }
    })()
  }

  async function saveAndTestAsr() {
    // 先保存
    const group = asrKeyGroup(asrProvider)
    await setSetting(`cloudAsr.${group}.apiKey`, asrApiKey)
    await setSetting(`cloudAsr.${group}.appId`, asrAppId)
    await setSetting('cloudAsr.apiKey', asrApiKey)
    await setSetting('cloudAsr.appId', asrAppId)
    if (asrProvider.startsWith('qwen_omni')) {
      await setSetting('cloudAsr.omniSystemPrompt', omniSystemPrompt)
    }

    // 再测试
    setAsrTesting(true)
    setAsrMessage('')
    try {
      const isQwenOmni = isQwenOmniProvider(asrProvider)
      const qwenOmniModel = resolveQwenOmniModel(asrProvider)

      const result = await invoke<TestResult>('test_asr_connection', {
        config: {
          provider: isQwenOmni ? 'qwen_omni' : asrProvider,
          api_key: asrApiKey,
          app_id: asrAppId,
          ...(isQwenOmni && { extra: { model: qwenOmniModel } }),
        },
      })
      setAsrMessage(result.ok ? `已保存，${result.message}` : `已保存，但连接失败：${result.message}`)
    } catch (err) {
      setAsrMessage(`已保存，但测试失败：${String(err)}`)
    } finally {
      setAsrTesting(false)
    }
  }

  const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm outline-none transition-colors focus:border-input-focus-border'
  const selectClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-2 text-sm outline-none transition-colors focus:border-input-focus-border'

  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-1 text-lg font-semibold">语音识别 (ASR)</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            推荐使用豆包 ASR 进行语音识别，准确率高，速度快。
          </p>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">供应商</label>
              <select
                value={asrProvider}
                onChange={(e) => handleAsrProviderChange(e.target.value)}
                className={selectClass}
              >
                {ASR_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value} disabled={'disabled' in p && !!p.disabled}>{p.label}</option>
                ))}
              </select>
            </div>
            {/* 豆包：App ID 在 API Key 前面 */}
            {asrProvider !== 'qwen' && !asrProvider.startsWith('qwen_omni') && (
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">App ID</label>
              <input
                value={asrAppId}
                onChange={(e) => setAsrAppId(e.target.value)}
                placeholder="输入 App ID（豆包需要）"
                className={inputClass}
              />
              {checkAsrAppIdFormat(asrAppId) && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-500">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {checkAsrAppIdFormat(asrAppId)}
                </p>
              )}
            </div>
            )}
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">
                {asrProvider === 'doubao_v2' ? 'Access Token' : 'API Key'}
              </label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <PasswordInput
                    value={asrApiKey}
                    onChange={setAsrApiKey}
                    placeholder={asrProvider === 'doubao_v2' ? '输入火山引擎 Access Token' : '输入百炼平台 API Key'}
                    className={inputClass}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => void saveAndTestAsr()}
                  disabled={asrTesting || !asrApiKey}
                >
                  {asrTesting ? '测试中...' : '保存'}
                </Button>
              </div>
              {asrMessage && <p className="mt-1.5 text-xs text-muted-foreground">{asrMessage}</p>}
              {!asrMessage && checkAsrKeyFormat(asrProvider, asrApiKey) && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-500">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {checkAsrKeyFormat(asrProvider, asrApiKey)}
                </p>
              )}
            </div>
            {asrProvider.startsWith('qwen_omni') && (
              <div>
                <label className="mb-1.5 block text-sm text-muted-foreground">System Prompt</label>
                <div className="mb-1.5 flex gap-1.5">
                  {OMNI_PROMPT_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setOmniSystemPrompt(p.prompt)}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        omniSystemPrompt === p.prompt
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-input-border text-muted-foreground hover:border-primary/50'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <textarea
                  value={omniSystemPrompt}
                  onChange={(e) => setOmniSystemPrompt(e.target.value)}
                  placeholder={DEFAULT_OMNI_PROMPT}
                  rows={2}
                  className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm outline-none transition-colors focus:border-input-focus-border resize-y"
                />
              </div>
            )}
            {asrProvider.startsWith('qwen_omni') && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  💡 该模型同时具备语音识别和 AI 理解能力，无需再单独配置下方的「AI 校对」。
                </p>
              </div>
            )}
            {asrProvider === 'doubao_v2' && (
              <button
                type="button"
                onClick={() => void shellOpen('https://my.feishu.cn/wiki/V4vLw2UfDiWcATkK2dyckhvynzc')}
                className="inline-flex items-center gap-1 text-xs text-primary/70 underline underline-offset-2 decoration-primary/30 transition-colors hover:text-primary hover:decoration-primary/60"
              >
                SayIt 语音识别配置
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>
        </CardContent>
      </Card>
  )
}
