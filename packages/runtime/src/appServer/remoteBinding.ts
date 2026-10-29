import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import { hostname } from 'node:os'
import type { RemoteKeepAwake } from '../remote/keepAwake.ts'
import type { SecretBox } from '../remote/pairingStore.ts'

import type { YachiyoServer } from '@yachiyo/runtime/app/host/YachiyoServer'
import { DEFAULT_REMOTE_CONFIG, type RemoteConfig } from '@yachiyo/shared/protocol'
import type { RemoteCommandRequest } from '@yachiyo/shared/remote/command'

import QRCode from 'qrcode'

import {
  defaultICloudDriveRoot,
  detectICloudDrive,
  MailboxWriter
} from '@yachiyo/runtime/remote/mailboxWriter'
import {
  prunePairingQrImagesOnStartup,
  storePairingQrImage
} from '@yachiyo/runtime/remote/pairingQrImage'
import { PairingStore, type PairingRecord } from '@yachiyo/runtime/remote/pairingStore'
import { RelayAccess } from '@yachiyo/runtime/remote/relayAccess'
import { RelayActivation } from '@yachiyo/runtime/remote/relayActivation'
import type { RemoteHostPort, RemoteServerPort } from '@yachiyo/runtime/remote/remoteFacade'
import { defaultRemoteDirectories, RemoteService } from '@yachiyo/runtime/remote/remoteService'
import {
  createPlatformTunnelSupervisor,
  type RemoteTunnelSupervisor
} from '../remote/platformTunnelSupervisor.ts'
import { handleRemoteCommand, type RemoteCommandDeps } from '../remote/remoteCommands.ts'
import { RemoteController } from '../remote/remoteController.ts'

type GatewayServerPort = Pick<YachiyoServer, keyof RemoteServerPort | 'getConfig' | 'saveConfig'>

export interface AppRemoteBinding {
  apply(config: RemoteConfig): Promise<void>
  handleCommand(request: RemoteCommandRequest): Promise<unknown>
  createPairingUrl(): Promise<{ url: string; expiresAt: string }>
  listPairings(): Promise<PairingRecord[]>
  revokePairing(pairingId: string): Promise<boolean>
  stop(): Promise<void>
  activateRelay(code: string): Promise<unknown>
}

function deviceName(): string {
  return hostname().replace(/\.local$/i, '') || 'Yachiyo desktop'
}

interface AppRemoteBindingDeps {
  server: () => GatewayServerPort
  hostCall: (method: string, args: unknown[]) => Promise<unknown>
  secretBox: SecretBox
  version: string
  subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
  keepAwake: RemoteKeepAwake
  notify: (title: string, body: string) => void
  home: string
}

export function createAppRemoteBinding(deps: AppRemoteBindingDeps): AppRemoteBinding {
  const server = new Proxy({} as RemoteServerPort, {
    get: (_target, method: string) => async (input: unknown) =>
      (deps.server()[method as keyof RemoteServerPort] as (input: unknown) => Promise<unknown>)(
        input
      )
  })
  const host = new Proxy({} as RemoteHostPort, {
    get: (_target, op: string) => (input?: unknown) =>
      deps.hostCall(op.replace(/^host\./, ''), input === undefined ? [] : [input])
  })
  const yachiyoHome = deps.home
  const pairingQrCleanup = prunePairingQrImagesOnStartup().then(
    () => null,
    (error: unknown) => {
      console.warn('Failed to prune prior remote pairing QR images:', error)
      return error
    }
  )
  const directories = defaultRemoteDirectories(yachiyoHome)
  const activation = new RelayActivation(directories.directory, deps.secretBox)
  const icloudRoot = process.platform === 'darwin' ? defaultICloudDriveRoot() : null
  let tunnel: RemoteTunnelSupervisor | null = null
  let controller: RemoteController<RemoteService> | null = null
  let offlineStore: PairingStore | null = null

  const getTunnel = (): RemoteTunnelSupervisor =>
    (tunnel ??= createPlatformTunnelSupervisor({
      platform: process.platform,
      yachiyoHome,
      log: (line) => console.log(line)
    }))

  const getController = (): RemoteController<RemoteService> =>
    (controller ??= new RemoteController<RemoteService>({
      createService: ({ listen, endpoints, relayCredential }) =>
        new RemoteService({
          ...directories,
          secretBox: deps.secretBox,
          server,
          host,
          subscribe: deps.subscribe,
          listen,
          deviceName,
          appVersion: deps.version,
          endpoints,
          relayCredential,
          notificationsEnabled: async () =>
            (await deps.server().getConfig()).general?.notifyRunCompleted !== false,
          mailboxRoot: icloudRoot,
          onPaired: (record) =>
            deps.notify('Yachiyo', `${record.deviceName} is now paired for remote access.`),
          log: (line) => console.log(line)
        }),
      keepAwake: deps.keepAwake,
      tunnel: getTunnel(),
      relayCredential: (server) =>
        activation.load().then((saved) => (saved?.server === server ? saved : null)),
      log: (line) => console.log(line)
    }))

  // Pairings stay manageable while the service is off; only one store instance writes at a time.
  const pairingStore = (): PairingStore =>
    controller?.service?.store ??
    (offlineStore ??= new PairingStore({
      directory: directories.directory,
      secretBox: deps.secretBox
    }))

  const revokePairing = async (pairingId: string): Promise<boolean> => {
    const running = controller?.service
    if (running) return running.revoke(pairingId)
    const store = pairingStore()
    const known = (await store.list()).some((pairing) => pairing.pairingId === pairingId)
    if (!known) return false
    const secret = icloudRoot ? await store.mailboxSecret(pairingId) : null
    const removed = await store.revoke(pairingId)
    if (icloudRoot) {
      try {
        const identity = await store.loadIdentity()
        await new MailboxWriter({
          root: icloudRoot,
          store,
          remoteDeviceId: identity.remoteDeviceId
        }).remove(secret!, pairingId)
      } catch {
        console.warn('[remote] mailbox cleanup unavailable; local pairing removed')
      }
    }
    try {
      const credential = await activation.load()
      if (credential) await new RelayAccess(credential, store).revoke(pairingId)
    } catch {
      console.warn('[remote] relay revoke unavailable; local pairing removed')
    }
    return removed
  }

  const commandDeps = (): RemoteCommandDeps => ({
    getConfig: () => deps.server().getConfig(),
    saveConfig: (config) => deps.server().saveConfig(config),
    tunnel: getTunnel(),
    service: () => {
      const service = controller?.service
      return service
        ? {
            port: service.port,
            connections: service.status()?.connections ?? 0,
            relayConnected: service.relayConnected,
            endpoints: controller!.endpoints(
              controller!.config ?? DEFAULT_REMOTE_CONFIG,
              service.port
            )
          }
        : null
    },
    listPairings: () => pairingStore().list(),
    revokePairing,
    createPairingQr: async () => {
      const cleanupError = await pairingQrCleanup
      if (cleanupError) throw cleanupError
      const service = controller?.service
      if (!service) throw new Error('Enable remote access first.')
      const pairing = await service.createPairingUrl()
      const png = await QRCode.toBuffer(pairing.url, { errorCorrectionLevel: 'M', margin: 2 })
      const imagePath = await storePairingQrImage({ png, expiresAt: pairing.expiresAt })
      return { imagePath, expiresAt: pairing.expiresAt }
    },
    icloudDrive: () =>
      icloudRoot ? detectICloudDrive(icloudRoot) : Promise.resolve('unavailable'),
    relayActivation: () => activation.load(),
    activateRelay: async (code) => {
      await activation.redeem(code)
    }
  })

  return {
    apply: async (config) => {
      if (!config.enabled && !controller) return
      // An offline reader created before the service started holds a snapshot of pairings.
      // Recreate it after mode changes so an offline revoke never uses stale relay grants.
      offlineStore = null
      await getController().apply(config)
    },
    handleCommand: (request) => handleRemoteCommand(request, commandDeps()),
    createPairingUrl: () => {
      const service = controller?.service
      if (!service) return Promise.reject(new Error('Enable remote access first.'))
      return service.createPairingUrl()
    },
    listPairings: () => pairingStore().list(),
    revokePairing,
    activateRelay: (code) => handleRemoteCommand({ action: 'relay-activate', code }, commandDeps()),
    stop: async () => {
      await controller?.stop()
      controller = null
    }
  }
}
