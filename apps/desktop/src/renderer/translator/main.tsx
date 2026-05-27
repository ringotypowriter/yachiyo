import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import TranslatorApp from './App'
import { applyStoredThemePreference } from '@renderer/theme/themeRuntime'

applyStoredThemePreference()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TranslatorApp />
  </React.StrictMode>
)
