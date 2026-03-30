import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

const DEFAULT_LOGIN_SHELL = '/bin/zsh'
const SHELL_ENV_IGNORED_KEYS = new Set(['_', 'OLDPWD', 'PWD', 'SHLVL'])

/**
 * Returns the user's actual configured login shell from the system user database.
 * This is more reliable than $SHELL, which may reflect a parent process's shell
 * rather than the user's current default (e.g. in GUI app contexts on macOS).
 */
function resolveLoginShell(baseEnv: NodeJS.ProcessEnv): string {
  try {
    const shell = userInfo().shell
    if (shell) return shell
  } catch {
    // userInfo() can fail in some sandboxed/containerized contexts
  }
  return baseEnv.SHELL?.trim() || DEFAULT_LOGIN_SHELL
}

export function parseShellEnvOutput(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const entry of output.split('\0')) {
    if (!entry) {
      continue
    }

    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = entry.slice(0, separatorIndex)
    if (!key || SHELL_ENV_IGNORED_KEYS.has(key)) {
      continue
    }

    env[key] = entry.slice(separatorIndex + 1)
  }

  return env
}

export function mergeShellEnv(
  baseEnv: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv }

  for (const [key, value] of Object.entries(shellEnv)) {
    if (value === undefined || SHELL_ENV_IGNORED_KEYS.has(key)) {
      continue
    }

    merged[key] = value
  }

  return merged
}

export function readLoginShellEnvSync(
  baseEnv: NodeJS.ProcessEnv = process.env,
  shellPath = resolveLoginShell(baseEnv)
): NodeJS.ProcessEnv {
  try {
    const output = execFileSync(shellPath, ['-l', '-c', 'env -0'], {
      env: { ...baseEnv },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 4,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return parseShellEnvOutput(output)
  } catch {
    return {}
  }
}

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
