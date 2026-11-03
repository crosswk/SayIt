import { useEffect, useState } from 'react'
import * as bridge from '@/services/bridge'
import { Minus, Square, X, Wand2 } from 'lucide-react'
import appIcon from '@/assets/ico-frame-48x48.png'
import { useAiEnabled, useAiEnabledReady } from '@/hooks/useAiEnabled'
import { useActivePreset } from '@/hooks/useActivePreset'
import { toggleAiEnabled } from '@/stores/aiEnabled'
import { Tooltip } from '@/components/ui/tooltip'
import { useT } from '@/i18n/useT'
import { recordedPromptPresetDisplayName } from '@/i18n/displayNames'
import { IS_MAC } from '@/lib/platform'

/**
 * 主窗口标题栏。
 *
 * Windows：无系统边框，自绘最小化/最大化/关闭，拖拽靠 WebView2 认的 `-webkit-app-region`。
 * macOS：保留系统红绿灯（tauri.macos.conf.json 里 titleBarStyle=Overlay），左侧给它们留位，
 * 不画自己的窗口按钮；WKWebView 不认 `-webkit-app-region`，拖拽改用 Tauri 的
 * `data-tauri-drag-region`（只对带这个属性的元素本身生效，按钮照常可点）。
 */
export default function TitleBar() {
  const t = useT()
  const aiEnabled = useAiEnabled()
  // 冷启动时 AI 初始值异步读回：就绪前开关先隐藏、不放动画，避免自己从关跳到开
  const ready = useAiEnabledReady()
  // 同 AppearancePage：显示与「允许过渡」必须错开一帧，否则揭开那一刻会把
  // 开关从默认(关)到已保存(开)真的滑动一遍。
  const [animate, setAnimate] = useState(false)
  useEffect(() => {
    if (!ready || animate) return
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)))
    return () => cancelAnimationFrame(id)
  }, [ready, animate])
  const activePreset = useActivePreset()
  const presetName = activePreset.name
    ? recordedPromptPresetDisplayName(activePreset.id, activePreset.name)
    : t('titleBar.defaultPreset')

  const dragRegion = IS_MAC ? { 'data-tauri-drag-region': true } : {}
  const dragStyle = IS_MAC ? undefined : ({ WebkitAppRegion: 'drag' } as React.CSSProperties)
  const noDragStyle = IS_MAC ? undefined : ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties)

  return (
    <div className={IS_MAC
      ? 'flex h-10 items-center justify-end bg-titlebar border-b select-none'
      : 'flex h-10 items-center justify-between bg-titlebar border-b select-none'}
      style={dragStyle} {...dragRegion}>
      {/* mac：左边归系统红绿灯，图标和名字放在侧栏最上面（见 Sidebar），标题栏只留 AI 整理开关 */}
      {!IS_MAC && (
        <div className="flex items-center gap-2.5 pl-3">
          <img src={appIcon} alt="SayIt" className="h-7 w-7" draggable={false} />
          <span className="text-sm text-foreground" style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800, letterSpacing: '0.01em' }}>SayIt</span>
        </div>
      )}
      <div className="flex items-center" {...dragRegion}>
        {/* mac：右边留出和左侧红绿灯一样的 16px 边距，别贴着窗口圆角 */}
        <div className={IS_MAC ? 'flex items-center pr-4' : 'flex items-center pr-2'} style={noDragStyle}>
          <Tooltip content={t('titleBar.presetTooltip', { name: presetName })}>
            <button
              type="button"
              role="switch"
              aria-checked={aiEnabled}
              onClick={() => { void toggleAiEnabled() }}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-accent"
              aria-label={t('titleBar.aiCleanupToggle')}
            >
              <Wand2 className={aiEnabled ? 'h-3.5 w-3.5 text-primary' : 'h-3.5 w-3.5 text-muted-foreground'} />
              <span className={aiEnabled ? 'text-xs text-foreground' : 'text-xs text-muted-foreground'}>{t('titleBar.aiCleanup')}</span>
              <span className={`relative h-4 w-7 shrink-0 rounded-full ${animate ? 'transition-colors' : ''} ${aiEnabled ? 'bg-primary' : 'bg-muted'}`} style={ready ? undefined : { visibility: 'hidden' }}>
                <span className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-card shadow ${animate ? 'transition-transform' : ''} ${aiEnabled ? 'translate-x-3' : ''}`} />
              </span>
            </button>
          </Tooltip>
        </div>
        {!IS_MAC && (
          <div className="flex" style={noDragStyle}>
            <button onClick={() => bridge.minimize()}
              className="flex h-10 w-11 items-center justify-center hover:bg-accent"
              aria-label={t('window.minimize')}>
              <Minus className="h-4 w-4" />
            </button>
            <button onClick={() => bridge.maximize()}
              className="flex h-10 w-11 items-center justify-center hover:bg-accent"
              aria-label={t('window.maximize')}>
              <Square className="h-3 w-3" />
            </button>
            <button onClick={() => bridge.close()}
              className="flex h-10 w-11 items-center justify-center hover:bg-titlebar-close-hover hover:text-titlebar-close-hover-text"
              aria-label={t('window.close')}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
