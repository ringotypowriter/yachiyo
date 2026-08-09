import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'

import { resolveYachiyoDataDir } from '../../config/paths.ts'
import { readLoginShellEnvSync } from './loginShellEnv.ts'

export type ShellRuntimeKind = 'login-shell' | 'portable-git-bash'

export interface ShellCommandSpec {
  executable: string
  args: string[]
  options: {
    cwd: string
    detached: boolean
    env: NodeJS.ProcessEnv
    windowsHide: boolean
  }
}

export interface ShellRuntime {
  kind: ShellRuntimeKind
  executable: string
  environment: NodeJS.ProcessEnv
  spawnOptions: { detached: boolean; windowsHide: boolean }
  args(command: string): string[]
  command(command: string, options: { cwd: string }): ShellCommandSpec
}

export interface ResolveShellRuntimeOptions {
  platform: NodeJS.Platform
  arch: string
  mode: 'development' | 'packaged'
  projectRoot: string
  resourcesPath: string
  homeDir: string
  cliBinDir: string
  env: NodeJS.ProcessEnv
  loginShellExecutable?: string
  readLoginShellEnvironment?: () => NodeJS.ProcessEnv
  pathExists?: (path: string) => boolean
}

export interface ResolveHostShellRuntimeOptions {
  platform?: NodeJS.Platform
  arch?: string
  mode?: 'development' | 'packaged'
  defaultApp?: boolean
  projectRoot?: string
  resourcesPath?: string
  homeDir?: string
  cliBinDir?: string
  env?: NodeJS.ProcessEnv
  loginShellExecutable?: string
  readLoginShellEnvironment?: () => NodeJS.ProcessEnv
  pathExists?: (path: string) => boolean
}

function createRuntime(input: {
  kind: ShellRuntimeKind
  executable: string
  environment: NodeJS.ProcessEnv
  args: (command: string) => string[]
  detached: boolean
  windowsHide: boolean
}): ShellRuntime {
  const spawnOptions = { detached: input.detached, windowsHide: input.windowsHide }
  return {
    kind: input.kind,
    executable: input.executable,
    environment: input.environment,
    spawnOptions,
    args: input.args,
    command(command, options): ShellCommandSpec {
      return {
        executable: input.executable,
        args: input.args(command),
        options: {
          cwd: options.cwd,
          detached: input.detached,
          env: input.environment,
          windowsHide: input.windowsHide
        }
      }
    }
  }
}

function resolveWindowsHelperBin(options: ResolveShellRuntimeOptions): string {
  if (options.mode === 'packaged') return win32.join(options.resourcesPath, 'bin')
  return win32.join(options.projectRoot, 'apps', 'desktop', 'resources', 'bin', 'win-x64')
}

function resolveWindowsEnvironment(
  options: ResolveShellRuntimeOptions,
  helperBin: string
): NodeJS.ProcessEnv {
  const bashRoot = win32.join(helperBin, 'bash')
  const prefix = [
    options.cliBinDir,
    helperBin,
    win32.join(bashRoot, 'mingw64', 'bin'),
    win32.join(bashRoot, 'usr', 'bin')
  ].join(';')
  let inheritedPath: string | undefined
  const inheritedEnvironment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (key.toLowerCase() === 'path') {
      inheritedPath = value?.trim()
    } else {
      inheritedEnvironment[key] = value
    }
  }

  return {
    ...inheritedEnvironment,
    PATH: inheritedPath ? `${prefix};${inheritedPath}` : prefix,
    HOME: options.homeDir,
    MSYSTEM: 'MINGW64',
    CHERE_INVOKING: '1',
    MSYS2_PATH_TYPE: 'inherit'
  }
}

export function resolveShellRuntime(options: ResolveShellRuntimeOptions): ShellRuntime {
  if (options.platform !== 'win32') {
    const executable = options.loginShellExecutable ?? options.env.SHELL?.trim() ?? '/bin/zsh'
    const environment = options.readLoginShellEnvironment
      ? options.readLoginShellEnvironment()
      : readLoginShellEnvSync(options.env, executable)
    return createRuntime({
      kind: 'login-shell',
      executable,
      environment,
      args: (command) => ['-lc', command],
      detached: true,
      windowsHide: false
    })
  }

  const helperBin = resolveWindowsHelperBin(options)
  const executable = win32.join(helperBin, 'bash', 'usr', 'bin', 'bash.exe')
  const pathExists = options.pathExists ?? existsSync
  if (!pathExists(executable)) {
    throw new Error(
      `Private PortableGit Bash is missing at ${executable}. Run yachiyo doctor --json for repair guidance.`
    )
  }

  return createRuntime({
    kind: 'portable-git-bash',
    executable,
    environment: resolveWindowsEnvironment(options, helperBin),
    args: (command) => ['--noprofile', '--norc', '-c', command],
    detached: true,
    windowsHide: true
  })
}

function findProjectRoot(startDir: string): string | undefined {
  let current = startDir
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

function electronResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

function electronDefaultApp(): boolean {
  return (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
}

export function resolveHostShellRuntime(
  options: ResolveHostShellRuntimeOptions = {}
): ShellRuntime {
  const resourcesPath = options.resourcesPath ?? electronResourcesPath()
  const defaultApp = options.defaultApp ?? electronDefaultApp()
  const mode = options.mode ?? (resourcesPath && !defaultApp ? 'packaged' : 'development')
  const projectRoot = options.projectRoot ?? findProjectRoot(import.meta.dirname) ?? process.cwd()
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const env = options.env ?? process.env
  const yachiyoDataDir = resolveYachiyoDataDir({ platform, env, homeDir })

  return resolveShellRuntime({
    platform,
    arch: options.arch ?? process.arch,
    mode,
    projectRoot,
    resourcesPath: resourcesPath ?? projectRoot,
    homeDir,
    cliBinDir:
      options.cliBinDir ??
      (platform === 'win32' ? win32.join(yachiyoDataDir, 'bin') : join(yachiyoDataDir, 'bin')),
    env,
    loginShellExecutable: options.loginShellExecutable ?? '/bin/zsh',
    readLoginShellEnvironment: options.readLoginShellEnvironment,
    pathExists: options.pathExists
  })
}

function quoteBashToken(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

export function buildBashCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteBashToken).join(' ')
}
