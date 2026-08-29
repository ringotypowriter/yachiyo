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

export function resolveBundledExecutable(
  options: ResolveBundledExecutableOptions
): string | undefined {
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

  for (const candidate of candidates) {
    try {
      accessSync(candidate, platform === 'win32' ? constants.R_OK : constants.X_OK)
      return candidate
    } catch {
      // Continue through the explicit resolution order.
    }
  }
  return undefined
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
