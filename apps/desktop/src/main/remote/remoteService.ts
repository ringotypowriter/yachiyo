import { join } from 'node:path'

import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'
import { encodePairingUrl } from '@yachiyo/shared/remote/pairing'
import { REMOTE_PROTOCOL_VERSION } from '@yachiyo/shared/remote/protocolVersion'

import { createAttachmentStaging, type AttachmentStaging } from './attachmentStaging.ts'
import { REMOTE_CLOSE_CODES, RemoteConnection } from './remoteConnection.ts'
import { RemoteEventHub } from './remoteEventHub.ts'
import {
  createRemoteFacade,
  type RemoteFacade,
  type RemoteHostPort,
  type RemoteServerPort
} from './remoteFacade.ts'
import { startRemoteHttpServer, type RemoteHttpServer } from './remoteHttpServer.ts'
import { MailboxWriter } from './mailboxWriter.ts'
import {
  PairingStore,
  type DesktopIdentity,
  type PairingRecord,
  type SecretBox
} from './pairingStore.ts'

const UPLOAD_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export interface RemoteServiceOptions {
  /** `<YACHIYO_HOME>/remote`; holds identity.bin and pairings.json. */
  directory: string
  uploadsDirectory: string
  secretBox: SecretBox
  server: RemoteServerPort
  host: RemoteHostPort
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
  listen: { host: string; port: number }
  deviceName: () => string
  appVersion: string
  /** Current reachable endpoints for QR codes and mailboxes (tunnel, optional LAN). */
  endpoints: () => RemoteEndpoint[]
  /** iCloud Drive root for address-recovery mailboxes; null disables mailboxes. */
  mailboxRoot: string | null
  onPaired?(record: PairingRecord): void
  onPairingsChanged?(): void
  log(line: string): void
  now?: () => number
}

export interface RemoteServiceStatus {
  port: number
  connections: number
  hubRunning: boolean
  remoteDeviceId: string
}

/**
 * The desktop remote service: loopback WebSocket server, pairing store, event hub, and facade.
 * The hub subscribes to server events only while at least one pairing exists, so an enabled
 * but unpaired service costs nothing per event.
 */
export class RemoteService {
  private readonly options: RemoteServiceOptions
  readonly store: PairingStore
  private identity: DesktopIdentity | null = null
  private http: RemoteHttpServer | null = null
  private hub: RemoteEventHub | null = null
  private facade: RemoteFacade | null = null
  private attachments: AttachmentStaging | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private mailbox: MailboxWriter | null = null
  private readonly connections = new Set<RemoteConnection>()

  constructor(options: RemoteServiceOptions) {
    this.options = options
    this.store = new PairingStore({
      directory: options.directory,
      secretBox: options.secretBox,
      now: options.now
    })
  }

  get port(): number | null {
    return this.http?.port ?? null
  }

  get eventHub(): RemoteEventHub | null {
    return this.hub
  }

  async start(): Promise<void> {
    if (this.http) return
    this.identity = await this.store.loadIdentity()
    if (this.options.mailboxRoot) {
      this.mailbox = new MailboxWriter({
        root: this.options.mailboxRoot,
        store: this.store,
        remoteDeviceId: this.identity.remoteDeviceId,
        now: this.options.now
      })
    }
    this.attachments = createAttachmentStaging({ directory: this.options.uploadsDirectory })
    this.facade = createRemoteFacade({
      server: this.options.server,
      host: this.options.host,
      attachments: this.attachments,
      identity: () => ({
        remoteDeviceId: this.identity!.remoteDeviceId,
        deviceName: this.options.deviceName(),
        appVersion: this.options.appVersion
      }),
      epoch: () => this.ensureHub().epoch,
      audit: (line) => this.options.log(line)
    })
    if ((await this.store.list()).length > 0) this.ensureHub()
    this.http = await startRemoteHttpServer({
      host: this.options.listen.host,
      port: this.options.listen.port,
      onConnection: (socket) => this.accept(socket)
    })
    this.sweepTimer = setInterval(() => void this.attachments?.sweep(), UPLOAD_SWEEP_INTERVAL_MS)
    this.sweepTimer.unref()
    await this.publishEndpoints()
  }

  /** Writes the current endpoints to every pairing's mailbox (skipped when unchanged). */
  async publishEndpoints(pairingIds?: readonly string[]): Promise<void> {
    if (!this.mailbox) return
    try {
      await this.mailbox.publish(this.options.endpoints(), pairingIds)
    } catch (error) {
      this.options.log(`[remote] mailbox write failed: ${String(error)}`)
    }
  }

  async stop(): Promise<void> {
    for (const connection of [...this.connections]) {
      connection.close(REMOTE_CLOSE_CODES.shuttingDown, 'shutting down')
    }
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    await this.http?.close()
    this.http = null
    this.hub?.stop()
    this.hub = null
    await this.attachments?.dispose()
    this.attachments = null
    this.facade = null
    await this.store.flush()
  }

  status(): RemoteServiceStatus | null {
    if (!this.http || !this.identity) return null
    return {
      port: this.http.port,
      connections: this.connections.size,
      hubRunning: this.hub?.isRunning ?? false,
      remoteDeviceId: this.identity.remoteDeviceId
    }
  }

  /** Opens a five-minute pairing window and returns the QR code URL. */
  async createPairingUrl(): Promise<{ url: string; expiresAt: string }> {
    const identity = this.identity ?? (await this.store.loadIdentity())
    const endpoints = this.options.endpoints()
    if (endpoints.length === 0) {
      throw new Error('Remote has no reachable endpoint yet; start the tunnel or enable LAN.')
    }
    const offer = this.store.createOffer()
    const expiresAt = new Date(offer.expiresAt).toISOString()
    return {
      url: encodePairingUrl({
        v: REMOTE_PROTOCOL_VERSION,
        remoteDeviceId: identity.remoteDeviceId,
        deviceName: this.options.deviceName(),
        desktopKey: identity.keyPair.publicKey.toString('base64url'),
        token: offer.token.toString('base64url'),
        endpoints,
        expiresAt
      }),
      expiresAt
    }
  }

  async revoke(pairingId: string): Promise<boolean> {
    const known = (await this.store.list()).some((pairing) => pairing.pairingId === pairingId)
    const mailboxSecret = known ? await this.store.mailboxSecret(pairingId) : null
    const removed = await this.store.revoke(pairingId)
    if (mailboxSecret) await this.mailbox?.remove(mailboxSecret, pairingId)
    for (const connection of [...this.connections]) {
      if (connection.pairingId === pairingId) {
        connection.close(REMOTE_CLOSE_CODES.revoked, 'revoked')
      }
    }
    if ((await this.store.list()).length === 0) {
      this.hub?.stop()
      this.hub = null
    }
    if (removed) this.options.onPairingsChanged?.()
    return removed
  }

  private ensureHub(): RemoteEventHub {
    if (!this.hub) {
      this.hub = new RemoteEventHub({
        subscribe: this.options.subscribe,
        getThreadSummary: (threadId) =>
          this.options.host['host.remote.getThreadSummary']({ threadId }),
        onError: (error) => this.options.log(`[remote] event hub error: ${String(error)}`)
      })
      this.hub.start()
    }
    return this.hub
  }

  private accept(socket: ConstructorParameters<typeof RemoteConnection>[0]): void {
    if (!this.identity || !this.facade) {
      socket.close(REMOTE_CLOSE_CODES.shuttingDown, 'not ready')
      return
    }
    const connection = new RemoteConnection(socket, {
      identity: this.identity,
      store: this.store,
      facade: this.facade,
      hub: () => this.ensureHub(),
      onReady: (ready) => this.connections.add(ready),
      onPaired: (record) => {
        this.options.log(`[remote] paired ${record.deviceName} (${record.pairingId})`)
        this.options.onPaired?.(record)
        this.options.onPairingsChanged?.()
        void this.publishEndpoints([record.pairingId])
      },
      onClosed: (closed) => this.connections.delete(closed),
      log: this.options.log
    })
    this.connections.add(connection)
  }
}

export function defaultRemoteDirectories(yachiyoHome: string): {
  directory: string
  uploadsDirectory: string
} {
  const directory = join(yachiyoHome, 'remote')
  return { directory, uploadsDirectory: join(directory, 'uploads') }
}
