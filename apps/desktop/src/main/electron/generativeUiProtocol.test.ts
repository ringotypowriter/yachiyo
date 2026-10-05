import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { Script } from 'node:vm'
import type { WebContents } from 'electron'
import {
  buildGenerativeUiShell,
  installGenerativeUiNavigationGuard,
  installGenerativeUiResourceGuard,
  isGenerativeUiShellUrl,
  normalizeGenerativeUiThemeVars,
  GENERATIVE_UI_URL
} from './generativeUiProtocol.ts'

describe('isolated generative UI shell', () => {
  it('accepts only native theme variables and bounded values', () => {
    assert.deepEqual(
      normalizeGenerativeUiThemeVars({
        '--yachiyo-rgb-ink': '45 45 43',
        '--yachiyo-rgb-surface': '255 255 255',
        '--yachiyo-font-ui': 'Avenir Next, sans-serif',
        background: 'url(file:///private.png)',
        '--arbitrary-css': 'red',
        '--yachiyo-rgb-accent': 'url(https://example.com)',
        '--yachiyo-rgb-counter': '999 0 0',
        '--yachiyo-font-size': '500px'
      }),
      {
        '--yachiyo-rgb-ink': '45 45 43',
        '--yachiyo-rgb-surface': '255 255 255',
        '--yachiyo-font-ui': 'Avenir Next, sans-serif'
      }
    )
    assert.deepEqual(normalizeGenerativeUiThemeVars(null), {})
  })
  it('serves only the exact fixed shell URL (not paths, queries, fragments or credentials)', () => {
    assert.equal(GENERATIVE_UI_URL, 'yachiyo-ui://sandbox/')
    assert.equal(isGenerativeUiShellUrl(GENERATIVE_UI_URL), true)
    for (const url of [
      'yachiyo-ui://sandbox/file',
      'yachiyo-ui://sandbox/?p=%2Fetc%2Fpasswd',
      'yachiyo-ui://sandbox/#fragment',
      'yachiyo-ui://other/',
      'yachiyo-ui://user@sandbox/',
      'file:///tmp/sandbox.html',
      'not a url'
    ])
      assert.equal(isGenerativeUiShellUrl(url), false, url)
  })

  it('locks down subresources and executes only nonce-authorized shell scripts', () => {
    const { html, csp } = buildGenerativeUiShell()
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /script-src 'nonce-[^']+'/)
    assert.match(csp, /style-src 'unsafe-inline'/)
    assert.match(csp, /img-src data:/)
    assert.match(csp, /connect-src 'none'/)
    assert.match(csp, /frame-src 'none'/)
    assert.match(csp, /object-src 'none'/)
    assert.match(csp, /form-action 'none'/)
    assert.doesNotMatch(csp, /unsafe-eval|bypassCSP/)
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1]
    assert.ok(nonce)
    assert.ok(html.includes(`<script nonce="${nonce}">`))
    assert.doesNotMatch(html, /<script(?! nonce=)/)
  })

  it('guards one-time parent-port handshake, final JS, and dangerous HTML before insertion', () => {
    const { html } = buildGenerativeUiShell()
    assert.match(html, /event\.source !== window\.parent/)
    assert.match(html, /event\.ports\.length !== 1/)
    assert.match(html, /type: 'yachiyo-ui-ready'/)
    assert.match(html, /'yachiyo-ui-connect'/)
    assert.match(html, /'render'/)
    assert.match(html, /completed/)
    assert.match(html, /DOMParser/)
    assert.match(html, /ResizeObserver/)
    assert.match(html, /continueConversation/)
    assert.match(html, /openLink/)
    assert.match(html, /createElementNS/)
    assert.match(html, /canvas/)
    assert.match(html, /document\.documentElement\.dataset\.theme/)
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1]
    assert.ok(script)
    assert.doesNotThrow(() => new Script(script))
  })

  it('blocks sandbox-origin child navigations but not host navigation or initial fixed shell load', () => {
    let listener:
      | ((details: {
          url: string
          isMainFrame: boolean
          frame: { url: string } | null
          initiator: { url: string } | null
          preventDefault: () => void
        }) => void)
      | undefined
    const fakeContents = {
      on: (_event: string, handler: typeof listener) => {
        listener = handler
      }
    } as unknown as WebContents
    installGenerativeUiNavigationGuard(fakeContents)
    assert.ok(listener)
    let blocked = false
    listener({
      url: 'https://attacker.example/',
      isMainFrame: false,
      frame: { url: GENERATIVE_UI_URL },
      initiator: null,
      preventDefault: () => {
        blocked = true
      }
    })
    assert.equal(blocked, true)
    blocked = false
    listener({
      url: GENERATIVE_UI_URL,
      isMainFrame: false,
      frame: { url: '' },
      initiator: null,
      preventDefault: () => {
        blocked = true
      }
    })
    assert.equal(blocked, false)
    listener({
      url: 'https://host.example/',
      isMainFrame: true,
      frame: { url: 'file:///index.html' },
      initiator: null,
      preventDefault: () => {
        blocked = true
      }
    })
    assert.equal(blocked, false)
  })

  it('blocks privileged local image loads requested by shell frames without affecting host images', () => {
    let listener:
      | ((
          details: { frame: { url: string }; resourceType: string },
          callback: (result: { cancel: boolean }) => void
        ) => void)
      | undefined
    const contents = {
      session: {
        webRequest: {
          onBeforeRequest: (_filter: unknown, callback: typeof listener) => {
            listener = callback
          }
        }
      }
    } as unknown as WebContents
    installGenerativeUiResourceGuard(contents)
    assert.ok(listener)
    let cancelled = false
    listener({ frame: { url: GENERATIVE_UI_URL }, resourceType: 'image' }, (result) => {
      cancelled = result.cancel
    })
    assert.equal(cancelled, true)
    listener({ frame: { url: `${GENERATIVE_UI_URL}#bypass` }, resourceType: 'image' }, (result) => {
      cancelled = result.cancel
    })
    assert.equal(cancelled, true, 'Same-document hash changes cannot escape the frame guard')
    listener({ frame: { url: 'file:///renderer/index.html' }, resourceType: 'image' }, (result) => {
      cancelled = result.cancel
    })
    assert.equal(cancelled, false)
  })
})
