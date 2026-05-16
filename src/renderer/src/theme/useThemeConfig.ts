import { useEffect, useState } from 'react'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import {
  applyThemeConfig,
  subscribeToConfigThemeChanges,
  subscribeToSystemThemeChanges
} from './themeRuntime.ts'

export function useApplyThemeConfig(
  config: Pick<SettingsConfig, 'general'> | null | undefined,
  remember = true
): void {
  useEffect(() => {
    if (!config) {
      return
    }
    applyThemeConfig(config, { remember })
    return subscribeToSystemThemeChanges(() => applyThemeConfig(config, { remember }))
  }, [config, remember])
}

export function useAuxiliaryThemeConfig(): void {
  const [config, setConfig] = useState<SettingsConfig | null>(null)
  useApplyThemeConfig(config)

  useEffect(() => {
    let cancelled = false
    void window.api.yachiyo.getConfig().then((nextConfig) => {
      if (!cancelled) {
        setConfig(nextConfig)
      }
    })

    const unsubscribe = subscribeToConfigThemeChanges(setConfig)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
}
