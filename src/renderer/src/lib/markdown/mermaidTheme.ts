import { useEffect, useState } from 'react'
import type { MermaidOptions } from 'streamdown'
import type { ThemeVariant } from '../../theme/theme.ts'

const THEME_VARIANT_ATTRIBUTE = 'data-yachiyo-theme-variant'

export function createMermaidOptions(variant: ThemeVariant): MermaidOptions {
  return {
    config: {
      theme: variant === 'dark' ? 'dark' : 'default'
    }
  }
}

export function readThemeVariantFromRoot(root: HTMLElement): ThemeVariant {
  const variant = root.dataset['yachiyoThemeVariant']
  if (variant === 'light' || variant === 'dark') {
    return variant
  }

  throw new Error(`Unsupported Yachiyo theme variant: ${variant ?? '(missing)'}`)
}

export function readDocumentThemeVariant(): ThemeVariant {
  return readThemeVariantFromRoot(document.documentElement)
}

export function useDocumentThemeVariant(): ThemeVariant {
  const [variant, setVariant] = useState(readDocumentThemeVariant)

  useEffect(() => {
    const root = document.documentElement
    const syncVariant = (): void => setVariant(readThemeVariantFromRoot(root))
    const observer = new MutationObserver(syncVariant)

    syncVariant()
    observer.observe(root, { attributes: true, attributeFilter: [THEME_VARIANT_ATTRIBUTE] })

    return () => observer.disconnect()
  }, [])

  return variant
}
