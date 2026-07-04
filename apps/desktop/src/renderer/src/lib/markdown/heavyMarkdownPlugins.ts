import { useEffect, useState } from 'react'
import type { PluginConfig } from 'streamdown'

/**
 * The mermaid (~2.5 MB), shiki, and katex plugin stacks dominate the startup
 * bundle if imported statically. They load on demand here; until they arrive,
 * markdown renders with fenced blocks unhighlighted and math/diagrams as plain
 * code, then upgrades once — usually before the user opens any thread thanks to
 * the idle prefetch in App.
 */
export interface HeavyMarkdownPlugins {
  code: NonNullable<PluginConfig['code']>
  math: NonNullable<PluginConfig['math']>
  mermaid: NonNullable<PluginConfig['mermaid']>
}

let loadedPlugins: HeavyMarkdownPlugins | null = null
let loadPromise: Promise<HeavyMarkdownPlugins> | null = null

export function loadHeavyMarkdownPlugins(): Promise<HeavyMarkdownPlugins> {
  loadPromise ??= Promise.all([
    import('@streamdown/mermaid'),
    import('@streamdown/code'),
    import('./mathPlugin')
  ]).then(([mermaidModule, codeModule, mathModule]) => {
    loadedPlugins = {
      mermaid: mermaidModule.mermaid,
      code: codeModule.code,
      math: mathModule.mathPlugin
    }
    return loadedPlugins
  })
  return loadPromise
}

export function useHeavyMarkdownPlugins(): HeavyMarkdownPlugins | null {
  const [plugins, setPlugins] = useState(loadedPlugins)

  useEffect(() => {
    if (plugins) return
    let cancelled = false
    loadHeavyMarkdownPlugins()
      .then((loaded) => {
        if (!cancelled) setPlugins(loaded)
      })
      .catch((error) => {
        console.error('[markdown] failed to load highlight/diagram plugins', error)
      })
    return () => {
      cancelled = true
    }
  }, [plugins])

  return plugins
}
