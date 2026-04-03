import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

export interface SearchBinaries {
  rg: string | undefined
  bfs: string | undefined
}

/**
 * Resolve bundled rg and bfs binaries.
 *
 * Resolution order:
 * 1. Packaged Electron app: `process.resourcesPath/bin/{rg,bfs}`
 * 2. Dev mode: `{projectRoot}/resources/bin/{platform}-{arch}/{rg,bfs}`
 *
 * Returns `undefined` for a binary that cannot be found or is not executable.
 */
export function resolveSearchBinaries(options?: {
  /** Override the project root for dev-mode resolution. */
  projectRoot?: string
}): SearchBinaries {
  // Match electron-builder's ${os} naming: mac, linux, win.
  const osMap: Record<string, string> = { darwin: 'mac', linux: 'linux', win32: 'win' }
  const platformDir = `${osMap[process.platform] ?? process.platform}-${process.arch}`
  const candidates: string[] = []

  // Packaged: electron-builder copies resources/bin/{os}-{arch}/* → resources/bin/
  if (typeof process.resourcesPath === 'string') {
    candidates.push(join(process.resourcesPath, 'bin'))
  }

  // Dev: binaries live under the project root
  if (options?.projectRoot) {
    candidates.push(join(options.projectRoot, 'resources', 'bin', platformDir))
  }

  // Fallback: resolve relative to this file's location.
  // import.meta.dirname is available in Node ≥ 21.2 and Electron ≥ 29.
  // In dev (electron-vite), it points somewhere under out/main/ or src/main/.
  // In packaged apps it may point inside app.asar — skip those paths since
  // binaries inside an ASAR archive are not executable.
  const thisDir = import.meta.dirname
  if (thisDir && !thisDir.includes('.asar')) {
    const devRoot = findProjectRoot(thisDir)
    if (devRoot) {
      candidates.push(join(devRoot, 'resources', 'bin', platformDir))
    }
  }

  return {
    rg: findExecutable('rg', candidates),
    bfs: findExecutable('bfs', candidates)
  }
}

function findExecutable(name: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  return undefined
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findProjectRoot(startDir: string): string | undefined {
  let current = startDir
  for (let depth = 0; depth < 10; depth++) {
    // A project root has a package.json
    try {
      accessSync(join(current, 'package.json'), constants.R_OK)
      return current
    } catch {
      const parent = join(current, '..')
      if (parent === current) return undefined
      current = parent
    }
  }
  return undefined
}
