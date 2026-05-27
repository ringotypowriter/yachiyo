import React, { useCallback, useMemo, useRef, useState } from 'react'
import { theme, alpha } from '@renderer/theme/theme'
import { AppDialog } from './AppDialog'
import {
  AppDialogContext,
  type AppAlertOptions,
  type AppConfirmOptions,
  type AppDialogApi,
  type AppPromptOptions
} from './AppDialogContext'

interface DialogRequestBase {
  id: number
}

interface AlertRequest extends AppAlertOptions, DialogRequestBase {
  kind: 'alert'
  resolve: () => void
}

interface ConfirmRequest extends AppConfirmOptions, DialogRequestBase {
  kind: 'confirm'
  resolve: (confirmed: boolean) => void
}

interface PromptRequest extends AppPromptOptions, DialogRequestBase {
  kind: 'prompt'
  resolve: (value: string | null) => void
}

type DialogRequest = AlertRequest | ConfirmRequest | PromptRequest

function PromptDialog({
  request,
  onResolve
}: {
  request: PromptRequest
  onResolve: (value: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState(request.initialValue ?? '')

  return (
    <AppDialog
      title={request.title}
      description={request.message}
      width={340}
      initialFocus="first"
      actions={[
        {
          key: 'confirm',
          label: request.confirmLabel ?? 'OK',
          tone: 'accent'
        },
        {
          key: 'cancel',
          label: request.cancelLabel ?? 'Cancel'
        }
      ]}
      onAction={(key) => onResolve(key === 'confirm' ? value : null)}
      onClose={() => onResolve(null)}
    >
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="w-full rounded-lg px-3 py-2 text-sm outline-none"
        style={{
          color: theme.text.primary,
          background: alpha('ink', 0.04),
          border: `1px solid ${theme.border.input}`
        }}
      />
    </AppDialog>
  )
}

export function AppDialogProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [activeRequest, setActiveRequest] = useState<DialogRequest | null>(null)
  const queueRef = useRef<DialogRequest[]>([])
  const requestIdRef = useRef(0)

  const activateNext = useCallback((): void => {
    setActiveRequest(queueRef.current.shift() ?? null)
  }, [])

  const enqueue = useCallback((request: DialogRequest): void => {
    queueRef.current.push(request)
    setActiveRequest((current) => current ?? queueRef.current.shift() ?? null)
  }, [])

  const api = useMemo<AppDialogApi>(
    () => ({
      alert: (options) =>
        new Promise<void>((resolve) => {
          enqueue({
            id: requestIdRef.current++,
            kind: 'alert',
            ...options,
            resolve
          })
        }),
      confirm: (options) =>
        new Promise<boolean>((resolve) => {
          enqueue({
            id: requestIdRef.current++,
            kind: 'confirm',
            ...options,
            resolve
          })
        }),
      prompt: (options) =>
        new Promise<string | null>((resolve) => {
          enqueue({
            id: requestIdRef.current++,
            kind: 'prompt',
            ...options,
            resolve
          })
        })
    }),
    [enqueue]
  )

  const closeActive = useCallback(
    (result: boolean | string | null): void => {
      if (!activeRequest) return
      if (activeRequest.kind === 'alert') {
        activeRequest.resolve()
      } else if (activeRequest.kind === 'confirm') {
        activeRequest.resolve(result === true)
      } else {
        activeRequest.resolve(typeof result === 'string' ? result : null)
      }
      activateNext()
    },
    [activeRequest, activateNext]
  )

  return (
    <AppDialogContext.Provider value={api}>
      {children}
      {activeRequest?.kind === 'prompt' ? (
        <PromptDialog key={activeRequest.id} request={activeRequest} onResolve={closeActive} />
      ) : activeRequest ? (
        <AppDialog
          title={activeRequest.title}
          description={activeRequest.message}
          width={320}
          actions={
            activeRequest.kind === 'alert'
              ? [
                  {
                    key: 'ok',
                    label: activeRequest.confirmLabel ?? 'OK',
                    tone: 'accent',
                    autoFocus: true
                  }
                ]
              : [
                  {
                    key: 'confirm',
                    label: activeRequest.confirmLabel ?? 'OK',
                    tone: activeRequest.tone ?? 'accent',
                    autoFocus: true
                  },
                  {
                    key: 'cancel',
                    label: activeRequest.cancelLabel ?? 'Cancel'
                  }
                ]
          }
          onAction={(key) => closeActive(key === 'confirm' || key === 'ok')}
          onClose={() => closeActive(false)}
        />
      ) : null}
    </AppDialogContext.Provider>
  )
}
