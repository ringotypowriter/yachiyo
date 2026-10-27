import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveYachiyoDataDir } from '@yachiyo/runtime/config/paths'

const PAIRING_QR_FILE = /^[0-9a-f-]{36}\.png$/
const PAIRING_QR_TTL_MS = 5 * 60_000

function pairingQrDirectory(): string {
  return join(resolveYachiyoDataDir(), 'remote', 'pairing-qr')
}

async function prunePairingQrImages(directory: string, now: number, all: boolean): Promise<void> {
  let filenames: string[]
  try {
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return
    filenames = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const filename of filenames) {
    if (!PAIRING_QR_FILE.test(filename)) continue
    const path = join(directory, filename)
    try {
      const info = await lstat(path)
      if (info.isFile() && (all || info.mtimeMs + PAIRING_QR_TTL_MS <= now)) await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** Pairing offers belong to the prior process: remove all of its QR files at startup. */
export function prunePairingQrImagesOnStartup(directory = pairingQrDirectory()): Promise<void> {
  return prunePairingQrImages(directory, Date.now(), true)
}

/** Remove overdue images on subsequent pairing requests without touching live QR offers. */
export function pruneExpiredPairingQrImages(
  directory = pairingQrDirectory(),
  now = Date.now()
): Promise<void> {
  return prunePairingQrImages(directory, now, false)
}

/** A private, expiring file keeps the bearer QR out of the model's text output. */
export async function storePairingQrImage(input: {
  png: Buffer
  expiresAt: string
  directory?: string
  now?: () => number
}): Promise<string> {
  const directory = input.directory ?? pairingQrDirectory()
  const now = input.now ?? Date.now
  const expiresAt = Date.parse(input.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt - now() > PAIRING_QR_TTL_MS) {
    throw new Error('Invalid pairing QR expiry.')
  }
  if (input.png.length === 0 || input.png.length > 200_000) {
    throw new Error('Invalid pairing QR image size.')
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('Pairing QR directory is not private.')
  }
  await chmod(directory, 0o700)
  await pruneExpiredPairingQrImages(directory, now())
  const path = join(directory, `${randomUUID()}.png`)
  await writeFile(path, input.png, { flag: 'wx', mode: 0o600 })
  const timer = setTimeout(
    () => {
      void unlink(path).catch(() => {})
    },
    Math.max(0, expiresAt - now())
  )
  timer.unref()
  return path
}
