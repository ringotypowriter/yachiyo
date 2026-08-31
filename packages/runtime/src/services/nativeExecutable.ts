import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ResolveBundledExecutableOptions {
  name: string
  platform?: NodeJS.Platform
  arch?: string
  projectRoot?: string
  resourcesPath?: string
  startDir?: string
  additionalCandidates?: string[]
}

function bundledCandidates(options: ResolveBundledExecutableOptions): string[] {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const osByPlatform: Record<string, string> = { darwin: 'mac', linux: 'linux', win32: 'win' }
  const platformDir = `${osByPlatform[platform] ?? platform}-${arch}`
  const candidates: string[] = []
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (typeof resourcesPath === 'string') {
    candidates.push(join(resourcesPath, 'bin', options.name))
  }

  const projectRoot =
    options.projectRoot ??
    (options.startDir && !options.startDir.includes('.asar')
      ? findProjectRoot(options.startDir)
      : undefined)
  if (projectRoot) {
    candidates.push(
      join(projectRoot, 'apps', 'desktop', 'resources', 'bin', platformDir, options.name)
    )
  }
  candidates.push(...(options.additionalCandidates ?? []))
  return candidates
}

function resolveBundledPath(
  options: ResolveBundledExecutableOptions,
  accessMode: number
): string | undefined {
  for (const candidate of bundledCandidates(options)) {
    try {
      accessSync(candidate, accessMode)
      return candidate
    } catch {
      // Continue through the explicit resolution order.
    }
  }
  return undefined
}

export function resolveBundledExecutable(
  options: ResolveBundledExecutableOptions
): string | undefined {
  const platform = options.platform ?? process.platform
  return resolveBundledPath(
    options,
    platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK
  )
}

export function resolveBundledResource(
  options: ResolveBundledExecutableOptions
): string | undefined {
  return resolveBundledPath(options, constants.R_OK)
}

function findProjectRoot(startDir: string): string | undefined {
  let current = startDir
  for (let depth = 0; depth < 10; depth++) {
    try {
      accessSync(join(current, 'pnpm-workspace.yaml'), constants.R_OK)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
  return undefined
}
