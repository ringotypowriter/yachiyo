import { existsSync } from 'node:fs'
import { join } from 'node:path'

function getResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

export function resolvePackagedRuntimeNodeModule(packageName: string): string | undefined {
  const resourcesPath = getResourcesPath()
  if (!resourcesPath) return undefined

  const packageRoot = join(resourcesPath, 'node_modules', ...packageName.split('/'))
  return existsSync(join(packageRoot, 'package.json')) ? packageRoot : undefined
}

export function resolveRuntimeNodeModule(
  packageName: string,
  requireFromModule: NodeJS.Require
): string {
  return resolvePackagedRuntimeNodeModule(packageName) ?? requireFromModule.resolve(packageName)
}
