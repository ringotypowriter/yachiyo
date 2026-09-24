import { app, Notification, powerMonitor, powerSaveBlocker, safeStorage } from 'electron'
import { hostname } from 'node:os'

import {
  DEFAULT_REMOTE_CONFIG,
  type RemoteConfig,
  type SettingsConfig
} from '@yachiyo/shared/protocol'
import type { RemoteCommandRequest } from '@yachiyo/shared/remote/command'
import type { RpcMethods } from '@yachiyo/shared/rpc/rpcClient'
import { resolveYachiyoDataDir } from '@yachiyo/runtime/config/paths'
import type { YachiyoServer } from '@yachiyo/runtime/app/host/YachiyoServer'

import QRCode from 'qrcode'

import { handleYachiyoIpc, tapYachiyoEvents } from '../yachiyoGateway/ipc.ts'
import { IPC_CHANNELS } from '../yachiyoGateway/ipcChannels.ts'
import { createRemoteKeepAwake } from './keepAwake.ts'
import { defaultICloudDriveRoot, detectICloudDrive, MailboxWriter } from './mailboxWriter.ts'
import { PairingStore, type PairingRecord, type SecretBox } from './pairingStore.ts'
import { prunePairingQrImagesOnStartup, storePairingQrImage } from './pairingQrImage.ts'
import { handleRemoteCommand } from './remoteCommands.ts'
import { RemoteController } from './remoteController.ts'
import type { RemoteHostPort, RemoteServerPort } from './remoteFacade.ts'
import { defaultRemoteDirectories, RemoteService } from './remoteService.ts'
import { defaultTunnelPaths, TunnelSupervisor } from './tunnelSupervisor.ts'

const safeStorageSecretBox: SecretBox = {
  encrypt: (plaintext) => safeStorage.encryptString(plaintext.toString('base64')),
  decrypt: (ciphertext) => Buffer.from(safeStorage.decryptString(ciphertext), 'base64')
}

type GatewayServerPort = RemoteServerPort &
  RpcMethods<Pick<YachiyoServer, 'getConfig' | 'saveConfig'>>

export interface GatewayRemoteBinding {
  apply(config: RemoteConfig): void
  handleCommand(request: RemoteCommandRequest): Promise<unknown>
  createPairingUrl(): Promise<{ url: string; expiresAt: string }>
  listPairings(): Promise<PairingRecord[]>
  revokePairing(pairingId: string): Promise<boolean>
  stop(): Promise<void>
}

export interface RemotePairingQr {
  url: string
  expiresAt: string
  /** SVG markup of the QR code; rendered in main so the renderer needs no QR library. */
  svg: string
}

/** IPC for Settings > Remote. The pairing URL never leaves the settings window. */
export function registerRemoteIpc(binding: GatewayRemoteBinding): void {
  handleYachiyoIpc(IPC_CHANNELS.remoteStatus, () => binding.handleCommand({ action: 'status' }))
  handleYachiyoIpc(IPC_CHANNELS.remoteCreatePairing, async (): Promise<RemotePairingQr> => {
    const pairing = await binding.createPairingUrl()
    const svg = await QRCode.toString(pairing.url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1
    })
    return { ...pairing, svg }
  })
  handleYachiyoIpc(IPC_CHANNELS.remoteListPairings, () =>
    binding.handleCommand({ action: 'pairings-list' })
  )
  handleYachiyoIpc(IPC_CHANNELS.remoteRevokePairing, (input: { pairingId: string }) =>
    binding.revokePairing(input.pairingId)
  )
}

function deviceName(): string {
  return hostname().replace(/\.local$/i, '') || 'Mac'
}

/**
 * The gateway's single entry point to remote access. Nothing is constructed until remote is
 * enabled or a CLI/settings request needs it, so a disabled remote costs nothing.
 */
export function createGatewayRemoteBinding(deps: {
  /** Resolved per call: the runtime proxy is replaced when the utility process is reforked. */
  server: () => GatewayServerPort
  hostCall: (method: string, args: unknown[]) => Promise<unknown>
}): GatewayRemoteBinding {
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
  const yachiyoHome = resolveYachiyoDataDir()
  const pairingQrCleanup = prunePairingQrImagesOnStartup().then(
    () => null,
    (error: unknown) => {
      console.warn('Failed to prune prior remote pairing QR images:', error)
      return error
    }
  )
  const directories = defaultRemoteDirectories(yachiyoHome)
  const icloudRoot = defaultICloudDriveRoot()
  let tunnel: TunnelSupervisor | null = null
  let controller: RemoteController<RemoteService> | null = null
  let offlineStore: PairingStore | null = null

  const getTunnel = (): TunnelSupervisor =>
    (tunnel ??= new TunnelSupervisor({
      paths: defaultTunnelPaths(yachiyoHome),
      uid: process.getuid?.() ?? 501,
      log: (line) => console.log(line)
    }))

  const getController = (): RemoteController<RemoteService> =>
    (controller ??= new RemoteController<RemoteService>({
      createService: ({ listen, endpoints }) =>
        new RemoteService({
          ...directories,
          secretBox: safeStorageSecretBox,
          server,
          host,
          subscribe: tapYachiyoEvents,
          listen,
          deviceName,
          appVersion: app.getVersion(),
          endpoints,
          mailboxRoot: icloudRoot,
          onPaired: (record) => {
            if (!Notification.isSupported()) return
            new Notification({
              title: 'Yachiyo',
              body: `${record.deviceName} is now paired for remote access.`
            }).show()
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
      tunnel: getTunnel(),
      log: (line) => console.log(line)
    }))

  // Pairings stay manageable while the service is off; only one store instance writes at a time.
  const pairingStore = (): PairingStore =>
    controller?.service?.store ??
    (offlineStore ??= new PairingStore({
      directory: directories.directory,
      secretBox: safeStorageSecretBox
    }))

  const revokePairing = async (pairingId: string): Promise<boolean> => {
    const running = controller?.service
    if (running) return running.revoke(pairingId)
    const store = pairingStore()
    const known = (await store.list()).some((pairing) => pairing.pairingId === pairingId)
    if (!known) return false
    const secret = await store.mailboxSecret(pairingId)
    const identity = await store.loadIdentity()
    await new MailboxWriter({
      root: icloudRoot,
      store,
      remoteDeviceId: identity.remoteDeviceId
    }).remove(secret, pairingId)
    return store.revoke(pairingId)
  }

  return {
    apply: (config) => {
      if (!config.enabled && !controller) return
      void getController().apply(config)
    },
    handleCommand: (request) =>
      handleRemoteCommand(request, {
        getConfig: () => deps.server().getConfig(),
        saveConfig: (config: SettingsConfig) => deps.server().saveConfig(config),
        tunnel: getTunnel(),
        service: () => {
          const service = controller?.service
          if (!service) return null
          return {
            port: service.port,
            connections: service.status()?.connections ?? 0,
            endpoints: controller!.endpoints(
              controller!.config ?? DEFAULT_REMOTE_CONFIG,
              service.port
            )
          }
        },
        listPairings: () => pairingStore().list(),
        revokePairing,
        createPairingQr: async () => {
          const cleanupError = await pairingQrCleanup
          if (cleanupError) throw cleanupError
          const service = controller?.service
          if (!service) throw new Error('Enable remote access first.')
          const pairing = await service.createPairingUrl()
          const png = await QRCode.toBuffer(pairing.url, {
            errorCorrectionLevel: 'M',
            margin: 2
          })
          const imagePath = await storePairingQrImage({ png, expiresAt: pairing.expiresAt })
          return { imagePath, expiresAt: pairing.expiresAt }
        },
        icloudDrive: () => detectICloudDrive(icloudRoot)
      }),
    createPairingUrl: () => {
      const service = controller?.service
      if (!service) return Promise.reject(new Error('Enable remote access first.'))
      return service.createPairingUrl()
    },
    listPairings: () => pairingStore().list(),
    revokePairing,
    stop: async () => {
      await controller?.stop()
      controller = null
    }
  }
}
