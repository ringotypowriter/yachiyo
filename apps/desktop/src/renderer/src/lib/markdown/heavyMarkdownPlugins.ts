import { useEffect, useMemo, useState } from 'react'
import type { PluginConfig } from 'streamdown'

/**
 * Mermaid, Shiki, and KaTeX dominate the startup bundle. Ordinary Markdown
 * stays on Streamdown's light path, and rich syntax loads only its own plugin
 * family.
 */
export interface HeavyMarkdownFeatures {
  code: boolean
  math: boolean
  mermaid: boolean
}

export interface HeavyMarkdownPlugins {
  code?: NonNullable<PluginConfig['code']>
  math?: NonNullable<PluginConfig['math']>
  mermaid?: NonNullable<PluginConfig['mermaid']>
}

const loadedPlugins: HeavyMarkdownPlugins = {}
let codeLoadPromise: Promise<void> | null = null
let mathLoadPromise: Promise<void> | null = null
let mermaidLoadPromise: Promise<void> | null = null

export function detectHeavyMarkdownFeatures(content: string): HeavyMarkdownFeatures {
  return {
    code: /```|~~~/u.test(content),
    math: /\$|\\\(|\\\[/u.test(content),
    mermaid: /(?:^|\n)\s*(?:```|~~~)mermaid(?:\s|$)/iu.test(content)
  }
}

function loadRequestedPlugins(features: HeavyMarkdownFeatures): Promise<void> {
  const loads: Promise<void>[] = []
  if (features.code && !loadedPlugins.code) {
    codeLoadPromise ??= import('@streamdown/code').then((module) => {
      loadedPlugins.code = module.code
    })
    loads.push(codeLoadPromise)
  }
  if (features.math && !loadedPlugins.math) {
    mathLoadPromise ??= import('./mathPlugin').then((module) => {
      loadedPlugins.math = module.mathPlugin
    })
    loads.push(mathLoadPromise)
  }
  if (features.mermaid && !loadedPlugins.mermaid) {
    mermaidLoadPromise ??= import('@streamdown/mermaid').then((module) => {
      loadedPlugins.mermaid = module.mermaid
    })
    loads.push(mermaidLoadPromise)
  }
  return Promise.all(loads).then(() => undefined)
}

export function useHeavyMarkdownPlugins(content: string): HeavyMarkdownPlugins | null {
  const { code, math, mermaid } = detectHeavyMarkdownFeatures(content)
  const [loadVersion, setLoadVersion] = useState(0)

  useEffect(() => {
    const needsLoad =
      (code && !loadedPlugins.code) ||
      (math && !loadedPlugins.math) ||
      (mermaid && !loadedPlugins.mermaid)
    if (!needsLoad) return

    let cancelled = false
    loadRequestedPlugins({ code, math, mermaid })
      .then(() => {
        if (!cancelled) setLoadVersion((version) => version + 1)
      })
      .catch((error) => {
        console.error('[markdown] failed to load a rich-markdown plugin', error)
      })
    return () => {
      cancelled = true
    }
  }, [code, math, mermaid])

  return useMemo(() => {
    void loadVersion
    const plugins: HeavyMarkdownPlugins = {}
    if (code && loadedPlugins.code) plugins.code = loadedPlugins.code
    if (math && loadedPlugins.math) plugins.math = loadedPlugins.math
    if (mermaid && loadedPlugins.mermaid) plugins.mermaid = loadedPlugins.mermaid
    return Object.keys(plugins).length > 0 ? plugins : null
  }, [code, math, mermaid, loadVersion])
}
