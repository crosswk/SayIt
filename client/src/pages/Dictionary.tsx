import { useState } from 'react'
import { Plus, X, Search, RotateCcw, ChevronDown, ChevronUp, FolderPlus, Trash2, Download, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { exportHotwords } from '@/services/exports'
import { BUILTIN_SETS, MAX_HOTWORDS } from '@/services/hotwords/model'
import { useHotwordsManager } from '@/services/hotwords/useHotwordsManager'
import TextReplacementSection from '@/components/TextReplacementSection'
import TextFormatSection from '@/components/TextFormatSection'

type Tab = 'hotwords' | 'replacement'

/** 超过该数量的热词总数时，给出"过多可能反而降低准确率"的软提示 */
const HOTWORD_SOFT_LIMIT = 200
/** 单个分类内词条超过该数量时折叠，只显示前 N 个 + 展开按钮，避免一大片平铺 */
const CHIPS_COLLAPSE_LIMIT = 30

/** 词条标签列表：数量多时折叠（搜索中不折叠，避免藏起匹配项）。 */
function WordChips({
  words,
  onRemove,
  expandAll = false,
}: {
  words: string[]
  onRemove: (word: string) => void
  expandAll?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const overflow = words.length > CHIPS_COLLAPSE_LIMIT
  const shown = expanded || expandAll || !overflow ? words : words.slice(0, CHIPS_COLLAPSE_LIMIT)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((word) => (
          <span
            key={word}
            className="inline-flex items-center gap-1 rounded-md border bg-secondary/50 px-2 py-0.5 text-xs"
          >
            {word}
            <button
              onClick={() => onRemove(word)}
              className="rounded-full p-0.5 transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label={`删除 ${word}`}
            >
              <X className="h-2.5 w-2.5 text-muted-foreground" />
            </button>
          </span>
        ))}
      </div>
      {overflow && !expandAll && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? '收起' : `展开全部（共 ${words.length} 个）`}
        </button>
      )}
    </div>
  )
}

export default function Dictionary() {
  const [tab, setTab] = useState<Tab>('hotwords')
  const [exportMessage, setExportMessage] = useState('')
  const [warnDismissed, setWarnDismissed] = useState(false)
  const {
    hotwords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    themeInputs,
    newThemeName,
    search,
    loading,
    showUnknown,
    filtered,
    filteredUnknown,
    visibleCustomThemes,
    getSetWordsInHotwords,
    getThemeWordsInHotwords,
    setNewThemeName,
    setSearch,
    setShowUnknown,
    setThemeInput,
    addTheme,
    addWordsToTheme,
    removeTheme,
    toggleCustomTheme,
    removeWord,
    toggleBuiltinSet,
    resetBuiltinSet,
  } = useHotwordsManager()

  const handleExport = async () => {
    const result = await exportHotwords()
    setExportMessage(result.canceled ? '已取消导出。' : `已保存到 ${result.filePath}`)
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* 标题栏 + Tab */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">热词</h1>
          <div className="flex gap-1 rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setTab('hotwords')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === 'hotwords' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >热词</button>
            <button
              type="button"
              onClick={() => setTab('replacement')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === 'replacement' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >文本处理</button>
          </div>
        </div>

        {/* 热词 Tab 的搜索和导出 */}
        {tab === 'hotwords' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {hotwords.length} / {MAX_HOTWORDS}
            </span>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索热词"
                className="w-52 rounded-md border border-input-border bg-input-bg py-1.5 pl-8 pr-3 text-sm"
              />
            </div>
            <Tooltip content="导出数据">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                onClick={() => void handleExport()}
                aria-label="导出数据"
              >
                <Download className="h-4 w-4" />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>

      {exportMessage && tab === 'hotwords' && (
        <p className="mb-2 text-sm text-muted-foreground">{exportMessage}</p>
      )}

      {/* ===== 文本处理 Tab ===== */}
      {tab === 'replacement' && (
        <>
          <TextFormatSection />
          <TextReplacementSection />
        </>
      )}

      {/* ===== 热词 Tab ===== */}
      {tab === 'hotwords' && (
        <>
          <p className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
            <span>热词可提升语音识别对专有名词和行业术语的准确率。</span>
            <Tooltip
              variant="light"
              content={
                <div className="text-left">
                  <p className="mb-1.5 font-medium">各模型对热词的支持</p>
                  <table className="border-collapse text-xs [&_td]:py-0.5 [&_td]:pr-3 [&_td]:align-top [&_th]:pb-1 [&_th]:pr-3 [&_th]:text-left [&_th]:font-normal [&_th]:text-muted-foreground/70">
                    <thead>
                      <tr><th>模型</th><th>热词</th><th>说明</th></tr>
                    </thead>
                    <tbody>
                      <tr><td>豆包 Seed-ASR 2.0</td><td>支持</td><td>关实时字幕最准；开启时约仅前 100 token 生效</td></tr>
                      <tr><td>千问 flash-realtime（实时）</td><td>支持</td><td>效果较好，约 10000 tokens</td></tr>
                      <tr><td>千问 flash（非实时）</td><td>支持</td><td>效果一般</td></tr>
                      <tr><td>本地 Qwen3-ASR</td><td>支持</td><td>变动会重建模型，过多变慢</td></tr>
                      <tr><td>本地 SenseVoice</td><td>不支持</td><td>—</td></tr>
                      <tr><td>服务器模式</td><td>支持</td><td>效果较好</td></tr>
                    </tbody>
                  </table>
                  <p className="mt-2 max-w-[340px] leading-relaxed">
                    热词只提高<span className="font-semibold">命中概率</span>，不保证 100% 准确；且<span className="font-semibold">并非越多越好</span>——过多反而会稀释效果。
                  </p>
                </div>
              }
            >
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
            </Tooltip>
          </p>

          {hotwords.length > HOTWORD_SOFT_LIMIT && !warnDismissed && (
            <div className="mb-4 -mt-2 flex items-start gap-2 text-xs text-amber-500">
              <p>
                当前已有 <span className="font-semibold">{hotwords.length}</span> 个热词，<span className="font-semibold">热词并非越多越好</span>，建议精选常用术语。
              </p>
              <button
                type="button"
                onClick={() => setWarnDismissed(true)}
                className="shrink-0 rounded p-0.5 text-amber-500/70 transition-colors hover:bg-amber-500/10 hover:text-amber-500"
                aria-label="关闭提示"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* 新建热词分类 */}
          <div className="mb-4 flex items-center gap-2">
            <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={newThemeName}
              onChange={(e) => setNewThemeName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void addTheme()
                }
              }}
              placeholder="新建分类，例如：项目A / 医疗术语 / 会议术语"
              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
            />
            <Button
              onClick={() => void addTheme()}
              size="sm"
              variant="outline"
              disabled={!newThemeName.trim()}
              className="shrink-0 gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              添加
            </Button>
          </div>

          {loading ? (
            <p className="py-8 text-center text-muted-foreground">加载中...</p>
          ) : (
            <div className="space-y-4">
              {/* 自定义分类 */}
              {visibleCustomThemes.map((theme) => {
                const active = !!customThemeActive[theme.id]
                const activeWords = getThemeWordsInHotwords(theme)
                const totalWords = theme.words.length

                return (
                  <Card key={theme.id} className={cn(!active && 'border-dashed opacity-70')}>
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Switch
                            checked={active}
                            onChange={() => void toggleCustomTheme(theme.id)}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{theme.name}</p>
                            <p className="text-xs text-muted-foreground">
                              自定义 · {activeWords.length} / {totalWords} 词
                            </p>
                          </div>
                        </div>
                        <Tooltip content="删除分类">
                          <button
                            type="button"
                            onClick={() => void removeTheme(theme.id)}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`删除主题 ${theme.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </div>

                      {active && (
                        <div className="space-y-3">
                          <div className="flex gap-2">
                            <input
                              value={themeInputs[theme.id] || ''}
                              onChange={(e) => setThemeInput(theme.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault()
                                  void addWordsToTheme(theme.id)
                                }
                              }}
                              placeholder={`添加热词（逗号、换行分隔）`}
                              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                            />
                            <Button
                              onClick={() => void addWordsToTheme(theme.id)}
                              size="sm"
                              variant="outline"
                              disabled={!(themeInputs[theme.id] || '').trim()}
                              className="shrink-0 gap-1.5"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              添加
                            </Button>
                          </div>

                          {activeWords.length > 0 && (
                            <WordChips words={activeWords} onRemove={removeWord} expandAll={!!search} />
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}

              {/* 内置分类 */}
              {Object.entries(BUILTIN_SETS).map(([key, setDef]) => {
                const active = !!builtinSetActive[key]
                const activeWords = getSetWordsInHotwords(key)
                const totalWords = (builtinSetWords[key] || []).length

                if (search && activeWords.length === 0 && !setDef.label.toLowerCase().includes(search.toLowerCase())) {
                  return null
                }

                return (
                  <Card key={key} className={cn(!active && 'border-dashed opacity-70')}>
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Switch
                            checked={active}
                            onChange={() => void toggleBuiltinSet(key)}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{setDef.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {setDef.description} · {activeWords.length} / {totalWords} 词
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 text-xs"
                          onClick={() => void resetBuiltinSet(key)}
                        >
                          <RotateCcw className="h-3 w-3" /> 重置
                        </Button>
                      </div>

                      {active && activeWords.length > 0 && (
                        <WordChips words={activeWords} onRemove={removeWord} expandAll={!!search} />
                      )}
                    </CardContent>
                  </Card>
                )
              })}

              {/* 历史未分类词汇 */}
              {filteredUnknown.length > 0 && (
                <Card>
                  <CardContent className="p-4">
                    <button
                      className="mb-2 flex w-full items-center justify-between text-left"
                      onClick={() => setShowUnknown(!showUnknown)}
                    >
                      <div>
                        <p className="text-sm font-medium">历史未分类词汇</p>
                        <p className="text-xs text-muted-foreground">
                          这些词来自历史数据，不计入内置/自定义热词分类。
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{filteredUnknown.length}</span>
                        {showUnknown ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </button>

                    {showUnknown && (
                      <WordChips words={filteredUnknown} onRemove={removeWord} expandAll={!!search} />
                    )}
                  </CardContent>
                </Card>
              )}

              {!search && hotwords.length === 0 && (
                <div className="rounded-lg border border-dashed border-border py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    还没有热词，先新建热词分类或点击内置分类激活。
                  </p>
                </div>
              )}

              {search && filtered.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">没有匹配的热词。</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
