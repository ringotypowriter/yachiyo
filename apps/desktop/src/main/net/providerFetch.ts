import tls from 'node:tls'

import { fetch as undiciFetch, ProxyAgent } from 'undici'

/**
 * Provider (LLM) traffic normally rides Electron's net.fetch, which honors the
 * system proxy but inherits Chromium's hard socket caps: 6 concurrent HTTP/1.1
 * connections per origin, ~32 per proxy. Each SSE stream holds a connection
 * for its whole lifetime, so parallel threads behind an HTTP/1.1 proxy queue
 * behind each other. When a proxy is configured we route provider traffic
 * through undici instead, which has no connection cap and still honors the
 * proxy. Set YACHIYO_PROVIDER_NET_FETCH=1 to force the net.fetch path.
 */

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
] as const

export function resolveProviderProxyUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (env.YACHIYO_PROVIDER_NET_FETCH === '1') {
    return undefined
  }
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]?.trim()
    if (!value) {
      continue
    }
    // undici's ProxyAgent speaks HTTP CONNECT only; leave socks proxies on
    // Chromium's net.fetch, which supports them.
    if (/^socks/i.test(value)) {
      return undefined
    }
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  }
  return undefined
}

// Node's bundled roots don't include OS-installed CAs, which TLS-intercepting
// proxies rely on. Merge them in where tls.getCACertificates exists (Node 22.15+).
function collectTrustedCAs(): string[] | undefined {
  const getCACertificates = (
    tls as { getCACertificates?: (type?: 'default' | 'system') => string[] }
  ).getCACertificates
  if (!getCACertificates) {
    return undefined
  }
  try {
    return [...getCACertificates('default'), ...getCACertificates('system')]
  } catch {
    return undefined
  }
}

function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return '<unparseable proxy url>'
  }
}

export function createProxiedFetch(proxyUrl: string): typeof globalThis.fetch {
  const ca = collectTrustedCAs()
  const dispatcher = new ProxyAgent({
    uri: proxyUrl,
    allowH2: true,
    ...(ca ? { proxyTls: { ca }, requestTls: { ca } } : {})
  })
  return ((input, init) =>
    undiciFetch(
      input as never,
      {
        ...init,
        dispatcher
      } as never
    ) as unknown as Promise<Response>) as typeof globalThis.fetch
}

export function createProviderFetch(input: {
  env: NodeJS.ProcessEnv
  netFetch: typeof globalThis.fetch
  createProxiedFetch?: (proxyUrl: string) => typeof globalThis.fetch
}): typeof globalThis.fetch {
  const proxyUrl = resolveProviderProxyUrl(input.env)
  if (!proxyUrl) {
    return input.netFetch
  }
  try {
    const proxiedFetch = (input.createProxiedFetch ?? createProxiedFetch)(proxyUrl)
    console.log(
      `[provider-fetch] routing provider traffic through undici via proxy ${redactProxyUrl(proxyUrl)}`
    )
    return proxiedFetch
  } catch (error) {
    console.error(
      '[provider-fetch] failed to build proxied fetch, falling back to net.fetch:',
      error
    )
    return input.netFetch
  }
}
