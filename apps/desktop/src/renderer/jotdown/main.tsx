import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import JotdownApp from './App'
import { AppErrorBoundary } from '@renderer/components/AppErrorBoundary'
import { applyPlatformUi, applyStoredThemePreference } from '@renderer/theme/themeRuntime'

applyStoredThemePreference()
applyPlatformUi(window.api.process.platform)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <JotdownApp />
    </AppErrorBoundary>
  </React.StrictMode>
)
