export interface CodeHighlightTokenTheme {
  lightColor?: string
  darkColor?: string
}

export function readCodeHighlightTokenTheme(
  htmlStyle: Record<string, string> | undefined
): CodeHighlightTokenTheme {
  const lightColor = htmlStyle?.color
  const darkColor = htmlStyle?.['--shiki-dark'] ?? lightColor
  return { lightColor, darkColor }
}

export function codeHighlightTokenStyle(
  token: CodeHighlightTokenTheme
): Record<string, string> | undefined {
  const style: Record<string, string> = {}
  if (token.lightColor) style['--yachiyo-code-token-color'] = token.lightColor
  if (token.darkColor) style['--yachiyo-code-token-color-dark'] = token.darkColor
  return Object.keys(style).length > 0 ? style : undefined
}
