/**
 * Dev-only prober (YACHIYO_SPIKE_UTILITY=1): forks the runtime-host spike as a
 * utilityProcess, runs the Phase-2 hard-point checks over RPC + MessagePort,
 * and reports the results to the console. Throwaway diagnostic code — not
 * part of the app runtime. See docs/yachiyo-runtime-process-extraction.md §5.
 */
import { join } from 'node:path'
import { MessageChannelMain, net, utilityProcess } from 'electron'

import { messagePortMainTransport } from '@yachiyo/shared/rpc/messagePortMainTransport'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'

const SPIKE_FETCH_URL = 'https://api.github.com/zen'
const CHECKS = [
  'checkNetFetch',
  'checkSqlite',
  'checkChildProcess',
  'checkJieba',
  'checkPaths'
] as const

export async function runSpikeUtilityProbe(): Promise<void> {
  // Baseline for the proxy comparison: same fetch from the main process.
  const baseline = await net
    .fetch(SPIKE_FETCH_URL)
    .then((response) => `status=${response.status}`)
    .catch((error: unknown) => `error=${error instanceof Error ? error.message : String(error)}`)
  console.log(`[spike-utility] main-process net.fetch baseline: ${baseline}`)

  const child = utilityProcess.fork(join(__dirname, 'runtime-host-spike.js'), [], {
    serviceName: 'yachiyo-runtime-host-spike',
    stdio: 'inherit'
  })
  child.on('exit', (code) => console.log(`[spike-utility] utility process exited (code=${code})`))
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()))

  const { port1, port2 } = new MessageChannelMain()
  child.postMessage({ type: 'spike:start' }, [port1])
  const client = createRpcClient(messagePortMainTransport(port2))

  for (const check of CHECKS) {
    const args = check === 'checkNetFetch' ? [{ url: SPIKE_FETCH_URL }] : []
    try {
      const result = await client.call(check, args)
      console.log(`[spike-utility] ${check}: ${JSON.stringify(result)}`)
    } catch (error) {
      console.error(`[spike-utility] ${check} FAILED:`, error)
    }
  }

  console.log('[spike-utility] all checks reported; shutting the spike down')
  client.close()
  child.kill()
}
