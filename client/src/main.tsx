import { startWebviewKeyboardFallback } from './services/webviewKeyboardFallback'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { addRuntimeEvent } from './services/debugLog'
import { initRuntimeConfig } from './services/runtimeConfig'
import { initProviderFromStore } from './services/transcription'
import { initLanguage, initLocaleDefaults } from './stores/language'
import { IS_MAC } from './lib/platform'
import { installMacWebviewBehavior } from './lib/macWebview'

// mac：系统滚动条、界面文字不可选、右键菜单只留在输入框里（见 lib/macWebview.ts）。
// 放在最前面，首帧就带上 platform-mac。
if (IS_MAC) installMacWebviewBehavior()

window.addEventListener('error', (event) => {
  addRuntimeEvent('error', 'window', event.message || 'Uncaught error', {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  addRuntimeEvent('error', 'promise', 'Unhandled promise rejection', {
    reason: String(event.reason),
  })
})

async function bootstrap() {
  await initRuntimeConfig()
  // 必须在 render 之前 await：否则首帧会用默认语言画一遍再跳，冷启动能看见闪动。
  const locale = await initLanguage()
  await initLocaleDefaults(locale)
  await initProviderFromStore()
  void startWebviewKeyboardFallback()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <HashRouter>
      <App />
    </HashRouter>,
  )
}

void bootstrap()
