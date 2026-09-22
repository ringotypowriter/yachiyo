// Fake desktop for remote development: an in-memory Yachiyo server with the scripted model and
// demo threads, served by the real remote service. It never touches ~/.yachiyo.
//
//   node --experimental-strip-types scripts/remote-dev-harness.ts [--port 47841]
//     [--host 127.0.0.1] [--tunnel-url wss://<host>/remote/v1] [--url-file <path>] [--empty]
//
// Prints `YACHIYO_REMOTE_PAIRING_URL=<url>`; type `pair` + Enter for a fresh pairing URL.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

import { createFakeDesktopServer } from '../packages/runtime/src/app/host/remote/testing/createFakeDesktopServer.ts'
import { createInProcessRemotePorts } from '../apps/desktop/src/main/remote/inProcessPorts.ts'
import { plaintextSecretBox } from '../apps/desktop/src/main/remote/pairingStore.ts'
import { RemoteService } from '../apps/desktop/src/main/remote/remoteService.ts'
import type { RemoteEndpoint } from '../packages/shared/src/remote/common.ts'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '47841' },
    host: { type: 'string', default: '127.0.0.1' },
    'tunnel-url': { type: 'string' },
    'url-file': { type: 'string' },
    empty: { type: 'boolean', default: false }
  }
})

const fake = await createFakeDesktopServer({ demo: !values.empty })
const home = await mkdtemp(join(tmpdir(), 'yachiyo-remote-harness-'))
const ports = createInProcessRemotePorts(fake.server)
let lanUrl = ''
const service = new RemoteService({
  directory: join(home, 'remote'),
  uploadsDirectory: join(home, 'remote', 'uploads'),
  secretBox: plaintextSecretBox,
  server: ports.server,
  host: ports.host,
  subscribe: (listener) => fake.server.subscribe(listener),
  listen: { host: values.host!, port: Number(values.port) },
  deviceName: () => `Harness (${hostname().split('.')[0]})`,
  appVersion: '0.0.0-harness',
  endpoints: (): RemoteEndpoint[] => [
    ...(values['tunnel-url'] ? [{ kind: 'tunnel' as const, url: values['tunnel-url'] }] : []),
    { kind: 'lan', url: lanUrl }
  ],
  mailboxRoot: null,
  log: (line) => console.log(line)
})
await service.start()
lanUrl = `ws://127.0.0.1:${service.port}/remote/v1`
console.log(`YACHIYO_REMOTE_PORT=${service.port}`)

async function printPairingUrl(): Promise<void> {
  const { url, expiresAt } = await service.createPairingUrl()
  if (values['url-file']) await writeFile(values['url-file'], `${url}\n`)
  console.log(`YACHIYO_REMOTE_PAIRING_URL=${url}`)
  console.log(`(expires ${expiresAt})`)
}
await printPairingUrl()

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (line.trim() === 'pair') void printPairingUrl()
})

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  input.close()
  await service.stop()
  await fake.dispose()
  await rm(home, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
