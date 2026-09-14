import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { createCodePlugin, type HighlightResult } from '@streamdown/code'
import { THEME_OPTIONS, getThemePalette, themeRgbTokenVars } from '../../../../theme/theme.ts'
import { createResponseShareTheme, readResponseShareTheme } from './responseShareTheme.ts'

for (const option of THEME_OPTIONS) {
  for (const variant of ['light', 'dark'] as const) {
    test(`${option.id} ${variant} shares every canonical palette token`, () => {
      const theme = createResponseShareTheme(option.id, variant)
      const palette = getThemePalette(option.id, variant)
      assert.equal(theme.variant, variant)
      assert.equal(theme.style.colorScheme, variant)
      for (const token of Object.keys(themeRgbTokenVars) as Array<keyof typeof themeRgbTokenVars>) {
        assert.equal(theme.style[themeRgbTokenVars[token]], palette[token])
      }
      assert.equal(theme.mermaid.config?.theme, 'base')
      assert.equal(theme.mermaid.config?.themeVariables?.darkMode, variant === 'dark')
    })
  }
}

test('snapshot preserves selected fonts and palette locally without modifying the document', () => {
  const { document, window } = parseHTML(
    '<html data-yachiyo-theme="murasaki" data-yachiyo-theme-variant="dark"><body></body></html>'
  )
  const root = document.documentElement
  root.style.setProperty('--yachiyo-font-ui', 'Selected UI Font, sans-serif')
  root.style.setProperty('--yachiyo-font-display', 'Selected Display Font, serif')
  root.style.setProperty('--font-mono', 'Selected Mono Font, monospace')
  root.style.setProperty('--unrelated-layout', '123px')
  // Linkedom has no CSS cascade; supply the browser-computed style boundary.
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: () => ({ getPropertyValue: (name: string) => root.style.getPropertyValue(name) ?? '' })
  })
  const before = root.outerHTML
  const theme = readResponseShareTheme(root)
  assert.equal(root.outerHTML, before)
  const article = document.createElement('article')
  Object.assign(article.style, theme.style)
  const clone = article.cloneNode(true) as HTMLElement
  document.body.append(clone)
  root.style.setProperty('--yachiyo-font-ui', 'Changed Font')
  assert.equal(clone.style.getPropertyValue('--yachiyo-font-ui'), 'Selected UI Font, sans-serif')
  assert.equal(clone.style.getPropertyValue('--font-mono'), 'Selected Mono Font, monospace')
  assert.equal(
    clone.style.getPropertyValue('--yachiyo-rgb-accent'),
    getThemePalette('murasaki', 'dark').accent
  )
  assert.equal(clone.style.getPropertyValue('--unrelated-layout'), undefined)
  assert.equal(theme.mermaid.config?.themeVariables?.fontFamily, 'Selected UI Font, sans-serif')
})

test('Mermaid and real Shiki tokens use the same selected accent and ink', async () => {
  const theme = createResponseShareTheme('murasaki', 'dark')
  assert.equal(theme.mermaid.config?.themeVariables?.primaryTextColor, '#ebeef5')
  assert.equal(theme.mermaid.config?.themeVariables?.primaryBorderColor, '#82aff5')
  const plugin = createCodePlugin({ themes: [theme.codeTheme, theme.codeTheme] })
  const result = await new Promise<HighlightResult>((resolve) => {
    const immediate = plugin.highlight(
      { code: 'const answer = 42', language: 'javascript', themes: plugin.getThemes() },
      resolve
    )
    if (immediate) resolve(immediate)
  })
  assert.equal(result.fg, '#ebeef5;--shiki-dark:#ebeef5')
  assert.equal(result.bg, '#181c28;--shiki-dark-bg:#181c28')
  assert.equal(
    result.tokens[0].find((token) => token.content === 'const')?.htmlStyle?.color?.toLowerCase(),
    '#82aff5'
  )
  assert.notDeepEqual(theme.codeTheme, createResponseShareTheme('mizu', 'light').codeTheme)
})
