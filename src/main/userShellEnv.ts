import { execFileSync } from 'node:child_process'

const DEFAULT_LOGIN_SHELL = '/bin/zsh'
const SHELL_ENV_IGNORED_KEYS = new Set(['_', 'OLDPWD', 'PWD', 'SHLVL'])

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
  shellPath = baseEnv.SHELL?.trim() || DEFAULT_LOGIN_SHELL
): NodeJS.ProcessEnv {
  try {
    const output = execFileSync(shellPath, ['-l', '-c', 'printenv -0'], {
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
 * Resolves the system proxy for HTTPS via Electron's app.resolveProxy and injects
 * it into process.env so that node-fetch / gaxios (used by google-auth-library)
 * can pick it up. Only runs on macOS and only sets the env vars if they are not
 * already present (shell-configured proxies take precedence).
 */
export async function hydrateProxyFromSystemSettings(): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }

  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    return
  }

  try {
    const { app } = await import('electron')
    const proxyString = await app.resolveProxy('https://oauth2.googleapis.com')
    // proxyString is e.g. "PROXY 10.0.0.1:3128" or "SOCKS5 10.0.0.1:1080" or "DIRECT"
    const match = proxyString.match(/^(?:PROXY|HTTPS)\s+(\S+)/i)
    if (match) {
      const proxyUrl = `http://${match[1]}`
      process.env.HTTPS_PROXY = proxyUrl
      process.env.https_proxy = proxyUrl
      process.env.HTTP_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
    }
  } catch {
    // resolveProxy is best-effort; ignore failures
  }
}
