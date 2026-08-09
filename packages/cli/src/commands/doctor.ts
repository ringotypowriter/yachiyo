import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, win32 } from 'node:path'

import { resolveYachiyoDataDir, resolveYachiyoSocketPath } from '@yachiyo/runtime/config/paths'
import { resolveShellRuntime } from '@yachiyo/runtime/runtime/shell/shellRuntime'
import { resolveSearchBinaries } from '@yachiyo/runtime/services/search/searchBinaries'
import { resolvePlatformCapabilities } from '@yachiyo/shared/platformCapabilities'
import type { CliStdout } from '../core/types.ts'

export interface DoctorReport {
  platform: NodeJS.Platform
  arch: string
  commandEndpoint: string
  shell: {
    kind: 'login-shell' | 'portable-git-bash'
    available: boolean
    executable: string
    version: string
  }
  binaries: {
    rg: boolean
    fd: boolean
    syncCore: boolean
    python3: boolean
  }
  nativeModules: {
    betterSqlite3: boolean
    sharp: boolean
  }
  capabilities: {
    activityTracking: boolean
    activityOcr: boolean
    macAutomationSkills: boolean
  }
}

const require = createRequire(import.meta.url)

function electronResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

function isModuleAvailable(name: string): boolean {
  try {
    require(name)
    return true
  } catch {
    return false
  }
}

function readPortableGitVersion(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function windowsHelperBin(input: {
  mode: 'development' | 'packaged'
  projectRoot: string
  resourcesPath: string
}): string {
  return input.mode === 'packaged'
    ? win32.join(input.resourcesPath, 'bin')
    : win32.join(input.projectRoot, 'apps', 'desktop', 'resources', 'bin', 'win-x64')
}

export function resolvePython3Availability(input: {
  platform: NodeJS.Platform
  probe: (command: string, args: readonly string[]) => boolean
}): boolean {
  const verifyPython3 = [
    '-c',
    'import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)'
  ] as const
  const candidates =
    input.platform === 'win32'
      ? [
          { command: 'py.exe', args: ['-3', ...verifyPython3] },
          { command: 'python.exe', args: verifyPython3 }
        ]
      : [{ command: 'python3', args: verifyPython3 }]

  return candidates.some(({ command, args }) => input.probe(command, args))
}

export async function collectDoctorReport(): Promise<DoctorReport> {
  const platform = process.platform
  const arch = process.arch
  const resourcesPath = electronResourcesPath()
  const mode = resourcesPath ? 'packaged' : 'development'
  const projectRoot = process.cwd()
  const effectiveResourcesPath = resourcesPath ?? projectRoot
  const search = resolveSearchBinaries({
    platform,
    arch,
    projectRoot,
    resourcesPath
  })
  const capabilities = resolvePlatformCapabilities(platform)

  let shell: DoctorReport['shell']
  try {
    const homeDir = homedir()
    const yachiyoDataDir = resolveYachiyoDataDir({ platform, env: process.env, homeDir })
    const runtime = resolveShellRuntime({
      platform,
      arch,
      mode,
      projectRoot,
      resourcesPath: effectiveResourcesPath,
      homeDir,
      cliBinDir:
        platform === 'win32' ? win32.join(yachiyoDataDir, 'bin') : join(yachiyoDataDir, 'bin'),
      env: process.env
    })
    const markerPath =
      platform === 'win32'
        ? win32.join(
            windowsHelperBin({ mode, projectRoot, resourcesPath: effectiveResourcesPath }),
            'bash',
            '.yachiyo-runtime.json'
          )
        : ''
    shell = {
      kind: runtime.kind,
      available: true,
      executable: runtime.executable,
      version: platform === 'win32' ? readPortableGitVersion(markerPath) : 'system'
    }
  } catch {
    const helperBin = windowsHelperBin({ mode, projectRoot, resourcesPath: effectiveResourcesPath })
    shell = {
      kind: platform === 'win32' ? 'portable-git-bash' : 'login-shell',
      available: false,
      executable:
        platform === 'win32'
          ? win32.join(helperBin, 'bash', 'usr', 'bin', 'bash.exe')
          : process.env.SHELL?.trim() || '/bin/zsh',
      version:
        platform === 'win32'
          ? readPortableGitVersion(win32.join(helperBin, 'bash', '.yachiyo-runtime.json'))
          : 'system'
    }
  }

  const helperBin =
    platform === 'win32'
      ? windowsHelperBin({ mode, projectRoot, resourcesPath: effectiveResourcesPath })
      : resourcesPath
        ? join(resourcesPath, 'bin')
        : resolve(projectRoot, 'apps', 'desktop', 'resources', 'bin', `mac-${arch}`)

  return {
    platform,
    arch,
    commandEndpoint: resolveYachiyoSocketPath(),
    shell,
    binaries: {
      rg: Boolean(search.rg),
      fd: Boolean(search.fd),
      syncCore: existsSync(join(helperBin, platform === 'win32' ? 'sync-core.exe' : 'sync-core')),
      python3: resolvePython3Availability({
        platform,
        probe: (command, args) =>
          spawnSync(command, [...args], {
            env: process.env,
            stdio: 'ignore',
            timeout: 5_000,
            windowsHide: true
          }).status === 0
      })
    },
    nativeModules: {
      betterSqlite3: isModuleAvailable('better-sqlite3'),
      sharp: isModuleAvailable('sharp')
    },
    capabilities: {
      activityTracking: capabilities.activityTracking,
      activityOcr: capabilities.activityOcr,
      macAutomationSkills: capabilities.macAutomationSkills
    }
  }
}

function sanitizeDoctorReport(report: DoctorReport): DoctorReport {
  return {
    platform: report.platform,
    arch: report.arch,
    commandEndpoint: report.commandEndpoint,
    shell: {
      kind: report.shell.kind,
      available: report.shell.available,
      executable: report.shell.executable,
      version: report.shell.version
    },
    binaries: {
      rg: report.binaries.rg,
      fd: report.binaries.fd,
      syncCore: report.binaries.syncCore,
      python3: report.binaries.python3
    },
    nativeModules: {
      betterSqlite3: report.nativeModules.betterSqlite3,
      sharp: report.nativeModules.sharp
    },
    capabilities: {
      activityTracking: report.capabilities.activityTracking,
      activityOcr: report.capabilities.activityOcr,
      macAutomationSkills: report.capabilities.macAutomationSkills
    }
  }
}

function platformLabel(report: DoctorReport): string {
  return report.platform === 'win32'
    ? `Windows ${report.arch}`
    : `${report.platform} ${report.arch}`
}

function availability(value: boolean): 'available' | 'unavailable' {
  return value ? 'available' : 'unavailable'
}

export async function handleDoctorCommand(input: {
  json: boolean
  stdout: CliStdout
  collect?: () => Promise<DoctorReport>
}): Promise<void> {
  const report = sanitizeDoctorReport(await (input.collect ?? collectDoctorReport)())
  if (input.json) {
    input.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const shellLabel = report.shell.kind === 'portable-git-bash' ? 'PortableGit Bash' : 'Login shell'
  input.stdout.write(
    [
      `Platform: ${platformLabel(report)}`,
      `Command endpoint: ${report.commandEndpoint}`,
      `${shellLabel}: ${availability(report.shell.available)} (${report.shell.executable})`,
      `rg: ${availability(report.binaries.rg)}`,
      `fd: ${availability(report.binaries.fd)}`,
      `sync-core: ${availability(report.binaries.syncCore)}`,
      `Python 3: ${availability(report.binaries.python3)}${
        report.platform === 'win32' && !report.binaries.python3
          ? ' (install from https://www.python.org/downloads/windows/)'
          : ''
      }`,
      `better-sqlite3: ${availability(report.nativeModules.betterSqlite3)}`,
      `sharp: ${availability(report.nativeModules.sharp)}`,
      `Activity tracking: ${availability(report.capabilities.activityTracking)}`,
      `Activity OCR: ${availability(report.capabilities.activityOcr)}`,
      `macOS automation skills: ${availability(report.capabilities.macAutomationSkills)}`
    ].join('\n') + '\n'
  )
}
