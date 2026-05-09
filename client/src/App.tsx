import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import WelcomeGuide from './components/WelcomeGuide'
import Home from './pages/Home'
import History from './pages/History'
import Favorites from './pages/Favorites'
import Dictionary from './pages/Dictionary'
import Settings from './pages/Settings'
import VoiceEnginePage from './features/settings/VoiceEnginePage'
import AIServicePage from './features/settings/AIServicePage'
import AIInstructionsPage from './features/settings/AIInstructionsPage'
import About from './pages/About'
import { initRecorder, cleanup } from './services/recorder'
import { initTheme } from './stores/theme'
import { getSetting, setSetting } from './services/store'
import { runAutoUpdate } from './features/update/autoUpdate'
import UpdateDialog from './features/update/UpdateDialog'

export default function App() {
  const [showWelcome, setShowWelcome] = useState(false)

  useEffect(() => {
    void initTheme()
    initRecorder()
    void runAutoUpdate()

    // 检查是否需要显示欢迎向导（仅首次安装）
    ;(async () => {
      const onboardedVersion = await getSetting('onboardingVersion', '')
      if (!onboardedVersion) {
        setShowWelcome(true)
      }
    })()

    return () => cleanup()
  }, [])

  const handleWelcomeComplete = () => {
    setShowWelcome(false)
    void setSetting('onboardingVersion', __APP_VERSION__)
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
    </div>
  )
}
