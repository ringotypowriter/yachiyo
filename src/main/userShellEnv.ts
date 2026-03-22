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
