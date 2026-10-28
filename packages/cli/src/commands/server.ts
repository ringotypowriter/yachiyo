import { connectAppServer } from '@yachiyo/runtime/appServer/connect'
import { readAppServerAddress } from '@yachiyo/runtime/appServer/discovery'
import { resolveYachiyoDataDir } from '@yachiyo/runtime/config/paths'
import type { RunYachiyoCliOptions } from '../core/types.ts'

export async function handleServerCommand(
  args: string[],
  options: RunYachiyoCliOptions
): Promise<void> {
  const action = args[0] ?? 'status'
  if (args.length > 1 || !['status', 'stop'].includes(action))
    throw new Error('Usage: yachiyo server [status|stop]')
  const address = await readAppServerAddress(resolveYachiyoDataDir())
  if (!address) throw new Error('Yachiyo app server is not running')
  const { client } = await connectAppServer(address)
  try {
    const status = (await client.call('server.status', [])) as { nativeHost: boolean }
    if (action === 'status') {
      ;(options.stdout ?? process.stdout).write(JSON.stringify(status, null, 2) + '\n')
      return
    }
    if (status.nativeHost) throw new Error('Quit the desktop app before stopping its app server')
    await client.call('server.shutdown', [])
    ;(options.stdout ?? process.stdout).write(JSON.stringify({ stopping: true }) + '\n')
  } finally {
    client.close()
  }
}
