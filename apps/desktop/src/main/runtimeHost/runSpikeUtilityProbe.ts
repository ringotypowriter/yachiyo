/**
 * Dev-only prober (YACHIYO_SPIKE_UTILITY=1): forks the runtime-host spike as a
 * utilityProcess, runs the Phase-2 hard-point checks over RPC + MessagePort,
 * and reports the results to the console. Throwaway diagnostic code — not
 * part of the app runtime. See docs/yachiyo-runtime-process-extraction.md §5.
 */
import { MessageChannelMain, net, utilityProcess } from 'electron'

import { messagePortMainTransport } from '@yachiyo/shared/rpc/messagePortMainTransport'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'

// Connectivity-check endpoint: always 204, no body, no rate limiting.
const SPIKE_FETCH_URL = 'https://www.gstatic.com/generate_204'
const CHECKS = [
  'checkNetFetch',
  'checkSqlite',
  'checkChildProcess',
  'checkJieba',
  'checkPaths'
] as const

/**
 * @param spikeEntryPath Absolute path to the built runtime-host-spike bundle.
 *   Resolved by the caller in the main entry: this module is code-split into
 *   chunks/, so its own __dirname points one directory too deep.
 */
export async function runSpikeUtilityProbe(spikeEntryPath: string): Promise<void> {
  // Baseline for the proxy comparison: same fetch from the main process.
  const baseline = await net
    .fetch(SPIKE_FETCH_URL)
    .then((response) => `status=${response.status}`)
    .catch((error: unknown) => `error=${error instanceof Error ? error.message : String(error)}`)
  console.log(`[spike-utility] main-process net.fetch baseline: ${baseline}`)

  const child = utilityProcess.fork(spikeEntryPath, [], {
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
