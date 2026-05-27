import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import JotdownApp from './App'
import { applyStoredThemePreference } from '@renderer/theme/themeRuntime'

applyStoredThemePreference()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <JotdownApp />
  </React.StrictMode>
)
