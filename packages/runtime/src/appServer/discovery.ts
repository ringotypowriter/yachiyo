import { APP_SERVER_PROTOCOL, type AppServerAddress } from '@yachiyo/shared/appServer/protocol'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const schema = z.object({
  protocol: z.literal(APP_SERVER_PROTOCOL),
  instanceId: z.string().uuid(),
  url: z.string().url(),
  token: z.string().min(32)
})

/** The OS owns this lock: reserve the home-specific port before opening SQLite. */
export function appServerPort(canonicalHome: string): number {
  return 32768 + (createHash('sha256').update(canonicalHome).digest().readUInt32BE(0) % 28232)
}

export async function readAppServerAddress(home: string): Promise<AppServerAddress | null> {
  const path = join(home, 'app-server.json')
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (
    !info.isFile() ||
    (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  ) {
    throw new Error('App server discovery file must be an owner-only regular file')
  }
  return schema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export async function publishAppServerAddress(
  home: string,
  address: AppServerAddress
): Promise<() => Promise<void>> {
  const path = join(home, 'app-server.json')
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(address), { flag: 'wx', mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
  return async () => {
    const current = await readAppServerAddress(home)
    if (current?.instanceId === address.instanceId) await unlink(path)
  }
}
