import { useEffect, useState, type CSSProperties } from 'react'
import type { MermaidOptions } from 'streamdown'
import type { ThemeRegistration } from 'shiki'
import {
  getThemePalette,
  resolveThemeAttributes,
  themeRgbTokenVars,
  type ThemeId,
  type ThemeVariant
} from '../../../../theme/theme.ts'

export interface ResponseShareTheme {
  themeId: ThemeId
  variant: ThemeVariant
  style: CSSProperties & Record<`--${string}`, string>
  mermaid: MermaidOptions
  codeTheme: ThemeRegistration
}

function hex(rgb: string): string {
  return `#${rgb
    .split(/\s+/)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`
}

/** Use the canonical palette for both rich renderers, not unrelated built-in themes. */
export function createResponseShareTheme(
  themeId: ThemeId,
  variant: ThemeVariant,
  variables: Record<`--${string}`, string> = {}
): ResponseShareTheme {
  const palette = getThemePalette(themeId, variant)
  const style: ResponseShareTheme['style'] = { ...variables, colorScheme: variant }
  for (const token of Object.keys(themeRgbTokenVars) as Array<keyof typeof themeRgbTokenVars>) {
    style[themeRgbTokenVars[token]] = variables[themeRgbTokenVars[token]] || palette[token]
  }
  const color = (token: keyof typeof palette): string => hex(style[themeRgbTokenVars[token]])
  const fontFamily = variables['--yachiyo-font-ui']
  return {
    themeId,
    variant,
    style,
    mermaid: {
      config: {
        theme: 'base',
        themeVariables: {
          darkMode: variant === 'dark',
          fontFamily,
          background: color('canvas'),
          primaryColor: color('surface'),
          primaryTextColor: color('ink'),
          primaryBorderColor: color('accentStrong'),
          secondaryColor: color('canvas'),
          secondaryTextColor: color('ink'),
          secondaryBorderColor: color('counterStrong'),
          tertiaryColor: color('app'),
          tertiaryTextColor: color('ink'),
          tertiaryBorderColor: color('accentStrong'),
          lineColor: color('textSecondary'),
          textColor: color('ink'),
          edgeLabelBackground: color('canvas'),
          actorTextColor: color('ink'),
          actorBkg: color('surface'),
          actorBorder: color('accentStrong'),
          signalColor: color('textSecondary'),
          signalTextColor: color('ink'),
          noteBkgColor: color('canvas'),
          noteTextColor: color('ink'),
          noteBorderColor: color('counterStrong')
        }
      }
    },
    codeTheme: {
      name: `yachiyo-share-${themeId}-${variant}`,
      type: variant,
      colors: { 'editor.background': color('canvas'), 'editor.foreground': color('ink') },
      tokenColors: [
        {
          scope: ['comment', 'punctuation.definition.comment'],
          settings: { foreground: color('textTertiary') }
        },
        {
          scope: ['keyword', 'storage', 'entity.name.tag'],
          settings: { foreground: color('accentStrong') }
        },
        { scope: ['string', 'markup.inserted'], settings: { foreground: color('successStrong') } },
        {
          scope: ['constant', 'entity.name.function', 'support.function'],
          settings: { foreground: color('counterStrong') }
        },
        { scope: ['invalid', 'markup.deleted'], settings: { foreground: color('danger') } }
      ]
    }
  }
}

/** Freeze the full palette and typography onto the article for body-mounted clones. */
export function readResponseShareTheme(root: HTMLElement): ResponseShareTheme {
  const attributes = resolveThemeAttributes(
    {
      themeId: root.dataset['yachiyoTheme'] as ThemeId,
      themeAppearance: root.dataset['yachiyoThemeVariant'] as ThemeVariant
    },
    false
  )
  const computed = root.ownerDocument.defaultView!.getComputedStyle(root)
  const variables: Record<`--${string}`, string> = {}
  for (const property of [
    ...Object.values(themeRgbTokenVars),
    '--yachiyo-font-ui',
    '--yachiyo-font-display',
    '--yachiyo-font-size-chat',
    '--font-mono'
  ] as const) {
    const value = computed.getPropertyValue(property).trim()
    if (value) variables[property] = value
  }
  return createResponseShareTheme(attributes.themeId, attributes.variant, variables)
}

export function useResponseShareTheme(): ResponseShareTheme {
  const [theme, setTheme] = useState(() => readResponseShareTheme(document.documentElement))
  useEffect(() => {
    const root = document.documentElement
    const sync = (): void => {
      const next = readResponseShareTheme(root)
      setTheme((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    }
    const observer = new MutationObserver(sync)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-yachiyo-theme', 'data-yachiyo-theme-variant']
    })
    sync()
    return () => observer.disconnect()
  }, [])
  return theme
}
