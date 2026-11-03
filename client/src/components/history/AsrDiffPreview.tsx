import { useMemo } from 'react'
import { computeAsrDiff, countAsrDiffChanges, hasAsrDiffChange } from '@/lib/asrDiff'
import { t } from '@/i18n'

/**
 * 原始识别文本 → 修正后文本的改动预览。
 *
 * 用 <del>/<ins> 而不是两个 <span>：读屏会念出"删除/插入"，色盲用户也能靠删除线区分。
 * 只靠浅红/浅绿两种底色的话，这两类用户看到的是一段没有任何标记的普通文本。
 *
 * 不在 textarea 里做高亮 —— textarea 内部无法放富文本，只能"可编辑框 + 只读预览"两块。
 */
export function AsrDiffPreview({
  original,
  corrected,
  className = '',
}: {
  original: string
  corrected: string
  className?: string
}) {
  const segments = useMemo(() => computeAsrDiff(original, corrected), [original, corrected])
  const changed = hasAsrDiffChange(segments)
  const changeCount = countAsrDiffChanges(segments)

  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium">{t('asrCorrection.diffLabel')}</span>
        <span>{changed ? t('asrCorrection.diffCount', { count: changeCount }) : t('asrCorrection.diffNone')}</span>
      </div>
      {/* mac-selectable：mac 上界面文字默认不可选，对比预览要能选中拷贝（index.css） */}
      <div
        className="mac-selectable max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-2.5 py-2 text-sm leading-relaxed"
        aria-live="polite"
      >
        {segments.length === 0 ? (
          <span className="italic text-muted-foreground">{t('asrCorrection.diffEmpty')}</span>
        ) : (
          segments.map((segment, index) => {
            if (segment.kind === 'delete') {
              return (
                <del
                  key={index}
                  className="rounded-sm bg-red-100 px-0.5 text-red-900 decoration-red-500/70 dark:bg-red-500/25 dark:text-red-200"
                >
                  {segment.text}
                </del>
              )
            }
            if (segment.kind === 'insert') {
              return (
                <ins
                  key={index}
                  className="rounded-sm bg-emerald-100 px-0.5 text-emerald-900 no-underline dark:bg-emerald-500/25 dark:text-emerald-200"
                >
                  {segment.text}
                </ins>
              )
            }
            return <span key={index}>{segment.text}</span>
          })
        )}
      </div>
    </div>
  )
}
