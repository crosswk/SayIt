import { useEffect, useRef, useSyncExternalStore } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useSlidingIndicator } from '@/components/ui/useSlidingIndicator'
import { Home, Clock, BookOpen, Settings, Info, Wifi, WifiOff, Cpu, Cloud, AudioLines, Sparkles, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { getModeStatus, refreshModeStatus, subscribeModeStatus } from '@/stores/modeStatus'
import { hasPendingUpdate } from '@/features/update/autoUpdate'
import { useUpdateState } from '@/features/update/useUpdateState'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { IS_MAC } from '@/lib/platform'
// mac 侧栏顶部的品牌图标：从 src-tauri/icons/icon.png（256px）按精确尺寸高质量缩出来的 1 倍 / 2 倍图。
// 让浏览器把大图现场缩到 28px 会发虚，图标里那行 SayIt 就看不清了。
import macIcon from '@/assets/app-icon-28.png'
import macIcon2x from '@/assets/app-icon-28@2x.png'

// 导航项存 key 而不是文案：切语言时这些常量不会重新求值（模块级只算一次），
// 存成中文串就会永远停在启动时那个语言。
const dailyNavItems = [
  { to: '/', icon: Home, labelKey: 'nav.home' },
  { to: '/history', icon: Clock, labelKey: 'nav.history' },
] as const satisfies readonly NavItemDef[]

const configNavItems = [
  { to: '/voice-engine', icon: AudioLines, labelKey: 'nav.voiceEngine' },
  { to: '/hotwords', icon: BookOpen, labelKey: 'nav.hotwords' },
  { to: '/ai-instructions', icon: Wand2, labelKey: 'nav.aiInstructions' },
  { to: '/ai-service', icon: Sparkles, labelKey: 'nav.aiService' },
] as const satisfies readonly NavItemDef[]

const footerNavItems = [
  { to: '/settings', icon: Settings, labelKey: 'nav.settings' },
  { to: '/about', icon: Info, labelKey: 'nav.about' },
] as const satisfies readonly NavItemDef[]

interface NavItemDef {
  to: string
  icon: typeof Home
  labelKey: TranslationKey
}

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
          // 选中底色由组里的滑块画（见 Sidebar 里的 useSlidingIndicator），这里只管文字。
          // relative z-[1]：滑块是组里最后一个子元素（space-y 的缘故），不抬一层会盖住文字。
          'relative z-[1] flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
          isActive ? 'font-medium text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
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
  iconClassName,
}: {
  to: string
  icon: typeof Home
  label: string
  /** 覆盖图标自身的颜色/动效（如「有更新」时的绿色闪烁） */
  iconClassName?: string
}) {
  return (
    <Tooltip content={label}>
      <NavLink
        to={to}
        // 这里只有图标、没有文字，不给 aria-label 的话读屏用户听到的是空按钮
        aria-label={label}
        className={({ isActive }) =>
          cn(
            'relative z-[1] flex items-center justify-center rounded-lg p-2 transition-colors',
            isActive ? 'text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
          )
        }
      >
        <Icon className={cn('h-4 w-4', iconClassName)} aria-hidden />
      </NavLink>
    </Tooltip>
  )
}

/**
 * 侧栏底部那排图标。
 *
 * 有更新待安装时**不新增图标** —— 让「关于」这一枚自己变绿闪烁，悬停提示换成
 * 「新版本已下载好」。关于页就是更新所在的地方，点它正好到达能看到版本说明和
 * 「立即安装」的位置；多一枚图标既挤又需要用户先学会它是什么意思。
 *
 * 后台下载期间**故意毫无变化**：那会儿没有任何需要用户知道的事，静默才是本意。
 *
 * ⚠ 这里用绿色不违反下面 ModeIndicator 那条"不给任何好颜色"的规矩：那条针对的是
 * 我们没验证过的事（配置填完了 ≠ 真能用）。而"包已下载完、哈希校验过、随时可装"
 * 是确定的事实。别顺手把它改回中性色。
 */
function FooterIcons() {
  const t = useT()
  const update = useUpdateState()
  const updateReady = hasPendingUpdate(update)
  const nextVersion = update.pending?.version || ''
  const { pathname } = useLocation()
  const groupRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useSlidingIndicator(groupRef, pathname, { activeSelector: '[aria-current="page"]' })

  return (
    <div ref={groupRef} className="relative flex items-center gap-1">
      <span ref={indicatorRef} aria-hidden className="sliding-indicator rounded-lg bg-sidebar-item-active" />
      {footerNavItems.map(({ to, icon, labelKey }) => {
        const highlight = updateReady && to === '/about'
        return (
          <IconOnlyNavItem
            key={to}
            to={to}
            icon={icon}
            label={highlight ? t('update.aboutTooltip', { version: nextVersion }) : t(labelKey)}
            iconClassName={highlight ? 'text-success animate-pulse' : undefined}
          />
        )
      })}
      <ModeIndicator />
    </div>
  )
}

/**
 * 服务器模式的连接状态。
 *
 * 只有这一个模式配得上"状态指示"：它有一条真在跑的连接（30s 心跳），所以图标能诚实地
 * 报出此刻通不通——信号图标 + 颜色，断线换成带斜杠的那只。
 * 本地/云 API 没有这种持续探测，见 ModeIndicator 的注释。
 */
const statusConfig = {
  connected: { icon: Wifi, color: 'text-success', labelKey: 'connection.connected' },
  connecting: { icon: Wifi, color: 'text-warning animate-pulse', labelKey: 'connection.connecting' },
  disconnected: { icon: WifiOff, color: 'text-muted-foreground', labelKey: 'connection.disconnected' },
  error: { icon: WifiOff, color: 'text-destructive', labelKey: 'connection.error' },
} as const satisfies Record<string, { icon: typeof Wifi; color: string; labelKey: TranslationKey }>

/**
 * 左下角的引擎指示：始终只占一个图标位，细节全在悬停提示里。
 *
 * 这里和「语音引擎」页那三张模式卡**不是同一件事**，所以图标也不必事事对齐：
 * 卡片上的图标是在给模式起名（Cpu / Cloud / Server，一个静态属性）；
 * 这里报的是"此刻怎么样"。于是只有服务器模式换成信号图标——它有一条真在跑的连接可报。
 *
 * 本地 / 云 API 一律是中性单色，**不给任何"好"的颜色**：我们唯一知道的事实是
 * "配置填完了没有"，而填完 ≠ 真的能用（模型能不能加载、密钥有没有被吊销，都没验过）。
 * 所以只有确定的坏消息（缺东西）才转 warning 色，其余保持沉默——
 * 曾经在这里点过绿灯，等于替一件没测过的事作保。
 */
function ModeIndicator() {
  const t = useT()
  const status = useConnectionStatus()
  const { mode, detail, ready, blockedReason } = useSyncExternalStore(subscribeModeStatus, getModeStatus)

  useEffect(() => { void refreshModeStatus() }, [])

  if (mode === 'server') {
    const { icon: StatusIcon, color, labelKey } = statusConfig[status]
    return (
      <Tooltip content={t('mode.tooltipDetail', { mode: t('mode.server'), detail: t(labelKey) })}>
        <div className="flex items-center justify-center rounded-lg p-2">
          <StatusIcon className={cn('h-4 w-4', color)} />
        </div>
      </Tooltip>
    )
  }

  const Icon = mode === 'local' ? Cpu : Cloud
  const title = mode === 'local' ? t('mode.local') : t('mode.cloudApi')
  const notReady = ready === false
  // blockedReason 目前是 Rust/服务层给的中文串（P2-1 会改成 code 再本地化）。
  // 这里只保证**外壳**跟随语言，不假装里面那句已经翻好了。
  const tip = notReady
    ? t('mode.tooltipNotReady', { mode: title, reason: blockedReason || t('mode.notReadyFallback') })
    : detail ? t('mode.tooltipDetail', { mode: title, detail }) : title

  return (
    <Tooltip content={tip}>
      <div className="flex items-center justify-center rounded-lg p-2">
        <Icon className={cn('h-4 w-4', notReady ? 'text-warning' : 'text-sidebar-text')} />
      </div>
    </Tooltip>
  )
}

export default function Sidebar() {
  const t = useT()
  const { pathname } = useLocation()
  const navGroupRef = useRef<HTMLDivElement>(null)
  // 当前页在底部那排（设置 / 关于）时这一组没有选中项，滑块淡出；从那边切回来时原地出现，不跨组滑。
  const navIndicatorRef = useSlidingIndicator(navGroupRef, pathname, { activeSelector: '[aria-current="page"]' })
  return (
    <nav className="flex w-48 flex-col border-r border-sidebar-border bg-sidebar py-4">
      {/* mac：标题栏左边归系统红绿灯，图标和名字放在侧栏最上面、「首页」上方（Windows 的在标题栏里）。
          图标中心对齐下面导航项的图标列（距侧栏左边 32px）。 */}
      {IS_MAC && (
        <div className="mb-3 flex items-center gap-2.5 pl-[18px] pr-3">
          <img src={macIcon} srcSet={`${macIcon} 1x, ${macIcon2x} 2x`} width={28} height={28}
            alt="" aria-hidden className="h-7 w-7 shrink-0" draggable={false} />
          <span className="text-sm text-sidebar-text-active" style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800, letterSpacing: '0.01em' }}>SayIt</span>
        </div>
      )}
      <div ref={navGroupRef} className="relative flex-1 space-y-1 px-3">
        {dailyNavItems.map(({ to, icon, labelKey }) => (
          <NavItem key={to} to={to} icon={icon} label={t(labelKey)} />
        ))}

        <div className="px-1 py-3">
          <div className="h-px bg-[linear-gradient(to_right,transparent_0%,hsl(var(--sidebar-border))_5%,hsl(var(--sidebar-border))_95%,transparent_100%)]" />
        </div>
        {configNavItems.map(({ to, icon, labelKey }) => (
          <NavItem key={to} to={to} icon={icon} label={t(labelKey)} />
        ))}
        {/* 滑块放最后：放第一个的话 space-y-1 会给"首页"加一个 margin-top，整列下移 4px。 */}
        <span ref={navIndicatorRef} aria-hidden className="sliding-indicator rounded-lg bg-sidebar-item-active" />
      </div>

      <div className="space-y-3 px-3 pt-4">
        <div className="h-px bg-[linear-gradient(to_right,transparent_0%,hsl(var(--sidebar-border))_5%,hsl(var(--sidebar-border))_95%,transparent_100%)]" />
        <FooterIcons />
      </div>
    </nav>
  )
}
