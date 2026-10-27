import { createRemoteHostOps } from '@yachiyo/runtime/app/host/remote/remoteHostOps'
import type { YachiyoServer } from '@yachiyo/runtime/app/host/YachiyoServer'

import type { RemoteHostPort, RemoteServerPort } from './remoteFacade.ts'

function promisify<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown
      if (typeof value !== 'function') return value
      return (...args: unknown[]) =>
        Promise.resolve().then(() => (value as (...a: unknown[]) => unknown).apply(object, args))
    }
  })
}

/**
 * Facade ports backed by an in-process YachiyoServer (legacy in-process runtime, tests, and
 * the fake-desktop harness). Calls go through a microtask so sync throws become rejections,
 * matching the RPC proxy used with the utility runtime.
 */
export function createInProcessRemotePorts(server: YachiyoServer): {
  server: RemoteServerPort
  host: RemoteHostPort
} {
  return {
    server: promisify(server) as unknown as RemoteServerPort,
    host: promisify(createRemoteHostOps(server)) as unknown as RemoteHostPort
  }
}
