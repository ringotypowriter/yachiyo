import type { PluginConfig } from 'streamdown'

type CodePlugin = NonNullable<PluginConfig['code']>

/** A cold grammar may still be loading after the plugin module itself has arrived. */
export function trackShareCodeReadiness(
  plugin: CodePlugin,
  onPendingChange: (pending: boolean) => void
): CodePlugin {
  const pending = new Set<symbol>()
  return {
    ...plugin,
    highlight(options, callback) {
      const token = Symbol()
      pending.add(token)
      const result = plugin.highlight(options, (highlighted) => {
        pending.delete(token)
        callback?.(highlighted)
        onPendingChange(pending.size > 0)
      })
      if (result !== null) pending.delete(token)
      onPendingChange(pending.size > 0)
      return result
    }
  }
}
