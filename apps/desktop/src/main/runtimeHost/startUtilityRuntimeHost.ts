import { MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron'

import { messagePortMainTransport } from '@yachiyo/shared/rpc/messagePortMainTransport'
import {
  createRpcClient,
  createRpcMethodProxy,
  type RpcMethods
} from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'
import type { RpcClient } from '@yachiyo/shared/rpc/rpcClient'

export interface UtilityRuntimeHost<T extends object> {
  proxy: RpcMethods<T>
  client: RpcClient
  child: UtilityProcess
  dispose: () => void
}

/**
 * Forks the runtime-host utility process and wires one MessagePort pair for
 * bidirectional RPC: this side calls the runtime through `proxy`/`client`,
 * and serves `mainServicesTarget` (browser pages, activity summaries, …) for
 * the runtime's reverse calls.
 */
export function startUtilityRuntimeHost<T extends object>(input: {
  entryPath: string
  isDev: boolean
  mainServicesTarget: object
}): UtilityRuntimeHost<T> {
  const child = utilityProcess.fork(input.entryPath, [], {
    serviceName: 'yachiyo-runtime-host',
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(input.isDev ? { YACHIYO_RUNTIME_DEV: '1' } : {})
    }
  })

  const { port1, port2 } = new MessageChannelMain()
  child.once('spawn', () => {
    child.postMessage({ type: 'runtime:start' }, [port1])
  })

  const transport = messagePortMainTransport(port2)
  serveRpcTarget({ transport, target: input.mainServicesTarget })
  const client = createRpcClient(transport)

  return {
    proxy: createRpcMethodProxy<T>(client),
    client,
    child,
    dispose: () => {
      transport.close()
      child.kill()
    }
  }
}
