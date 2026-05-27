export function resolveElectronSessionProxyConfig(): Electron.ProxyConfig {
  const proxyUrl = (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy
  )?.trim()

  return proxyUrl ? { mode: 'fixed_servers', proxyRules: proxyUrl } : { mode: 'system' }
}
