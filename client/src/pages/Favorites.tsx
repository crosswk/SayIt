import { useCallback, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import HistoryRecordList from '@/components/history/HistoryRecordList'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { exportFavorites } from '@/services/exports'
import { countHistory, deleteHistory, listHistory, setHistoryFavorite, type HistoryRecord } from '@/services/store'

const FAVORITES_PAGE_SIZE = 100

export default function Favorites() {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [visibleCount, setVisibleCount] = useState(FAVORITES_PAGE_SIZE)
  const [totalCount, setTotalCount] = useState(0)
  const [exportMessage, setExportMessage] = useState('')

  const loadRecords = useCallback(async (limit: number) => {
    const [items, total] = await Promise.all([
      listHistory({ favoriteOnly: true, limit, offset: 0 }),
      countHistory({ favoriteOnly: true }),
    ])
    setRecords(items)
    setTotalCount(total)
  }, [])

  useEffect(() => {
    void loadRecords(visibleCount)
  }, [loadRecords, visibleCount])

  const handleDelete = async (id: string) => {
    await deleteHistory(id)
    void loadRecords(visibleCount)
  }

  const handleToggleFavorite = async (id: string, nextFavorite: boolean) => {
    await setHistoryFavorite(id, nextFavorite)
    if (nextFavorite) {
      setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, favorite: true } : r)))
      return
    }
    void loadRecords(visibleCount)
  }

  const handleExport = async () => {
    const result = await exportFavorites()
    setExportMessage(result.canceled ? '已取消导出。' : `已保存到 ${result.filePath}`)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">我的收藏</h1>
        <div className="flex flex-wrap gap-2">
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
      <p className="mb-3 text-sm text-muted-foreground">查看你标记为重要的语音记录。</p>
      {exportMessage && <p className="mb-4 text-sm text-muted-foreground">{exportMessage}</p>}

      <HistoryRecordList
        records={records}
        onDelete={handleDelete}
        onToggleFavorite={handleToggleFavorite}
        emptyText="还没有收藏记录，去历史记录里点一下星标吧。"
      />

      {totalCount > records.length && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setVisibleCount((count) => count + FAVORITES_PAGE_SIZE)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  )
}
