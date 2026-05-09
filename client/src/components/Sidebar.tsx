import { NavLink } from 'react-router-dom'
import { Home, Clock, BookOpen, Settings, Info, Wifi, WifiOff, AudioLines, Sparkles, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { getWorkMode } from '@/services/transcription'

const primaryNavItems = [
  { to: '/', icon: Home, label: '首页' },
  { to: '/history', icon: Clock, label: '历史' },
  { to: '/voice-engine', icon: AudioLines, label: '语音识别' },
  { to: '/ai-instructions', icon: Wand2, label: 'AI 指令' },
  { to: '/ai-service', icon: Sparkles, label: 'AI 服务' },
  { to: '/hotwords', icon: BookOpen, label: '热词' },
]

const footerNavItems = [
  { to: '/settings', icon: Settings, label: '设置' },
  { to: '/about', icon: Info, label: '关于' },
]

function NavItem({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: typeof Home
  label: string
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
          isActive ? 'bg-sidebar-item-active font-medium text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
        )
      }
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  )
}

function IconOnlyNavItem({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: typeof Home
  label: string
}) {
  return (
    <Tooltip content={label}>
      <NavLink
        to={to}
        className={({ isActive }) =>
          cn(
            'flex items-center justify-center rounded-lg p-2 transition-colors',
            isActive ? 'bg-sidebar-item-active text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
          )
        }
      >
        <Icon className="h-4 w-4" />
      </NavLink>
    </Tooltip>
  )
}

const statusConfig = {
  connected:    { icon: Wifi,    color: 'text-success', label: '后端已连接' },
  connecting:   { icon: Wifi,    color: 'text-warning animate-pulse', label: '正在连接…' },
  disconnected: { icon: WifiOff, color: 'text-muted-foreground', label: '后端未连接' },
  error:        { icon: WifiOff, color: 'text-destructive', label: '连接失败' },
} as const

function ConnectionIndicator() {
  const status = useConnectionStatus()
  const workMode = getWorkMode()

  // 非服务器模式不显示连接指示器
  if (workMode !== 'server') return null

  const { icon: StatusIcon, color, label } = statusConfig[status]
  return (
    <Tooltip content={label}>
      <div className="flex items-center justify-center rounded-lg p-2">
        <StatusIcon className={cn('h-4 w-4', color)} />
      </div>
    </Tooltip>
  )
}

export default function Sidebar() {
  return (
    <nav className="flex w-48 flex-col border-r border-sidebar-border bg-sidebar py-4">
      <div className="flex-1 space-y-1 px-3">
        {primaryNavItems.map(({ to, icon, label }) => (
          <NavItem key={to} to={to} icon={icon} label={label} />
        ))}
      </div>

      <div className="space-y-3 px-3 pt-4">
        <div className="h-px bg-[linear-gradient(to_right,transparent_0%,hsl(var(--sidebar-border))_5%,hsl(var(--sidebar-border))_95%,transparent_100%)]" />
        <div className="flex items-center gap-1">
          {footerNavItems.map(({ to, icon, label }) => (
            <IconOnlyNavItem key={to} to={to} icon={icon} label={label} />
          ))}
          <ConnectionIndicator />
        </div>
      </div>
    </nav>
  )
}
