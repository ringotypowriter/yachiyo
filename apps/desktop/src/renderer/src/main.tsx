import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { bootstrapAppSession } from './app/bootstrap'
import { AppDialogProvider } from './components/AppDialogProvider'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { applyStoredThemePreference } from './theme/themeRuntime'

const queryClient = new QueryClient()
applyStoredThemePreference()
bootstrapAppSession()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppDialogProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </AppDialogProvider>
    </AppErrorBoundary>
  </StrictMode>
)
