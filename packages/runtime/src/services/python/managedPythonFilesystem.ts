import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function token(): string {
  return randomBytes(16).toString('hex')
}

export function canonicalForComparison(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = canonicalForComparison(parentPath)
  const candidate = canonicalForComparison(candidatePath)
  const pathFromParent = relative(parent, candidate)
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const pathStat = await lstat(path)
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > maximumBytes) {
    throw new Error(`Managed runtime file is invalid at ${path}.`)
  }
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  )
  try {
    const fileStat = await file.stat()
    if (
      !fileStat.isFile() ||
      fileStat.size > maximumBytes ||
      fileStat.dev !== pathStat.dev ||
      fileStat.ino !== pathStat.ino
    ) {
      throw new Error(`Managed runtime file changed while opening ${path}.`)
    }
    const bytes = await file.readFile()
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`Managed runtime file is too large at ${path}.`)
    }
    return bytes
  } finally {
    await file.close()
  }
}

export async function readBoundedFile(path: string, maximumBytes = 64 * 1024): Promise<string> {
  return (await readRegularFile(path, maximumBytes)).toString('utf8')
}

export async function assertManagedDirectory(path: string, homePath: string): Promise<string> {
  if (!isPathInside(homePath, path)) {
    throw new Error(`Managed Python path leaves YACHIYO_HOME: ${path}`)
  }
  let currentPath = homePath
  const components = relative(homePath, path)
    .split(/[\\/]+/u)
    .filter(Boolean)
  for (const component of components) {
    currentPath = join(currentPath, component)
    const componentStat = await lstat(currentPath)
    if (componentStat.isSymbolicLink()) {
      throw new Error(`Managed Python path traverses a symbolic link: ${currentPath}`)
    }
  }
  const pathStat = await lstat(path)
  if (!pathStat.isDirectory()) {
    throw new Error(`Managed Python path is not a private directory: ${path}`)
  }
  const canonicalPath = await realpath(path)
  const verifiedStat = await lstat(path)
  if (
    verifiedStat.isSymbolicLink() ||
    !verifiedStat.isDirectory() ||
    verifiedStat.dev !== pathStat.dev ||
    verifiedStat.ino !== pathStat.ino ||
    !isPathInside(homePath, canonicalPath)
  ) {
    throw new Error(`Managed Python path changed or leaves YACHIYO_HOME: ${path}`)
  }
  return canonicalPath
}

export async function ensureManagedDirectory(path: string, homePath: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const canonicalPath = await assertManagedDirectory(path, homePath)
  if (process.platform !== 'win32') {
    await assertManagedDirectory(path, homePath)
    await chmod(path, 0o700)
  }
  return canonicalPath
}

export async function assertOptionalManagedDirectory(
  path: string,
  homePath: string
): Promise<boolean> {
  try {
    await assertManagedDirectory(path, homePath)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

export async function writePrivateFile(
  path: string,
  content: string,
  exclusive = false
): Promise<void> {
  const file = await open(path, exclusive ? 'wx' : 'w', 0o600)
  try {
    await file.writeFile(content, 'utf8')
    if (process.platform !== 'win32') await file.chmod(0o600)
  } finally {
    await file.close()
  }
}

export async function hashFile(path: string): Promise<string> {
  const pathStat = await lstat(path)
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`Managed runtime file is invalid at ${path}.`)
  }
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  )
  try {
    const fileStat = await file.stat()
    if (!fileStat.isFile() || fileStat.dev !== pathStat.dev || fileStat.ino !== pathStat.ino) {
      throw new Error(`Managed runtime file changed while opening ${path}.`)
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const verifiedStat = await file.stat()
    if (
      verifiedStat.dev !== fileStat.dev ||
      verifiedStat.ino !== fileStat.ino ||
      verifiedStat.size !== fileStat.size
    ) {
      throw new Error(`Managed runtime file changed while hashing ${path}.`)
    }
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

export async function stagePythonRunner(source: string | URL, rootPath: string): Promise<string> {
  const suppliedParentPath = dirname(rootPath)
  const homePath = await realpath(suppliedParentPath)
  const canonicalRoot = await assertManagedDirectory(
    join(homePath, relative(suppliedParentPath, rootPath)),
    homePath
  )
  const runnersPath = join(canonicalRoot, 'runners')
  await ensureManagedDirectory(runnersPath, homePath)
  const sourceBytes = await readFile(source)
  const expectedHash = createHash('sha256').update(sourceBytes).digest('hex')
  const targetPath = join(runnersPath, `${expectedHash}.py`)

  const verifyTarget = async (normalizeMode = false): Promise<boolean> => {
    try {
      await assertManagedDirectory(runnersPath, homePath)
      const pathStat = await lstat(targetPath)
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) return false
      const file = await open(
        targetPath,
        constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
      )
      try {
        const fileStat = await file.stat()
        if (!fileStat.isFile() || fileStat.dev !== pathStat.dev || fileStat.ino !== pathStat.ino) {
          return false
        }
        const bytes = await file.readFile()
        if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) return false
        if (normalizeMode && process.platform !== 'win32') await file.chmod(0o600)
        const verifiedStat = await lstat(targetPath)
        return (
          verifiedStat.isFile() &&
          !verifiedStat.isSymbolicLink() &&
          verifiedStat.dev === fileStat.dev &&
          verifiedStat.ino === fileStat.ino
        )
      } finally {
        await file.close()
      }
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ELOOP')) return false
      throw error
    }
  }

  if (!(await verifyTarget())) {
    const temporaryPath = join(runnersPath, `.${expectedHash}-${token()}.tmp`)
    const file = await open(temporaryPath, 'wx', 0o600)
    try {
      await file.writeFile(sourceBytes)
      if (process.platform !== 'win32') await file.chmod(0o600)
    } finally {
      await file.close()
    }
    try {
      if ((await hashFile(temporaryPath)) !== expectedHash) {
        throw new Error('The staged Python runner did not preserve its source bytes.')
      }
      await assertManagedDirectory(runnersPath, homePath)
      if (!(await verifyTarget())) {
        try {
          await link(temporaryPath, targetPath)
        } catch (error) {
          if (!isNodeError(error, 'EEXIST') || !(await verifyTarget())) {
            throw new Error('The staged Python runner target is present but failed verification.', {
              cause: error
            })
          }
        }
      }
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
  if (!(await verifyTarget(true))) {
    throw new Error('The staged Python runner failed its SHA-256 verification.')
  }
  return targetPath
}
