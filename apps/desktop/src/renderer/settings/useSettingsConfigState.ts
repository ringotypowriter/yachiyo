import { useCallback, useEffect, useState, type SetStateAction } from 'react'
import type { SettingsConfig } from '@yachiyo/shared/protocol'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Keep local edits, but refresh untouched fields from the latest server snapshot. */
function rebaseDraft(saved: unknown, draft: unknown, incoming: unknown): unknown {
  if (JSON.stringify(saved) === JSON.stringify(draft)) return incoming
  if (isRecord(draft) && isRecord(incoming) && (saved === undefined || isRecord(saved))) {
    const result: Record<string, unknown> = { ...incoming }
    for (const key of new Set([...Object.keys(saved ?? {}), ...Object.keys(draft)])) {
      const value = rebaseDraft(saved?.[key], draft[key], incoming[key])
      if (value === undefined) delete result[key]
      else result[key] = value
    }
    return result
  }
  // Arrays (e.g. providers) and conflicting scalar edits remain local until Save/Discard.
  return draft
}

interface ConfigState {
  savedConfig: SettingsConfig | null
  draft: SettingsConfig | null
}

interface SettingsConfigState extends ConfigState {
  setSavedConfig(config: SettingsConfig | null): void
  setDraft(action: SetStateAction<SettingsConfig | null>): void
  initializeConfig(config: SettingsConfig): void
}

export function useSettingsConfigState(): SettingsConfigState {
  const [state, setState] = useState<ConfigState>({
    savedConfig: null,
    draft: null
  })
  const setSavedConfig = useCallback((savedConfig: SettingsConfig | null) => {
    setState((current) => ({ ...current, savedConfig }))
  }, [])
  const setDraft = useCallback((action: SetStateAction<SettingsConfig | null>) => {
    setState((current) => ({
      ...current,
      draft: typeof action === 'function' ? action(current.draft) : action
    }))
  }, [])
  const initializeConfig = useCallback((config: SettingsConfig) => {
    // A settings event can arrive before the initial getConfig response.
    setState((current) => (current.savedConfig ? current : { savedConfig: config, draft: config }))
  }, [])

  useEffect(
    () =>
      window.api.yachiyo.subscribe((event) => {
        if (event.type !== 'settings.updated') return
        setState((current) => ({
          savedConfig: event.config,
          draft:
            current.savedConfig && current.draft
              ? (rebaseDraft(current.savedConfig, current.draft, event.config) as SettingsConfig)
              : event.config
        }))
      }),
    []
  )

  return { ...state, setSavedConfig, setDraft, initializeConfig }
}
