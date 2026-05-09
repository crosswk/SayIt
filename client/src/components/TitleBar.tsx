import * as bridge from '@/services/bridge'
import { Minus, Square, X } from 'lucide-react'
import appIcon from '@/assets/ico-frame-48x48.png'

export default function TitleBar() {
  return (
    <div className="flex h-10 items-center justify-between bg-titlebar border-b select-none"
         style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div className="flex items-center gap-2.5 pl-3">
        <img src={appIcon} alt="SayIt" className="h-7 w-7" draggable={false} />
        <span className="text-sm text-foreground" style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800, letterSpacing: '0.01em' }}>SayIt</span>
      </div>
      <div className="flex" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button onClick={() => bridge.minimize()}
                className="flex h-10 w-11 items-center justify-center hover:bg-accent"
                aria-label="最小化">
          <Minus className="h-4 w-4" />
        </button>
        <button onClick={() => bridge.maximize()}
                className="flex h-10 w-11 items-center justify-center hover:bg-accent"
                aria-label="最大化">
          <Square className="h-3 w-3" />
        </button>
        <button onClick={() => bridge.close()}
                className="flex h-10 w-11 items-center justify-center hover:bg-titlebar-close-hover hover:text-titlebar-close-hover-text"
                aria-label="关闭">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
