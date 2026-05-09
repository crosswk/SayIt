import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { cleanMicLabel } from './utils'

export type MicVolumeLevel = 'idle' | 'silent' | 'low' | 'normal'

const VOLUME_CONFIG: Record<MicVolumeLevel, { label: string; color: string; desc: string }> = {
  idle:   { label: '', color: '', desc: '' },
  silent: { label: '静音', color: 'text-destructive', desc: '未检测到声音，请检查麦克风是否被静音或被其他应用占用' },
  low:    { label: '声音偏小', color: 'text-amber-500', desc: '声音较小，建议靠近麦克风或调高系统麦克风音量' },
  normal: { label: '正常', color: 'text-emerald-500', desc: '麦克风工作正常' },
}

export default function MicrophoneSection({
  mics,
  selectedMic,
  testing,
  volumeLevel,
  errorMessage,
  onCanvasRef,
  onMicChange,
  onTestMic,
}: {
  mics: MediaDeviceInfo[]
  selectedMic: string
  testing: boolean
  volumeLevel: MicVolumeLevel
  errorMessage?: string
  onCanvasRef: (node: HTMLCanvasElement | null) => void
  onMicChange: (deviceId: string) => void
  onTestMic: () => void
}) {
  const micOptions = useMemo(() => {
    return [
      { value: '', label: '系统默认' },
      ...mics.map((mic) => ({
        value: mic.deviceId,
        label: cleanMicLabel(mic.label) || `麦克风 ${mic.deviceId.slice(0, 8)}`,
      })),
    ]
  }, [mics])

  const vol = VOLUME_CONFIG[volumeLevel]

  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">麦克风</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm text-foreground">选择麦克风</label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedMic}
                onChange={onMicChange}
                options={micOptions}
                className="sm:flex-1"
              />
              <Button variant="outline" size="sm" onClick={onTestMic} disabled={testing} className="h-9 shrink-0 px-4">
                {testing ? '测试中...' : '测试麦克风'}
              </Button>
            </div>
          </div>

          {testing && (
            <div className="space-y-2">
              <canvas
                ref={onCanvasRef}
                width={160}
                height={40}
                className="mx-auto rounded-md border border-border"
                style={{ width: '160px', height: '40px' }}
              />
              {volumeLevel !== 'idle' && (
                <div className="text-center">
                  <span className={`text-xs font-medium ${vol.color}`}>{vol.label}</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">{vol.desc}</p>
                </div>
              )}
            </div>
          )}

          {errorMessage && !testing && (
            <p className="text-xs text-destructive">{errorMessage}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
