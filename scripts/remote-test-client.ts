// Node phone client that runs the remote critical path against a live endpoint:
// pair → hello → list → send → stream → answer askUser → disconnect → resume → forced resync.
//
//   node --experimental-strip-types scripts/remote-test-client.ts --url '<pairing url>'
//     [--endpoint wss://<host>/remote/v1]
//   node --experimental-strip-types scripts/remote-test-client.ts --spawn-harness
//
// Exits 0 when every step passes.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

import { runRemoteScenario } from '../apps/desktop/src/main/remote/testing/remoteScenario.ts'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    endpoint: { type: 'string' },
    'spawn-harness': { type: 'boolean', default: false }
  }
})

async function spawnHarness(): Promise<{ url: string; stop: () => void }> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'scripts/remote-dev-harness.ts', '--port', '0', '--empty'],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  )
  const lines = createInterface({ input: child.stdout! })
  const url = await new Promise<string>((resolve, reject) => {
    lines.on('line', (line) => {
      const match = line.match(/^YACHIYO_REMOTE_PAIRING_URL=(.+)$/)
      if (match) resolve(match[1]!)
    })
    child.once('exit', (code) => reject(new Error(`harness exited with ${code}`)))
  })
  return { url, stop: () => child.kill('SIGTERM') }
}

const harness = values['spawn-harness'] ? await spawnHarness() : null
const pairingUrl = values.url ?? harness?.url
if (!pairingUrl) {
  console.error('Pass --url <pairing url> or --spawn-harness.')
  process.exit(2)
}

try {
  await runRemoteScenario({
    pairingUrl,
    ...(values.endpoint ? { endpoint: values.endpoint } : {}),
    log: (line) => console.log(`✓ ${line}`)
  })
  console.log('remote end-to-end scenario passed')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  harness?.stop()
}
