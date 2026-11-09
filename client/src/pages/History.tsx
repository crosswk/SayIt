import * as bridge from '@/services/bridge'
import { cn } from '@/lib/utils'
import { buildAsrExtra, resolveAsrDisplayModel, isQwenOmniProvider } from '@/lib/asrModels'
import { getWorkMode } from '@/services/transcription'
import { polishWithClientAi } from '@/services/transcription/clientAiPolish'
import {
  extractServerAiEvidence,
  policyFromSnapshot,
  resolveAndLogAiOutcome,
  serverShouldPolish,
  type AiConfigSnapshot,
  type AiOutcomeContext,
} from '@/services/transcription/aiPolicy'
import { SERVER_AI_SOURCE_KEY } from '@/services/transcription/serverAiSource'
import type { AiExecutionSource, AiExecutionStatus, WorkMode } from '@/services/transcription'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, Search, Check, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useSlidingIndicator } from '@/components/ui/useSlidingIndicator'
import HistoryRecordList from '@/components/history/HistoryRecordList'
import { exportHistory } from '@/services/exports'
import {
  countHistory,
  deleteHistory,
  listHistory,
  setHistoryFavorite,
  updateHistoryRecord,
  getActivePreset,
  getSetting,
  type HistoryRecord,
} from '@/services/store'
import { useT } from '@/i18n/useT'
import { applyTextTransforms, restoreHotwordSpacing } from '@/services/textPostProcess'
import { buildHotwordInjectionPart } from '@/services/personalization/promptRouter'
import {
  BUILTIN_SET_WORDS_KEY,
  BUILTIN_SET_ACTIVE_KEY,
  BUILTIN_SET_EXTRA_WORDS_KEY,
  CUSTOM_THEMES_KEY,
  CUSTOM_THEME_ACTIVE_KEY,
  composeHotwords,
  normalizeBuiltinSetActive,
  normalizeBuiltinSetWords,
  normalizeCustomThemeActive,
  normalizeCustomThemes,
} from '@/services/hotwords/model'

const HISTORY_PAGE_SIZE = 100

interface ReprocessResult {
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  asrEngine?: string
  asrModel?: string
  aiSource?: AiExecutionSource
  aiStatus?: AiExecutionStatus
  aiReason?: string
  aiProvider?: string
  aiModel?: string
  serverAi?: { error?: string; provider?: string }
}

/**
 * 一次重跑的 AI 上下文。
 *
 * snapshot 是**这次重跑**的配置（不是被重跑那条记录当初的配置）；operationId 每次新建，
 * 不复用旧记录的标识，否则两次处理在日志里分不开。
 */
interface ReprocessAiContext {
  snapshot: AiConfigSnapshot
  context: AiOutcomeContext
}

async function buildReprocessAiContext(recordId: string): Promise<ReprocessAiContext> {
  const [rawSource, rawMin, rawEnabled] = await Promise.all([
    getSetting(SERVER_AI_SOURCE_KEY, 'managed') as Promise<string>,
    getSetting('aiMinDurationSec', 0),
    getSetting('aiEnabled', false),
  ])
  return {
    snapshot: {
      workMode: getWorkMode(),
      aiEnabled: Boolean(rawEnabled),
      aiMinDurationSec: Math.max(0, Number(rawMin) || 0),
      serverAiSource: rawSource === 'custom' ? 'custom' : 'managed',
    },
    context: {
      operationId: `reprocess-${recordId}-${Date.now().toString(36)}`,
      trigger: 'history_reprocess',
    },
  }
}

/** 服务器模式重新识别：通过独立 WebSocket 连接，避免干扰全局连接 */
async function reprocessViaServer(
  chunk: ArrayBuffer,
  hotwords: string[],
  ai: ReprocessAiContext,
  systemPrompt: string | undefined,
  clientMeta: Awaited<ReturnType<typeof bridge.getClientRuntimeInfo>> | null,
): Promise<ReprocessResult> {
  const { getWSUrl } = await import('@/services/runtimeConfig')
  const wsUrl = getWSUrl()
  const audioDurationSec = (chunk.byteLength / 2) / 16000
  // 判据与实时录音共用同一个函数。这里原来自己又算了一遍门槛/来源/是否用内置 AI，
  // 是本轮要消灭的第二份实现。
  const policy = policyFromSnapshot(ai.snapshot, 'server', audioDurationSec)
  const useManagedAi = serverShouldPolish(policy)
  const useCustomAi = policy.allowCall && policy.route === 'custom'

  const serverResult = await new Promise<ReprocessResult>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      reject(new Error('Retranscription timed out'))
    }, 30_000) // ASR 最多 30 秒

    const socket = new WebSocket(wsUrl)
    socket.binaryType = 'arraybuffer'

    let resolved = false

    socket.onopen = () => {
      const startMsg: Record<string, unknown> = {
        cmd: 'start',
        source: 'history_reprocess',
        disable_ai: !useManagedAi,
      }
      if (useManagedAi && systemPrompt) startMsg.system_prompt = systemPrompt
      if (clientMeta) {
        startMsg.client_meta = {
          user_id: clientMeta.userId,
          device_id: clientMeta.deviceId,
          hostname: clientMeta.hostname,
          client_version: clientMeta.clientVersion,
          platform: clientMeta.platform,
          os_version: clientMeta.osVersion,
          local_ip: clientMeta.localIp,
          system_locale: clientMeta.systemLocale,
          cpu_cores: clientMeta.cpuCores,
          memory_mb: clientMeta.memoryMb,
        }
      }
      if (hotwords.length > 0) startMsg.hotwords = hotwords
      socket.send(JSON.stringify(startMsg))

      // 分片发送 PCM 数据
      const CHUNK_SIZE = 32000
      const totalBytes = chunk.byteLength
      for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, totalBytes)
        socket.send(chunk.slice(offset, end))
      }

      socket.send(JSON.stringify({ cmd: 'stop' }))
    }

    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'final') {
          resolved = true
          clearTimeout(timeout)
          socket.close()
          resolve({
            asrText: msg.asr_text || '',
            llmText: msg.llm_text || '',
            asrMs: msg.asr_ms || 0,
            llmMs: msg.llm_ms || 0,
            durationSec: Number(msg.duration_sec || 0),
            asrEngine: msg.asr_engine || undefined,
            asrModel: msg.asr_model || undefined,
            // 与实时路径同一个提取函数：重跑此前完全不看执行证据，于是服务端
            // 调用失败在重跑后的记录里和"没调用"分不开。
            serverAi: extractServerAiEvidence(msg.llm_debug),
          })
        } else if (msg.type === 'done' && !resolved) {
          // 没有 final 就 done 了（后端判定为静音/无结果）
          resolved = true
          clearTimeout(timeout)
          socket.close()
          resolve({ asrText: '', llmText: '', asrMs: 0, llmMs: 0, durationSec: 0 })
        } else if (msg.type === 'error') {
          resolved = true
          clearTimeout(timeout)
          socket.close()
          reject(new Error(msg.message || 'backend error'))
        }
      } catch { /* ignore parse errors */ }
    }

    socket.onerror = () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        reject(new Error('WebSocket connection error'))
      }
    }

    socket.onclose = (ev) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        reject(new Error(`WebSocket closed unexpectedly, code=${ev.code}`))
      }
    }
  })

  if (!useCustomAi) {
    // 内置 AI 路线（含空识别、总开关关闭、低于门槛）：结论一律由共用判据给出，
    // 不再拿 llmMs > 0 反推成功失败。
    const outcome = resolveAndLogAiOutcome(ai.context, policy, {
      asrTextEmpty: !serverResult.asrText.trim(),
      serverError: serverResult.serverAi?.error,
      serverProvider: serverResult.serverAi?.provider,
      llmMs: serverResult.llmMs,
    })
    return {
      ...serverResult,
      aiSource: outcome.source,
      aiStatus: outcome.status,
      aiReason: outcome.reason,
      aiProvider: outcome.provider,
      aiModel: outcome.model,
    }
  }

  const polished = await polishWithClientAi({
    asrText: serverResult.asrText,
    startOptions: {
      runId: 1,
      operationId: ai.context.operationId,
      aiConfig: ai.snapshot,
      systemPrompt,
      source: 'history_reprocess',
    },
    policy,
    outcomeContext: ai.context,
    logSource: 'history',
  })
  return polished ? { ...serverResult, ...polished } : serverResult
}

/** 云 API 模式重新识别：调用 cloud_transcribe + 可选 cloud_polish，与 CloudAPIProvider 一致 */
async function reprocessViaCloudApi(
  chunk: ArrayBuffer,
  hotwords: string[],
  ai: ReprocessAiContext,
  systemPrompt: string | undefined,
): Promise<ReprocessResult> {
  const durationSec = (chunk.byteLength / 2) / 16000

  const asrProvider = await getSetting('cloudAsr.provider', 'doubao') as string
  const isQwenOmni = isQwenOmniProvider(asrProvider)
  const asrApiKey = await getSetting('cloudAsr.apiKey', '') as string
  const asrAppId = await getSetting('cloudAsr.appId', '') as string
  const asrModel = await getSetting('cloudAsr.model', '') as string

  let omniInstructions: string | undefined
  if (isQwenOmni) {
    const savedPrompt = await getSetting('cloudAsr.omniSystemPrompt', '') as string
    omniInstructions = savedPrompt || undefined
  }

  const baseUrl = await getSetting('cloudAsr.baseUrl', '') as string
  const protocol = await getSetting('cloudAsr.protocol', 'auto') as string
  const extra = buildAsrExtra(asrProvider, {
    model: asrModel,
    instructions: omniInstructions,
    baseUrl,
    protocol,
  })
  const asrConfig: Record<string, unknown> = {
    provider: isQwenOmni ? 'qwen_omni' : asrProvider,
    api_key: asrApiKey,
    app_id: asrAppId,
    ...(extra && { extra }),
  }

  const asrStart = performance.now()
  const asrResult = await bridge.cloudTranscribeRaw<{ text: string; elapsed_ms: number }>(
    new Uint8Array(chunk),
    { sample_rate: 16000, asr_config: asrConfig, hotwords },
  )
  // 还原被 ASR 拆开加空格的无空格热词（如豆包把 "SayIt" 识别成 "Say It"）
  const asrText = restoreHotwordSpacing(asrResult.text, hotwords)
  const asrMs = asrResult.elapsed_ms || Math.round(performance.now() - asrStart)

  // 改走共用润色。原来这里直接 invoke('cloud_polish')，与实时路径有三处分歧：
  //   1. 完全不检查短语音门槛（实时会跳过的语音，重跑却会调 AI）；
  //   2. 配置判据写成 `url && key && model`，漏了 ollama 免密豁免 —— ollama 用户
  //      重跑时被静默判成"配置不完整"；
  //   3. catch 空吞，既无日志也无执行状态，失败与未调用在记录里分不开。
  const policy = policyFromSnapshot(ai.snapshot, 'cloud_api', durationSec, isQwenOmni)
  const polish = await polishWithClientAi({
    asrText,
    startOptions: {
      runId: 1,
      operationId: ai.context.operationId,
      aiConfig: ai.snapshot,
      systemPrompt,
      source: 'history_reprocess',
    },
    policy,
    outcomeContext: ai.context,
    logSource: 'history',
  })

  return {
    asrText,
    llmText: polish?.llmText ?? asrText,
    asrMs,
    llmMs: polish?.llmMs ?? 0,
    durationSec,
    aiSource: polish?.aiSource,
    aiStatus: polish?.aiStatus,
    aiReason: polish?.aiReason,
    aiProvider: polish?.aiProvider,
    aiModel: polish?.aiModel,
    ...(isQwenOmni && { asrEngine: 'qwen_omni', asrModel: extra?.model }),
  }
}

/** 本地模式重新识别：调用 local_transcribe + 可选 cloud_polish，与 LocalProvider 一致 */
async function reprocessViaLocal(
  chunk: ArrayBuffer,
  hotwords: string[],
  ai: ReprocessAiContext,
  systemPrompt: string | undefined,
): Promise<ReprocessResult> {
  const durationSec = (chunk.byteLength / 2) / 16000

  const modelId = await getSetting('localAsr.modelId', 'sensevoice-small-gguf') as string
  const language = await getSetting('localAsr.language', 'auto') as string
  const accelerator = await getSetting('localAsr.accelerator', 'auto') as string
  const gpuDevice = await getSetting('localAsr.gpuDevice', '') as string

  // hotwords 在 GGUF 引擎上不支持（transcribe.cpp 只有 whisper 族接 initial prompt），
  // 参数留着是为了不改调用方签名，后端会忽略。
  void hotwords
  const asrResult = await bridge.localTranscribeRaw(new Uint8Array(chunk), {
    modelId, language, accelerator, gpuDevice,
  })
  const asrText = asrResult.text
  const asrMs = asrResult.elapsed_ms

  // 同云 API 重跑：改走共用润色，补上短语音门槛与执行状态（原来也是空 catch 吞掉失败）。
  const policy = policyFromSnapshot(ai.snapshot, 'local', durationSec)
  const polish = await polishWithClientAi({
    asrText,
    startOptions: {
      runId: 1,
      operationId: ai.context.operationId,
      aiConfig: ai.snapshot,
      systemPrompt,
      source: 'history_reprocess',
    },
    policy,
    outcomeContext: ai.context,
    logSource: 'history',
  })

  return {
    asrText,
    llmText: polish?.llmText ?? asrText,
    asrMs,
    llmMs: polish?.llmMs ?? 0,
    durationSec,
    aiSource: polish?.aiSource,
    aiStatus: polish?.aiStatus,
    aiReason: polish?.aiReason,
    aiProvider: polish?.aiProvider,
    aiModel: polish?.aiModel,
  }
}

/** 重新识别后写回历史记录所需的供应商元数据 */
async function buildReprocessMetadata(
  workMode: WorkMode,
  result: ReprocessResult,
): Promise<{
  asrProvider?: string
  aiProvider?: string
  aiModel?: string
  aiSource?: AiExecutionSource
  aiStatus?: AiExecutionStatus
}> {
  // AI 那几个字段一律取本次执行结果，不再读当前设置。
  //
  // 此前只有 server 分支返回 aiSource/aiStatus，cloud_api 与 local 返回 undefined，
  // 而写回是显式传值 —— 于是重跑一次就把记录里原有的执行状态抹成空；同时 aiProvider
  // 照当前设置填，哪怕这次 AI 压根没跑，记录里也会写着某个服务商。
  const aiFields = {
    aiSource: result.aiSource,
    aiStatus: result.aiStatus,
    // 只有真的执行到（或尝试过）才写服务商，避免"没跑却记着供应商"。
    aiProvider: result.aiStatus === 'skipped' ? undefined : result.aiProvider,
    aiModel: result.aiStatus === 'skipped' ? undefined : result.aiModel,
  }

  if (workMode === 'cloud_api') {
    const asrProviderKey = await getSetting('cloudAsr.provider', '') as string
    // 选定的模型要一起带上：只按 provider 推的话，用户明明选了 whisper-large-v3，
    // 历史记录里却会写成该服务的默认模型
    const asrSelectedModel = await getSetting('cloudAsr.model', '') as string
    return { asrProvider: resolveAsrDisplayModel(asrProviderKey, asrSelectedModel), ...aiFields }
  }
  if (workMode === 'local') {
    const modelId = await getSetting('localAsr.modelId', '') as string
    return { asrProvider: modelId || 'local', ...aiFields }
  }
  return {
    asrProvider: (result.asrModel || result.asrEngine || 'server').replace(/^.*\//, ''),
    ...aiFields,
  }
}

export default function History() {
  const t = useT()
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const filterGroupRef = useRef<HTMLDivElement>(null)
  const filterIndicatorRef = useSlidingIndicator(filterGroupRef, favoriteOnly, { activeSelector: '[aria-pressed="true"]' })
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE)
  const [totalCount, setTotalCount] = useState(0)
  const [exportResult, setExportResult] = useState<{ filePath: string | null; canceled: boolean } | null>(null)

  const loadRecords = useCallback(async (searchKeyword: string, limit: number, favOnly: boolean) => {
    const [items, total] = await Promise.all([
      listHistory({ keyword: searchKeyword, favoriteOnly: favOnly, limit, offset: 0 }),
      countHistory({ keyword: searchKeyword, favoriteOnly: favOnly }),
    ])
    setRecords(items)
    setTotalCount(total)
  }, [])

  useEffect(() => {
    setVisibleCount(HISTORY_PAGE_SIZE)
  }, [debouncedKeyword, favoriteOnly])

  // 搜索防抖：输入停止 300ms 后才触发查询
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 300)
    return () => clearTimeout(timer)
  }, [keyword])

  useEffect(() => {
    void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
  }, [debouncedKeyword, favoriteOnly, loadRecords, visibleCount])

  // 监听新记录写入，自动刷新列表
  useEffect(() => {
    const unlisten = bridge.listen('history-updated', () => {
      void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
    })
    return () => { void unlisten.then((fn) => fn()) }
  }, [debouncedKeyword, visibleCount, favoriteOnly, loadRecords])

  const handleDelete = async (id: string) => {
    // Clean up audio file if it exists
    const record = records.find((r) => r.id === id)
    if (record?.audioFilePath) {
      try { await bridge.deleteAudioFile(record.audioFilePath) } catch { /* ignore */ }
    }
    await deleteHistory(id)
    void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
  }

  const handleToggleFavorite = async (id: string, nextFavorite: boolean) => {
    await setHistoryFavorite(id, nextFavorite)
    setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, favorite: nextFavorite } : r)))
  }

  const handleEdit = async (id: string, nextText: string) => {
    const editedAt = Date.now()
    const patch = {
      llmText: nextText,
      charCount: nextText.length,
      isEmpty: !nextText.trim(),
      manualEditedAt: editedAt,
    }
    await updateHistoryRecord(id, patch)
    // 局部更新，避免整页刷新丢失展开态/滚动位置
    setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  /**
   * 记下「这条的 ASR 纠错已提交 / 已撤回」。
   *
   * 只写 asrCorrection* 三个字段，**不动 llmText / charCount / manualEditedAt** ——
   * 纠正的是识别原文，正文和统计不该被它带着改（handleEdit 改的才是正文）。
   */
  const handleSaveAsrCorrection = async (id: string, patch: Partial<HistoryRecord>) => {
    await updateHistoryRecord(id, patch)
    setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const handleExport = async () => {
    const result = await exportHistory({ keyword: debouncedKeyword })
    setExportResult(result)
    if (!result.canceled) setTimeout(() => setExportResult(null), 8000)
  }

  const handleReprocess = async (record: HistoryRecord) => {
    if (!record.audioFilePath) return

    const bytes = await bridge.readAudioFileBytes(record.audioFilePath)
    // 录音已被保留期清掉或被手动删了。原来这里静默 return，按钮转一下就没下文。
    if (!bytes) throw new Error(t('record.audioMissing'))

    // WAV → PCM（去掉 44 字节文件头）
    const pcmData = bytes.slice(44)
    const chunk = pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength)

    // Diagnostic: compute peak amplitude of the PCM data being sent
    const pcmInt16 = new Int16Array(chunk)
    let reprocessPeak = 0
    for (let i = 0; i < pcmInt16.length; i++) {
      const v = Math.abs(pcmInt16[i])
      if (v > reprocessPeak) reprocessPeak = v
    }
    const reprocessPeakNorm = reprocessPeak / 32768
    const reprocessDurSec = pcmInt16.length / 16000
    console.log('[reprocess-diag] PCM stats', {
      byteLength: chunk.byteLength,
      samples: pcmInt16.length,
      durationSec: reprocessDurSec.toFixed(2),
      peakInt16: reprocessPeak,
      peakNormalized: reprocessPeakNorm.toFixed(4),
      wouldBeSilent: reprocessPeakNorm < 0.01,
    })

    const preset = await getActivePreset()
    const aiEnabled = await getSetting('aiEnabled', false)

    // 加载热词
    let hotwords: string[] = []
    try {
      const [rawSetWords, rawSetActive, rawCustomThemes, rawCustomThemeActive, rawSetExtraWords] = await Promise.all([
        getSetting(BUILTIN_SET_WORDS_KEY, {}),
        getSetting(BUILTIN_SET_ACTIVE_KEY, {}),
        getSetting(CUSTOM_THEMES_KEY, []),
        getSetting(CUSTOM_THEME_ACTIVE_KEY, {}),
        getSetting(BUILTIN_SET_EXTRA_WORDS_KEY, {}),
      ])
      const setWords = normalizeBuiltinSetWords(rawSetWords, rawSetExtraWords)
      const setActive = normalizeBuiltinSetActive(rawSetActive as Record<string, unknown>)
      const themes = normalizeCustomThemes(rawCustomThemes)
      const themeActive = normalizeCustomThemeActive(rawCustomThemeActive as Record<string, unknown>, themes)
      hotwords = composeHotwords([], setWords, setActive, themes, themeActive)
    } catch { /* ignore */ }

    const clientMeta = await bridge.getClientRuntimeInfo().catch(() => null)

    // 按用户当前选择的工作模式重新识别，与实时录音保持一致
    // （此前这里硬编码走服务器模式，导致云 API/本地模式下重新识别被错误地发回服务器）
    const workMode = getWorkMode()
    let systemPrompt = aiEnabled ? preset.systemPrompt : undefined
    // 与实时一致：开启"热词注入 AI 提示词"时，重新识别也把热词表注入系统提示词
    if (systemPrompt && (await getSetting('injectHotwordsToPrompt', false))) {
      const part = buildHotwordInjectionPart(hotwords)
      if (part) systemPrompt = `${systemPrompt}\n\n${part}`
    }

    // 一次重跑只建一份 AI 上下文，三条路径共用：策略同一个函数算，结果同一条 ai.outcome。
    const ai = await buildReprocessAiContext(record.id)

    let result: ReprocessResult
    if (workMode === 'cloud_api') {
      result = await reprocessViaCloudApi(chunk, hotwords, ai, systemPrompt)
    } else if (workMode === 'local') {
      result = await reprocessViaLocal(chunk, hotwords, ai, systemPrompt)
    } else {
      result = await reprocessViaServer(chunk, hotwords, ai, systemPrompt, clientMeta)
    }

    // 新链路优先采用显式执行状态；旧的云/本地历史重跑尚未返回状态时才兼容文本比较。
    const rawAsr = result.aiStatus
      ? result.aiStatus !== 'applied'
      : !result.llmText || result.llmText === result.asrText
    const baseText = rawAsr ? result.asrText : result.llmText
    const replacedLlm = await applyTextTransforms(baseText, { rawAsr })

    const meta = await buildReprocessMetadata(workMode, result)

    await updateHistoryRecord(record.id, {
      asrText: result.asrText,
      llmText: replacedLlm,
      asrMs: result.asrMs,
      llmMs: result.llmMs,
      charCount: (result.llmText || result.asrText).length,
      isEmpty: !(result.llmText || result.asrText).trim(),
      workMode,
      aiSource: meta.aiSource,
      aiStatus: meta.aiStatus,
      aiProvider: meta.aiProvider,
      aiModel: meta.aiModel,
      asrProvider: meta.asrProvider,
    })

    void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">{t('history.title')}</h1>
          {/* 选中底色是滑块（useSlidingIndicator），按钮自己不画；aria-pressed 同时给读屏和滑块定位用。 */}
          <div ref={filterGroupRef} className="relative flex gap-1 rounded-lg border border-border p-0.5">
            <span ref={filterIndicatorRef} aria-hidden className="sliding-indicator rounded-md bg-accent" />
            <button
              type="button"
              aria-pressed={!favoriteOnly}
              onClick={() => setFavoriteOnly(false)}
              className={cn(
                'relative rounded-md px-3 py-1 text-xs transition-colors',
                !favoriteOnly ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('history.filterAll')}</button>
            <button
              type="button"
              aria-pressed={favoriteOnly}
              onClick={() => setFavoriteOnly(true)}
              className={cn(
                'relative rounded-md px-3 py-1 text-xs transition-colors',
                favoriteOnly ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('history.filterFavorites')}</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
              className="w-64 rounded-md border border-input-border bg-input-bg py-1.5 pl-8 pr-3 text-sm"
            />
          </div>
          <Tooltip content={t('history.export')}>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              onClick={() => void handleExport()}
              aria-label={t('history.export')}
              title={t('history.export')}
            >
              <Download className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      </div>

      {exportResult && !exportResult.canceled && exportResult.filePath && (
        <div className="mb-3 flex items-center gap-2 text-xs text-success">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{t('history.savedTo', { path: exportResult.filePath })}</span>
          <button
            onClick={() => void invoke('reveal_file_in_folder', { filePath: exportResult.filePath })}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {exportResult?.canceled && (
        <p className="mb-3 text-xs text-muted-foreground">{t('history.exportCanceled')}</p>
      )}

      <HistoryRecordList
        records={records}
        onDelete={handleDelete}
        onToggleFavorite={handleToggleFavorite}
        onReprocess={handleReprocess}
        onEdit={handleEdit}
        onSaveAsrCorrection={handleSaveAsrCorrection}
        highlight={debouncedKeyword}
        emptyText={keyword.trim() ? t('history.emptyNoMatch') : favoriteOnly ? t('history.emptyFavorites') : t('history.empty')}
      />

      {totalCount > records.length && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setVisibleCount((count) => count + HISTORY_PAGE_SIZE)}>
            {t('history.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
