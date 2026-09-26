import './assets/main.css'
import './features/chat/components/share/responseShare.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrapAppSession } from './app/bootstrap'
import { AppDialogProvider } from './components/AppDialogProvider'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { applyPlatformUi, applyStoredThemePreference } from './theme/themeRuntime'
import { syncTitleBarOverlay } from './features/layout/lib/titleBarOverlay'
import { resolvePlatformCapabilities } from '@yachiyo/shared/platformCapabilities'

applyStoredThemePreference()
applyPlatformUi(window.api.process.platform)
if (resolvePlatformCapabilities(window.api.process.platform).titleBarOverlay) {
  syncTitleBarOverlay(window.api.setTitleBarOverlay)
}
bootstrapAppSession()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppDialogProvider>
        <App />
      </AppDialogProvider>
    </AppErrorBoundary>
  </StrictMode>
)
