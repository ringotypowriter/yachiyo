import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { bootstrapAppSession } from './app/bootstrap'
import { AppDialogProvider } from './components/AppDialogProvider'
import { applyStoredThemePreference } from './theme/themeRuntime'

const queryClient = new QueryClient()
applyStoredThemePreference()
bootstrapAppSession()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppDialogProvider>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AppDialogProvider>
  </StrictMode>
)
