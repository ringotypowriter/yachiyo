import { app, Notification, powerMonitor, powerSaveBlocker, safeStorage } from 'electron'
import { hostname } from 'node:os'

import type { RemoteConfig, YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'
import { resolveYachiyoDataDir } from '@yachiyo/runtime/config/paths'

import { tapYachiyoEvents } from '../yachiyoGateway/ipc.ts'
import { createRemoteKeepAwake } from './keepAwake.ts'
import type { SecretBox } from './pairingStore.ts'
import { RemoteController } from './remoteController.ts'
import type { RemoteHostPort, RemoteServerPort } from './remoteFacade.ts'
import { defaultRemoteDirectories, RemoteService } from './remoteService.ts'

const safeStorageSecretBox: SecretBox = {
  encrypt: (plaintext) => safeStorage.encryptString(plaintext.toString('base64')),
  decrypt: (ciphertext) => Buffer.from(safeStorage.decryptString(ciphertext), 'base64')
}

interface GatewayRemoteDeps {
  /** Resolved per call: the runtime proxy is replaced when the utility process is reforked. */
  server: () => RemoteServerPort
  hostCall: (method: string, args: unknown[]) => Promise<unknown>
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
  tunnelEndpoint(): RemoteEndpoint | null
}

export interface GatewayRemoteBinding {
  apply(config: RemoteConfig): void
  stop(): Promise<void>
}

/** The gateway's single entry point to remote access; nothing is created until enabled. */
export function createGatewayRemoteBinding(deps: {
  server: () => RemoteServerPort
  hostCall: (method: string, args: unknown[]) => Promise<unknown>
}): GatewayRemoteBinding {
  let controller: RemoteController<RemoteService> | null = null
  const getController = (): RemoteController<RemoteService> => {
    controller ??= createGatewayRemoteController({
      ...deps,
      subscribe: tapYachiyoEvents,
      tunnelEndpoint: () => null
    })
    return controller
  }
  return {
    apply: (config) => {
      if (!config.enabled && !controller) return
      void getController().apply(config)
    },
    stop: async () => {
      await controller?.stop()
      controller = null
    }
  }
}

function deviceName(): string {
  return hostname().replace(/\.local$/i, '') || 'Mac'
}

/** Wires the remote controller to Electron (safeStorage, power, notifications) and the runtime. */
function createGatewayRemoteController(deps: GatewayRemoteDeps): RemoteController<RemoteService> {
  const server = new Proxy({} as RemoteServerPort, {
    get: (_target, method: string) => (input: unknown) =>
      (deps.server()[method as keyof RemoteServerPort] as (input: unknown) => Promise<unknown>)(
        input
      )
  })
  const host = new Proxy({} as RemoteHostPort, {
    get: (_target, op: string) => (input?: unknown) =>
      deps.hostCall(op.replace(/^host\./, ''), input === undefined ? [] : [input])
  })
  const directories = defaultRemoteDirectories(resolveYachiyoDataDir())

  return new RemoteController<RemoteService>({
    createService: ({ listen, endpoints }) =>
      new RemoteService({
        ...directories,
        secretBox: safeStorageSecretBox,
        server,
        host,
        subscribe: deps.subscribe,
        listen,
        deviceName,
        appVersion: app.getVersion(),
        endpoints,
        onPaired: (record) => {
          if (Notification.isSupported()) {
            new Notification({
              title: 'Yachiyo',
              body: `${record.deviceName} is now paired for remote access.`
            }).show()
          }
        },
        log: (line) => console.log(line)
      }),
    keepAwake: createRemoteKeepAwake({
      startBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
      stopBlocker: (id) => powerSaveBlocker.stop(id),
      isOnBattery: () => powerMonitor.isOnBatteryPower(),
      onPowerSourceChange: (listener) => {
        powerMonitor.on('on-ac', listener)
        powerMonitor.on('on-battery', listener)
        return () => {
          powerMonitor.off('on-ac', listener)
          powerMonitor.off('on-battery', listener)
        }
      }
    }),
    tunnelEndpoint: deps.tunnelEndpoint,
    log: (line) => console.log(line)
  })
}
