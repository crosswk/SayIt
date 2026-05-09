import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { type OverlayWaveTheme } from './utils'

const OVERLAY_OPTIONS: Array<{
  theme: OverlayWaveTheme
  label: string
  previewClassName: string
}> = [
  { theme: 'black-white', label: '黑底白色', previewClassName: 'bg-slate-100' },
  { theme: 'black-blue', label: '黑底蓝色', previewClassName: 'bg-gradient-to-r from-cyan-400 to-blue-500' },
  { theme: 'black-rainbow', label: '黑底彩色', previewClassName: 'bg-gradient-to-r from-green-400 via-yellow-300 to-orange-400' },
]

export default function OverlaySection({
  overlayWaveTheme,
  overlayShowDuration,
  readySoundEnabled,
  onOverlayThemeChange,
  onToggleOverlayDuration,
  onToggleReadySound,
}: {
  overlayWaveTheme: OverlayWaveTheme
  overlayShowDuration: boolean
  readySoundEnabled: boolean
  onOverlayThemeChange: (theme: OverlayWaveTheme) => void
  onToggleOverlayDuration: () => void
  onToggleReadySound: () => void
}) {
  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">按住说话主题样式</h2>
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm">波形主题</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {OVERLAY_OPTIONS.map((option) => (
                <button
                  key={option.theme}
                  type="button"
                  onClick={() => onOverlayThemeChange(option.theme)}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors ${
                    overlayWaveTheme === option.theme
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-accent'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${overlayWaveTheme === option.theme ? 'border-primary' : 'border-muted-foreground/40'}`}>
                      {overlayWaveTheme === option.theme && <span className="h-2 w-2 rounded-full bg-primary" />}
                    </span>
                    <span>{option.label}</span>
                  </span>
                  <span className={`h-1.5 w-8 rounded-full ${option.previewClassName}`} />
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">显示按住时长</p>
              <p className="text-xs text-muted-foreground">关闭后仅显示波形</p>
            </div>
            <Switch checked={overlayShowDuration} onChange={onToggleOverlayDuration} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">准备就绪提示音</p>
              <p className="text-xs text-muted-foreground">录音准备好时播放一声短促提示音</p>
            </div>
            <Switch checked={readySoundEnabled} onChange={onToggleReadySound} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
