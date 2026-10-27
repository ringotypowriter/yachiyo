import { spawnSync } from 'node:child_process'

export interface ObeliskStatus {
  ready: boolean
  version: string | null
  fts5: boolean
  yachiyoProvider: boolean
  issue: 'missing' | 'unsupported' | 'fts5' | 'probe-failed' | null
}

export function probeObelisk(
  probe: () => { status: number | null; stdout: string; error?: NodeJS.ErrnoException } = () =>
    spawnSync(
      process.platform === 'win32' ? 'cmd.exe' : 'obelisk',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'obelisk.cmd --doctor'] : ['--doctor'],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true }
    )
): ObeliskStatus {
  const result = probe()
  const status: ObeliskStatus = {
    ready: false,
    version: null,
    fts5: false,
    yachiyoProvider: false,
    issue: null
  }
  if (result.error) {
    status.issue = result.error.code === 'ENOENT' ? 'missing' : 'probe-failed'
    return status
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    status.issue = result.status === null ? 'probe-failed' : 'unsupported'
    return status
  }
  if (!parsed || typeof parsed !== 'object') {
    status.issue = 'unsupported'
    return status
  }
  const report = parsed as Record<string, unknown>
  status.version =
    typeof report.version === 'string' && /^\d+\.\d+\.\d+[\w.+-]*$/u.test(report.version)
      ? report.version
      : null
  status.fts5 = report.fts5 === true
  status.yachiyoProvider = Array.isArray(report.providers) && report.providers.includes('yachiyo')
  status.ready = result.status === 0 && report.ok === true && status.fts5 && status.yachiyoProvider
  status.issue = status.ready
    ? null
    : !status.yachiyoProvider
      ? 'unsupported'
      : !status.fts5
        ? 'fts5'
        : 'probe-failed'
  return status
}
