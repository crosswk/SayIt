// 首页意见反馈卡片

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { getLastTranscript, submitFeedback } from '@/services/feedback'

export default function FeedbackSection() {
  const [lastTranscript, setLastTranscript] = useState<string>('')
  const [showTranscript, setShowTranscript] = useState(true)
  const [feedbackText, setFeedbackText] = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    getLastTranscript().then((record) => {
      if (record) {
        if (record.isEmpty) {
          setLastTranscript('无有效声音')
        } else {
          const display = record.llmText || record.asrText || ''
          setLastTranscript(display.slice(0, 200))
        }
      }
    })
  }, [])

  const handleSubmit = async () => {
    if (sending) return
    const trimmed = feedbackText.trim()
    if (trimmed.length < 2) {
      setMessage({ ok: false, text: '请输入至少 2 个字的反馈' })
      return
    }

    setSending(true)
    setMessage(null)
    try {
      const result = await submitFeedback(trimmed, { includeTranscript: showTranscript && !!lastTranscript })
      setMessage({ ok: result.ok, text: result.message })
      if (result.ok) {
        setFeedbackText('')
        setTimeout(() => setMessage(null), 4000)
      }
    } catch (err) {
      setMessage({ ok: false, text: '网络错误，请稍后重试' })
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">意见反馈</h2>

      <div className="rounded-xl border border-border p-4">
        {/* 转录引用块 — 可删除 */}
        {showTranscript && lastTranscript && (
          <div className="relative mb-3">
            <div className="rounded-lg bg-muted/70 px-3 py-2 pr-8">
              <p className="text-sm text-muted-foreground">最后的转录</p>
              <p className="mt-1 truncate border-l-2 border-muted-foreground/30 pl-2 text-sm text-muted-foreground/70">{lastTranscript}</p>
            </div>
            <button
              onClick={() => setShowTranscript(false)}
              className="absolute right-2 top-2 rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              aria-label="移除转录"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* 反馈输入 */}
        <textarea
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="如何改进 SayIt？输入你的反馈建议..."
          rows={1}
          maxLength={1000}
          className="w-full resize-none border-0 bg-transparent p-0 text-sm outline-none placeholder:text-muted-foreground/50"
          style={{ fieldSizing: 'content' as never, minHeight: '1.5rem', maxHeight: '6rem' }}
        />

        {/* 底部 */}
        <div className="mt-3 flex items-center justify-between">
          <div className="min-h-[1.25rem]">
            {message && (
              <p className={`text-xs ${message.ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
                {message.text}
              </p>
            )}
          </div>
          <button
            onClick={handleSubmit}
            disabled={sending || feedbackText.trim().length < 2}
            className="rounded-full bg-secondary px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground hover:text-background disabled:opacity-40"
          >
            {sending ? '发送中...' : '发送反馈'}
          </button>
        </div>
      </div>
    </div>
  )
}
