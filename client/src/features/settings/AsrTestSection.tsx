// ASR 测试卡片 — 用内置测试音频测试当前模式的识别效果

import { useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Play, Pause } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getSetting } from '@/services/store'
import { getProvider } from '@/services/transcription'
import type { WorkMode } from '@/services/transcription'

interface TestResult {
  text: string
  asrMs: number
  llmMs: number
  mode: string
  model: string
  audioDurationSec: number
}

export default function AsrTestSection({ workMode }: { workMode: WorkMode }) {
  const [testing, setTesting] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  async function handlePlay() {
    if (playing && audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      setPlaying(false)
      return
    }
    try {
      const b64 = await invoke<string>('get_test_audio_b64')
      const audio = new Audio(`data:audio/wav;base64,${b64}`)
      audioRef.current = audio
      audio.onended = () => setPlaying(false)
      setPlaying(true)
      await audio.play()
    } catch {
      setPlaying(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setResult(null)

    try {
      // 获取测试音频并计算时长
      const wavB64 = await invoke<string>('get_test_audio_b64')
      const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0))
      const pcmBytes = wavBytes.slice(44)
      const audioDurationSec = pcmBytes.length / 2 / 16000

      if (workMode === 'local') {
        const modelId = await getSetting('localAsr.modelId', 'sensevoice-small') as string
        const language = await getSetting('localAsr.language', 'auto') as string
        const r = await invoke<{ text: string; elapsed_ms: number; model_id: string }>('run_asr_benchmark', {
          modelId, language,
        })
        setResult({ text: r.text, asrMs: r.elapsed_ms, llmMs: 0, mode: '本地', model: r.model_id, audioDurationSec })
      } else if (workMode === 'cloud_api') {
        let pcmB64 = ''
        const chunk = 8192
        for (let i = 0; i < pcmBytes.length; i += chunk) {
          const slice = pcmBytes.subarray(i, Math.min(i + chunk, pcmBytes.length))
          pcmB64 += String.fromCharCode(...slice)
        }
        pcmB64 = btoa(pcmB64)

        const asrProvider = await getSetting('cloudAsr.provider', 'doubao_v2') as string
        const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
        const asrAppId = await getSetting('cloudAsr.appId', '') as string

        const isQwenOmni = asrProvider.startsWith('qwen_omni')
        const qwenOmniModel = asrProvider === 'qwen_omni_plus'
          ? 'qwen3.5-omni-plus-realtime'
          : asrProvider === 'qwen_omni_35_plus'
            ? 'qwen3.5-omni-plus-realtime'
            : asrProvider === 'qwen_omni_35_flash'
              ? 'qwen3.5-omni-flash-realtime'
              : asrProvider === 'qwen_omni_flash'
                ? 'qwen3-omni-flash-realtime'
                : asrProvider === 'qwen_omni_turbo'
                  ? 'qwen-omni-turbo-realtime'
                  : undefined
        let omniExtra: Record<string, unknown> | undefined
        if (isQwenOmni) {
          const savedPrompt = await getSetting('cloudAsr.omniSystemPrompt', '') as string
          omniExtra = { model: qwenOmniModel, instructions: savedPrompt || undefined }
        }

        const start = performance.now()
        const r = await invoke<{ text: string; elapsed_ms: number }>('cloud_transcribe', {
          request: {
            audio_b64: pcmB64,
            sample_rate: 16000,
            asr_config: {
              provider: isQwenOmni ? 'qwen_omni' : asrProvider,
              api_key: asrApiKey,
              app_id: asrAppId,
              ...(omniExtra && { extra: omniExtra }),
            },
          },
        })
        const totalMs = Math.round(performance.now() - start)
        // 映射内部 key 到实际模型 ID
        const ASR_MODEL_ID_MAP: Record<string, string> = {
          doubao_v2: 'Doubao-Seed-ASR-2.0',
          qwen: 'qwen3-asr-flash',
          qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
          qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
          qwen_omni_flash: 'qwen3-omni-flash-realtime',
          qwen_omni_turbo: 'qwen-omni-turbo-realtime',
          qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
        }
        const modelDisplay = isQwenOmni
          ? (qwenOmniModel || asrProvider)
          : (ASR_MODEL_ID_MAP[asrProvider] || asrProvider)
        setResult({ text: r.text, asrMs: totalMs, llmMs: 0, mode: '云 API', model: modelDisplay, audioDurationSec })
      } else {
        // 服务器模式
        const { getWSUrl } = await import('@/services/runtimeConfig')
        const wsUrl = getWSUrl()
        const start = performance.now()

        const r = await new Promise<{ text: string; asrMs: number }>((resolve, reject) => {
          const timeout = setTimeout(() => { try { sock.close() } catch {} reject(new Error('超时')) }, 30000)
          const sock = new WebSocket(wsUrl)
          sock.binaryType = 'arraybuffer'
          sock.onopen = () => {
            sock.send(JSON.stringify({ cmd: 'start', disable_ai: true }))
            // 分块发送 PCM（每块 3200 字节 = 100ms @16kHz 16bit mono）
            const chunkSize = 3200
            for (let i = 0; i < pcmBytes.length; i += chunkSize) {
              sock.send(pcmBytes.slice(i, i + chunkSize).buffer)
            }
            sock.send(JSON.stringify({ cmd: 'stop' }))
          }
          sock.onmessage = (e) => {
            if (typeof e.data !== 'string') return
            try {
              const msg = JSON.parse(e.data)
              if (msg.type === 'final') {
                clearTimeout(timeout)
                resolve({ text: msg.asr_text || '', asrMs: msg.asr_ms || 0 })
                sock.close()
              } else if (msg.type === 'error') {
                clearTimeout(timeout)
                reject(new Error(msg.message || '服务器错误'))
                sock.close()
              }
            } catch {}
          }
          sock.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket 连接失败')) }
        })

        const totalMs = Math.round(performance.now() - start)
        setResult({ text: r.text, asrMs: r.asrMs, llmMs: 0, mode: '服务器', model: '服务端 ASR', audioDurationSec })
      }
    } catch (err) {
      setResult({ text: `测试失败: ${String(err)}`, asrMs: 0, llmMs: 0, mode: workMode, model: '-', audioDurationSec: 0 })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">识别测试</h2>
            <p className="mt-1 text-xs text-muted-foreground">使用内置中文测试音频，测试当前模式的识别速度和准确率。</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={() => void handlePlay()}>
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {playing ? '暂停' : '播放'}
            </Button>
            <Button size="sm" variant="outline" className="h-9" onClick={() => void handleTest()} disabled={testing}>
              {testing ? '识别中...' : '开始测试'}
            </Button>
          </div>
        </div>

        {result && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="rounded bg-primary/10 px-2 py-0.5 text-primary">{result.mode}</span>
              <span className="rounded bg-muted px-2 py-0.5">{result.model}</span>
              <span className="text-border">|</span>
              <span>语音 {result.audioDurationSec.toFixed(1)}s</span>
              <span className="text-border">|</span>
              <span>ASR {result.asrMs}ms + LLM {result.llmMs}ms</span>
            </div>
            <p className="mt-2 text-sm text-foreground/80">{result.text || '（无识别结果）'}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
