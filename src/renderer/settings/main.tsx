import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import SettingsApp from './App'
import { AppDialogProvider } from '@renderer/components/AppDialogProvider'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppDialogProvider>
      <SettingsApp />
    </AppDialogProvider>
  </React.StrictMode>
)
