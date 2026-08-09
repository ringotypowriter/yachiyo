import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

export interface SearchBinaries {
  rg: string | undefined
  fd: string | undefined
}

export interface ResolveSearchBinariesOptions {
  platform?: NodeJS.Platform
  arch?: string
  projectRoot?: string
  resourcesPath?: string
}

/**
 * Resolve bundled rg and fd binaries.
 *
 * Resolution order:
 * 1. Packaged Electron app: `process.resourcesPath/bin/{rg,fd}`
 * 2. Dev mode: `{projectRoot}/apps/desktop/resources/bin/{platform}-{arch}/{rg,fd}`
 *
 * Returns `undefined` for a binary that cannot be found or is not executable.
 */
export function resolveSearchBinaries(options: ResolveSearchBinariesOptions = {}): SearchBinaries {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  // Match electron-builder's ${os} naming: mac, linux, win.
  const osMap: Record<string, string> = { darwin: 'mac', linux: 'linux', win32: 'win' }
  const platformDir = `${osMap[platform] ?? platform}-${arch}`
  const candidates: string[] = []

  // Packaged: electron-builder copies resources/bin/{os}-{arch}/* → resources/bin/
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (typeof resourcesPath === 'string') {
    candidates.push(join(resourcesPath, 'bin'))
  }

  // Dev: binaries live under the desktop app package.
  if (options?.projectRoot) {
    candidates.push(join(options.projectRoot, 'apps', 'desktop', 'resources', 'bin', platformDir))
  }

  // Fallback: resolve relative to this file's location.
  // import.meta.dirname is available in Node ≥ 21.2 and Electron ≥ 29.
  // In dev (electron-vite), it points somewhere under out/main/ or src/main/.
  // In packaged apps it may point inside app.asar — skip those paths since
  // binaries inside an ASAR archive are not executable.
  const thisDir = import.meta.dirname
  if (!options.projectRoot && thisDir && !thisDir.includes('.asar')) {
    const devRoot = findProjectRoot(thisDir)
    if (devRoot) {
      candidates.push(join(devRoot, 'apps', 'desktop', 'resources', 'bin', platformDir))
    }
  }

  return {
    rg: findExecutable(platform === 'win32' ? 'rg.exe' : 'rg', candidates, platform),
    fd: findExecutable(platform === 'win32' ? 'fd.exe' : 'fd', candidates, platform)
  }
}

function findExecutable(
  name: string,
  dirs: string[],
  platform: NodeJS.Platform
): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (isExecutable(candidate, platform)) {
      return candidate
    }
  }
  return undefined
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === 'win32' ? constants.R_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findProjectRoot(startDir: string): string | undefined {
  let current = startDir
  for (let depth = 0; depth < 10; depth++) {
    // The workspace root has pnpm-workspace.yaml.
    try {
      accessSync(join(current, 'pnpm-workspace.yaml'), constants.R_OK)
      return current
    } catch {
      const parent = join(current, '..')
      if (parent === current) return undefined
      current = parent
    }
  }
  return undefined
}
