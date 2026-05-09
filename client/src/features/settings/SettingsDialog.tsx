import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, User, Stethoscope, Palette, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import GeneralSettingsPage from './GeneralSettingsPage'
import AppearancePage from './AppearancePage'
import PersonalizationPage from './PersonalizationPage'
import DiagnosticsPage from './DiagnosticsPage'

type SettingsView = 'general' | 'appearance' | 'personalization' | 'diagnostics'

interface SettingsMenuItem {
  id: SettingsView
  icon: typeof Settings
  label: string
}

const menuItems: SettingsMenuItem[] = [
  { id: 'general', icon: Settings, label: '设置' },
  { id: 'appearance', icon: Palette, label: '外观' },
  { id: 'personalization', icon: User, label: '使用统计' },
  { id: 'diagnostics', icon: Stethoscope, label: '诊断' },
]

export default function SettingsDialog() {
  const navigate = useNavigate()
  const [activeView, setActiveView] = useState<SettingsView>('general')

  const handleClose = () => {
    navigate('/')
  }

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div 
        className="relative flex h-[85vh] w-[90vw] max-w-6xl overflow-hidden rounded-xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 关闭按钮 */}
        <button
          onClick={handleClose}
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>

        {/* 左侧菜单 */}
        <div className="w-48 border-r border-border bg-card py-8">
          <div className="space-y-0.5 px-3">
            {menuItems.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all',
                  activeView === id
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 右侧内容区 */}
        <div className="custom-scrollbar flex-1 overflow-y-auto">
          {activeView === 'general' && <GeneralSettingsPage />}
          {activeView === 'appearance' && <AppearancePage />}
          {activeView === 'personalization' && <PersonalizationPage />}
          {activeView === 'diagnostics' && <DiagnosticsPage />}
        </div>
      </div>
    </div>
  )
}
