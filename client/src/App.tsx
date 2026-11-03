import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import WelcomeGuide from './components/WelcomeGuide'
import Home from './pages/Home'
import History from './pages/History'
import Dictionary from './pages/Dictionary'
import Settings from './pages/Settings'
import VoiceEnginePage from './features/settings/VoiceEnginePage'
import AIServicePage from './features/settings/AIServicePage'
import AIInstructionsPage from './features/settings/AIInstructionsPage'
import About from './pages/About'
import { initRecorder, cleanup } from './services/recorder'
import { initTheme } from './stores/theme'
import { initAiEnabled } from './stores/aiEnabled'
import { initActivePreset } from './stores/activePreset'
import { getSetting, setSetting } from './services/store'
import { startUpdateService } from './features/update/autoUpdate'
import { startWebDavBackupService } from './features/backup/autoWebdavBackup'
import UpdateDialog from './features/update/UpdateDialog'
import UpdateNotificationHost from './features/update/UpdateNotificationHost'
import * as bridge from './services/bridge'

export default function App() {
  const [showWelcome, setShowWelcome] = useState(false)
  // 首次挂载时先不渲染主界面，等 onboarding 检查完成再决定，避免"闪一下主页再进向导"
  const [onboardingChecked, setOnboardingChecked] = useState(false)
  const navigate = useNavigate()

  // 初始化 + 清理：必须只在挂载/卸载各执行一次。
  // ⚠️ 依赖数组务必保持为空 []！这里的 cleanup() 会断开 WebSocket，若把会变化的
  // 值（如 react-router 的 navigate）放进依赖，effect 会反复卸载重装，导致
  // 「连上→cleanup 断连→重连」的死循环（连上几秒就断、从不发 start）。
  useEffect(() => {
    void initTheme()
    void initAiEnabled()
    void initActivePreset()
    initRecorder()
    void startUpdateService()
    void startWebDavBackupService()

      // 检查是否需要显示欢迎向导（仅首次安装）
      ; (async () => {
        const onboardedVersion = await getSetting('onboardingVersion', '')
        if (!onboardedVersion) {
          setShowWelcome(true)
        }
        setOnboardingChecked(true)
      })()

    return () => {
      cleanup()
    }
  }, [])

  // 自动更新安装完成后，看门人进程会带 --open-about 重新拉起本程序，
  // Rust 端据此发出 open-about 事件，这里跳转到关于页方便用户确认更新已生效。
  // 单独一个 effect：它的清理只是取消监听，不会断开连接，所以依赖 navigate 无副作用。
  useEffect(() => {
    const unlistenOpenAbout = listen('open-about', () => {
      navigate('/about')
    })
    // macOS 应用菜单的「设置…」（⌘,）；Windows 不会发这个事件
    const unlistenOpenSettings = listen('open-settings', () => {
      navigate('/settings')
    })
    return () => {
      void unlistenOpenAbout.then((fn) => fn())
      void unlistenOpenSettings.then((fn) => fn())
    }
  }, [navigate])

  const handleWelcomeComplete = () => {
    setShowWelcome(false)
    void setSetting('onboardingVersion', __APP_VERSION__)
    // 向导完成后通知 Rust 端重新加载快捷键配置
    bridge.notifyShortcutsChanged()
  }

  // onboarding 检查未完成前只渲染与背景同色的空壳，避免首次安装时主页闪现
  if (!onboardingChecked) {
    return <div className="h-screen bg-background" />
  }

  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="custom-scrollbar flex-1 overflow-y-auto bg-background p-8">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/history" element={<History />} />
            <Route path="/favorites" element={<Navigate to="/history" replace />} />
            <Route path="/hotwords" element={<Dictionary />} />
            <Route path="/dictionary" element={<Navigate to="/hotwords" replace />} />
            <Route path="/voice-engine" element={<VoiceEnginePage />} />
            <Route path="/ai-instructions" element={<AIInstructionsPage />} />
            <Route path="/ai-service" element={<AIServicePage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </main>
      </div>
      {showWelcome && <WelcomeGuide onComplete={handleWelcomeComplete} />}
      <UpdateDialog />
      <UpdateNotificationHost enabled={!showWelcome} />
    </div>
  )
}
