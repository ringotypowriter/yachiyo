import { createContext, useContext, type ReactNode } from 'react'
import type { AppDialogActionTone } from './AppDialog'

export interface AppAlertOptions {
  title: ReactNode
  message?: ReactNode
  confirmLabel?: string
}

export interface AppConfirmOptions {
  title: ReactNode
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: AppDialogActionTone
}

export interface AppPromptOptions {
  title: ReactNode
  message?: ReactNode
  initialValue?: string
  confirmLabel?: string
  cancelLabel?: string
}

export interface AppDialogApi {
  alert: (options: AppAlertOptions) => Promise<void>
  confirm: (options: AppConfirmOptions) => Promise<boolean>
  prompt: (options: AppPromptOptions) => Promise<string | null>
}

export const AppDialogContext = createContext<AppDialogApi | null>(null)

export function useAppDialog(): AppDialogApi {
  const context = useContext(AppDialogContext)
  if (!context) {
    throw new Error('useAppDialog must be used inside AppDialogProvider')
  }
  return context
}
