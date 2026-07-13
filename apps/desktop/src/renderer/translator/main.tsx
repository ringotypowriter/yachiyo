import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import TranslatorApp from './App'
import { AppErrorBoundary } from '@renderer/components/AppErrorBoundary'
import { applyStoredThemePreference } from '@renderer/theme/themeRuntime'

applyStoredThemePreference()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <TranslatorApp />
    </AppErrorBoundary>
  </React.StrictMode>
)
