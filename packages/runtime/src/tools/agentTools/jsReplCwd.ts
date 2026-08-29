import path from 'node:path'

interface PathApi {
  isAbsolute(value: string): boolean
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  sep: string
}

export function resolveJsReplCallCwd(
  workspacePath: string,
  requested: string,
  pathApi: PathApi = path
): string {
  const resolved = pathApi.resolve(workspacePath, requested)
  const relativeToWorkspace = pathApi.relative(workspacePath, resolved)
  if (
    relativeToWorkspace === '..' ||
    relativeToWorkspace.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativeToWorkspace)
  ) {
    throw new Error(`Invalid cwd ${JSON.stringify(requested)}.`)
  }
  return resolved
}
