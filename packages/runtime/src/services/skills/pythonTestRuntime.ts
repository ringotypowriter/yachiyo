import { spawnSync } from 'node:child_process'

export interface PythonTestRuntime {
  command: string
  prefixArgs: readonly string[]
}

const PYTHON_3_PROBE = 'import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)'

export function resolvePythonTestRuntime(
  platform: NodeJS.Platform = process.platform
): PythonTestRuntime {
  const candidates: PythonTestRuntime[] =
    platform === 'win32'
      ? [
          { command: 'py.exe', prefixArgs: ['-3'] },
          { command: 'python.exe', prefixArgs: [] }
        ]
      : [{ command: 'python3', prefixArgs: [] }]

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.prefixArgs, '-c', PYTHON_3_PROBE], {
      stdio: 'ignore',
      windowsHide: true
    })
    if (result.status === 0) {
      return candidate
    }
  }

  throw new Error(`Python 3 is required to run core skill tests on ${platform}.`)
}
