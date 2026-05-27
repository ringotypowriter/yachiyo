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
