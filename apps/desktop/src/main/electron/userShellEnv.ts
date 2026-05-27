import {
  mergeShellEnv,
  parseShellEnvOutput,
  readLoginShellEnvSync
} from '@yachiyo/runtime/runtime/shell/loginShellEnv'

export { mergeShellEnv, parseShellEnvOutput, readLoginShellEnvSync }

export function hydrateProcessEnvFromLoginShell(): void {
  if (process.platform !== 'darwin') {
    return
  }

  const shellEnv = readLoginShellEnvSync(process.env)
  const merged = mergeShellEnv(process.env, shellEnv)

  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }
}

/**
 * Resolves the proxy for HTTPS and applies it to both process.env (for Node.js
 * HTTP clients) and Electron's default session (for electron-updater and net.fetch).
 *
 * Priority: shell-configured env vars > system proxy resolver.
 * Only runs on macOS.
 */
export async function hydrateProxyFromSystemSettings(): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }

  const { session } = await import('electron')

  // If the shell already exported a proxy, apply it to the Electron session too
  // so that electron-updater's net module picks it up.
  const shellProxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (shellProxy) {
    try {
      await session.defaultSession.setProxy({ proxyRules: shellProxy })
    } catch {
      // best-effort
    }
    return
  }

  try {
    const { app } = await import('electron')
    // Resolve against GitHub since that's the primary external endpoint
    // (update checks, release page). Also covers Google OAuth via PAC rules.
    const proxyString = await app.resolveProxy('https://github.com')
    // proxyString is e.g. "PROXY 10.0.0.1:3128" or "SOCKS5 10.0.0.1:1080" or "DIRECT"
    const match = proxyString.match(/^(?:PROXY|HTTPS)\s+(\S+)/i)
    if (match) {
      const proxyUrl = `http://${match[1]}`
      process.env.HTTPS_PROXY = proxyUrl
      process.env.https_proxy = proxyUrl
      process.env.HTTP_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
      await session.defaultSession.setProxy({ proxyRules: proxyUrl })
    }
  } catch {
    // resolveProxy is best-effort; ignore failures
  }
}
