import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrapAppSession } from './app/bootstrap'
import { AppDialogProvider } from './components/AppDialogProvider'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { applyPlatformUi, applyStoredThemePreference } from './theme/themeRuntime'

applyStoredThemePreference()
applyPlatformUi(window.api.process.platform)
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
