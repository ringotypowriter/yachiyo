import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

export type CommandEndpoint =
  | { kind: 'unix-socket'; address: string }
  | { kind: 'windows-pipe'; address: string }

export interface CommandEndpointOptions {
  platform: NodeJS.Platform
  yachiyoHome: string
}

function normalizeWindowsHome(path: string): string {
  return win32
    .normalize(path)
    .replace(/[\\/]+$/u, '')
    .toLocaleLowerCase('en-US')
}

function stableWindowsHomeId(path: string): string {
  return createHash('sha256').update(normalizeWindowsHome(path), 'utf8').digest('hex').slice(0, 16)
}

export function resolveCommandEndpoint(options: CommandEndpointOptions): CommandEndpoint {
  if (options.platform === 'win32') {
    return {
      kind: 'windows-pipe',
      address: `\\\\.\\pipe\\yachiyo-${stableWindowsHomeId(options.yachiyoHome)}`
    }
  }

  return {
    kind: 'unix-socket',
    address: posix.join(options.yachiyoHome, 'yachiyo.sock')
  }
}
