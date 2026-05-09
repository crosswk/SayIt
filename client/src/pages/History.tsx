import * as bridge from '@/services/bridge'
import { cn } from '@/lib/utils'
import { resolveAsrDisplayModel } from '@/lib/asrModels'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, Search, Check, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
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
import { loadAudioAsDataUrl } from '@/services/audioFileService'
import { segmentAsrText } from '@/services/textSegmenter'
import { applyTextReplacements } from '@/services/textReplacement'
import { getProvider } from '@/services/transcription'
import { reconnectProvider } from '@/services/recorder'

const HISTORY_PAGE_SIZE = 100

export default function History() {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
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

  const handleExport = async () => {
    const result = await exportHistory({ keyword: debouncedKeyword })
    setExportResult(result)
    if (!result.canceled) setTimeout(() => setExportResult(null), 8000)
  }

  const handleReprocess = async (record: HistoryRecord) => {
    if (!record.audioFilePath) return

    const base64 = await bridge.readAudioFile(record.audioFilePath)
    if (!base64) return

    // Decode base64 WAV → PCM
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    const pcmData = bytes.slice(44)
    const chunk = pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength)

    const preset = await getActivePreset()
    const aiEnabled = await getSetting('aiEnabled', false)

    // 使用当前 Provider 重新识别
    const provider = getProvider()
    let reprocessDone = false
    const result = await new Promise<{ asrText: string; llmText: string; asrMs: number; llmMs: number; durationSec: number; asrEngine?: string; asrModel?: string }>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!reprocessDone) { reprocessDone = true; provider.disconnect() }
        reconnectProvider()
        reject(new Error('重新识别超时'))
      }, 60000)

      void provider.connect({
        onFinal: (r) => {
          clearTimeout(timeout)
          reprocessDone = true
          provider.disconnect()
          reconnectProvider()
          resolve(r)
        },
        onError: (msg) => {
          clearTimeout(timeout)
          if (!reprocessDone) { reprocessDone = true; provider.disconnect() }
          reconnectProvider()
          reject(new Error(msg))
        },
        onDone: () => {
          // 如果没有 final 就 done 了，说明没有结果
        },
      }).then(async () => {
        const clientMeta = await bridge.getClientRuntimeInfo().catch(() => null)
        provider.start({
          systemPrompt: aiEnabled ? preset.systemPrompt : undefined,
          disableAi: !aiEnabled,
          clientMeta,
          source: 'history_reprocess',
        })
        provider.sendAudio(chunk)
        provider.stop()
      }).catch((err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    // 极速模式下 llmText === asrText（后端未经 LLM 处理时直接复制 asrText）
    // 此时对 asrText 做智能分段提升可读性
    const needsSegment = !result.llmText || result.llmText === result.asrText
    const finalLlm = needsSegment ? segmentAsrText(result.asrText) : result.llmText
    const replacedLlm = await applyTextReplacements(finalLlm)

    await updateHistoryRecord(record.id, {
      asrText: result.asrText,
      llmText: replacedLlm,
      asrMs: result.asrMs,
      llmMs: result.llmMs,
      charCount: (result.llmText || result.asrText).length,
      isEmpty: !(result.llmText || result.asrText).trim(),
      workMode: provider.mode,
      aiProvider: provider.mode === 'server' ? 'server' : undefined,
      aiModel: provider.mode === 'server' ? undefined : undefined,
      asrProvider: provider.mode === 'local'
        ? String(await getSetting('localAsr.modelId', 'sensevoice-small'))
        : provider.mode === 'cloud_api'
          ? resolveAsrDisplayModel(String(await getSetting('cloudAsr.provider', '')))
          : (result.asrModel || result.asrEngine || 'server').replace(/^.*\//, ''),
    })

    void loadRecords(debouncedKeyword, visibleCount, favoriteOnly)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">历史记录</h1>
          <div className="flex gap-1 rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setFavoriteOnly(false)}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                !favoriteOnly ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >全部</button>
            <button
              type="button"
              onClick={() => setFavoriteOnly(true)}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                favoriteOnly ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >收藏</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索历史关键词"
              className="w-64 rounded-md border border-input-border bg-input-bg py-1.5 pl-8 pr-3 text-sm"
            />
          </div>
          <Tooltip content="导出数据">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              onClick={() => void handleExport()}
              aria-label="导出数据"
              title="导出数据"
            >
              <Download className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      </div>

      {exportResult && !exportResult.canceled && exportResult.filePath && (
        <div className="mb-3 flex items-center gap-2 text-xs text-success">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">已保存到 {exportResult.filePath}</span>
          <button
            onClick={() => void invoke('reveal_file_in_folder', { filePath: exportResult.filePath })}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {exportResult?.canceled && (
        <p className="mb-3 text-xs text-muted-foreground">已取消导出。</p>
      )}

      <HistoryRecordList
        records={records}
        onDelete={handleDelete}
        onToggleFavorite={handleToggleFavorite}
        onReprocess={handleReprocess}
        emptyText={keyword.trim() ? '没有匹配的历史记录' : favoriteOnly ? '还没有收藏记录，去历史记录里点一下星标吧。' : '还没有记录，去语音工作台试试吧'}
      />

      {totalCount > records.length && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setVisibleCount((count) => count + HISTORY_PAGE_SIZE)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  )
}
