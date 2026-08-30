import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'

export interface WorkspacePythonEnvironment {
  workspacePath: string
  environmentPath: string
  pythonPath: string
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export async function resolveWorkspacePythonEnvironment(
  requestedWorkspacePath: string
): Promise<WorkspacePythonEnvironment | undefined> {
  const workspacePath = await realpath(requestedWorkspacePath)
  const requestedEnvironmentPath = join(workspacePath, '.venv')
  try {
    await lstat(requestedEnvironmentPath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }

  let environmentPath: string
  try {
    environmentPath = await realpath(requestedEnvironmentPath)
    const environmentStat = await lstat(environmentPath)
    if (!environmentStat.isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(
      `Workspace .venv exists but is not a usable virtual environment directory: ${requestedEnvironmentPath}`
    )
  }

  const pythonPath =
    process.platform === 'win32'
      ? join(environmentPath, 'Scripts', 'python.exe')
      : join(environmentPath, 'bin', 'python')
  try {
    await access(pythonPath, constants.X_OK)
    const executablePath = await realpath(pythonPath)
    if (!(await lstat(executablePath)).isFile()) throw new Error('not a file')
  } catch {
    throw new Error(
      `Workspace .venv Python executable is missing or unusable: ${pythonPath}. Recreate the virtual environment with CPython 3.11 or newer.`
    )
  }
  return { workspacePath, environmentPath, pythonPath }
}
