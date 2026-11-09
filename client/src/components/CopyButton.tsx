import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { SuccessCheck } from '@/components/ui/success-check'
import * as bridge from '@/services/bridge'
import { useT } from '@/i18n/useT'

interface CopyButtonProps {
  text: string
  className?: string
}

export default function CopyButton({ text, className = '' }: CopyButtonProps) {
  const t = useT()
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
    <Tooltip content={copied ? t('record.copied') : t('record.copyText')}>
      <button
        onClick={handleCopy}
        className={`inline-flex items-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${className}`}
        aria-label={t('record.copy')}
      >
        {copied ? (
          <SuccessCheck className="h-4 w-4 text-success" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </Tooltip>
  )
}