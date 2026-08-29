import { resolveBundledExecutable } from '../nativeExecutable.ts'

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
  const sharedOptions = {
    platform,
    arch: options.arch,
    projectRoot: options.projectRoot,
    resourcesPath: options.resourcesPath,
    startDir: import.meta.dirname
  }
  return {
    rg: resolveBundledExecutable({
      ...sharedOptions,
      name: platform === 'win32' ? 'rg.exe' : 'rg'
    }),
    fd: resolveBundledExecutable({
      ...sharedOptions,
      name: platform === 'win32' ? 'fd.exe' : 'fd'
    })
  }
}
