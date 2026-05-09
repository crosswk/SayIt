import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import * as bridge from '@/services/bridge'

interface CopyButtonProps {
  text: string
  className?: string
}

export default function CopyButton({ text, className = '' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await bridge.copyText(text)
    } catch {
      // fallback
      await navigator.clipboard.writeText(text)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Tooltip content={copied ? '已复制' : '复制文本'}>
      <button
        onClick={handleCopy}
        className={`inline-flex items-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${className}`}
        aria-label="复制"
      >
        {copied ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </Tooltip>
  )
}