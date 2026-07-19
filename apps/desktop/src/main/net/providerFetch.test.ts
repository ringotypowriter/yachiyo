import assert from 'node:assert/strict'
import test from 'node:test'

import { createProviderFetch, resolveProviderProxyUrl } from './providerFetch.ts'

test('resolveProviderProxyUrl prefers HTTPS_PROXY over the rest of the chain', () => {
  const url = resolveProviderProxyUrl({
    HTTPS_PROXY: 'http://one:1',
    https_proxy: 'http://two:2',
    HTTP_PROXY: 'http://three:3',
    ALL_PROXY: 'http://four:4'
  })
  assert.equal(url, 'http://one:1')
})

test('resolveProviderProxyUrl falls through empty and whitespace-only entries', () => {
  const url = resolveProviderProxyUrl({
    HTTPS_PROXY: '',
    https_proxy: '   ',
    HTTP_PROXY: ' http://three:3 '
  })
  assert.equal(url, 'http://three:3')
})

test('resolveProviderProxyUrl returns undefined when no proxy is configured', () => {
  assert.equal(resolveProviderProxyUrl({}), undefined)
})

test('resolveProviderProxyUrl normalizes a bare host:port to an http URL', () => {
  assert.equal(resolveProviderProxyUrl({ HTTPS_PROXY: '127.0.0.1:7890' }), 'http://127.0.0.1:7890')
})

test('resolveProviderProxyUrl rejects socks proxies (Chromium keeps handling those)', () => {
  assert.equal(resolveProviderProxyUrl({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' }), undefined)
  assert.equal(resolveProviderProxyUrl({ ALL_PROXY: 'socks://127.0.0.1:1080' }), undefined)
})

test('resolveProviderProxyUrl honors the YACHIYO_PROVIDER_NET_FETCH escape hatch', () => {
  const url = resolveProviderProxyUrl({
    YACHIYO_PROVIDER_NET_FETCH: '1',
    HTTPS_PROXY: 'http://one:1'
  })
  assert.equal(url, undefined)
})

test('createProviderFetch returns netFetch unchanged when no proxy is configured', () => {
  const netFetch = (() => Promise.resolve(new Response())) as typeof globalThis.fetch
  const providerFetch = createProviderFetch({
    env: {},
    netFetch,
    createProxiedFetch: () => {
      throw new Error('must not build a proxied fetch without a proxy')
    }
  })
  assert.equal(providerFetch, netFetch)
})

test('createProviderFetch routes through the proxied fetch when a proxy is configured', () => {
  const netFetch = (() => Promise.resolve(new Response())) as typeof globalThis.fetch
  const proxied = (() => Promise.resolve(new Response())) as typeof globalThis.fetch
  const seenProxyUrls: string[] = []
  const providerFetch = createProviderFetch({
    env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    netFetch,
    createProxiedFetch: (proxyUrl) => {
      seenProxyUrls.push(proxyUrl)
      return proxied
    }
  })
  assert.equal(providerFetch, proxied)
  assert.deepEqual(seenProxyUrls, ['http://127.0.0.1:7890'])
})

test('createProviderFetch falls back to netFetch when the proxied fetch cannot be built', () => {
  const netFetch = (() => Promise.resolve(new Response())) as typeof globalThis.fetch
  const providerFetch = createProviderFetch({
    env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    netFetch,
    createProxiedFetch: () => {
      throw new Error('undici unavailable')
    }
  })
  assert.equal(providerFetch, netFetch)
})
