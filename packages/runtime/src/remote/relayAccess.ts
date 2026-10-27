import { randomBytes } from 'node:crypto'

import { YACHIYO_CONNECT_REGIONS, YACHIYO_CONNECT_SERVER } from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'

import type { RelayCredential } from './relayActivation.ts'
import { relayPhoneEndpoint } from './relayHost.ts'
import type { PairingStore } from './pairingStore.ts'

export type RelayEndpoint = Extract<RemoteEndpoint, { kind: 'relay' }>

/** The built-in service spans every region; any other origin is a single relay. */
export function relayRegions(server: string): readonly string[] {
  return server === YACHIYO_CONNECT_SERVER ? YACHIYO_CONNECT_REGIONS : [server]
}

/**
 * Per-phone grants live in each region's memory; never log request bodies or bearer URLs.
 * A phone holds one endpoint per region, all with the same key.
 */
export class RelayAccess {
  readonly credential: RelayCredential
  readonly servers: readonly string[]
  private readonly store: PairingStore
  private readonly fetchImpl: typeof fetch
  constructor(
    credential: RelayCredential,
    store: PairingStore,
    fetchImpl: typeof fetch = fetch,
    servers: readonly string[] = relayRegions(credential.server)
  ) {
    this.credential = credential
    this.store = store
    this.fetchImpl = fetchImpl
    this.servers = servers
  }

  private async request(
    server: string,
    phone: string,
    method: 'PUT' | 'DELETE',
    key?: string
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${server}/v1/hosts/${encodeURIComponent(this.credential.hostId)}/phones/${encodeURIComponent(phone)}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.credential.key}`,
          ...(key ? { 'Content-Type': 'application/json' } : {})
        },
        ...(key ? { body: JSON.stringify({ key }) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      }
    )
    if (!response.ok) throw new Error(`Relay phone registration failed (${response.status}).`)
  }

  /**
   * Registers the phone in `servers`. One reachable region is enough: a region that missed
   * the grant receives it from `restore` when its host socket reconnects.
   */
  async grant(
    phone: string,
    key: string,
    servers: readonly string[] = this.servers
  ): Promise<RelayEndpoint[]> {
    await this.store.trackRelayGrant(phone, true)
    const results = await Promise.allSettled(
      servers.map((server) => this.request(server, phone, 'PUT', key))
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure && results.every((result) => result.status === 'rejected')) throw failure.reason
    return this.endpoints(phone, key)
  }
  async paired(pairingId: string, servers?: readonly string[]): Promise<RelayEndpoint[]> {
    const key = await this.store.relayKey(pairingId)
    return this.grant(pairingId, key, servers)
  }
  endpoints(pairingId: string, key: string): RelayEndpoint[] {
    return this.servers.map((server) =>
      relayPhoneEndpoint(server, this.credential.hostId, pairingId, key)
    )
  }
  /** Re-registers current phones in `servers` (all regions by default) and drops stale grants. */
  async restore(preserve?: RelayEndpoint, servers?: readonly string[]): Promise<void> {
    const pairings = await this.store.list()
    const known = new Set(pairings.map((pairing) => pairing.pairingId))
    const preservedPhone = preserve ? new URL(preserve.url).pathname.split('/')[4] : null
    if (preservedPhone) known.add(preservedPhone)
    for (const phone of await this.store.relayGrantIds()) {
      // An unreachable region must not block the others; the grant stays tracked for a retry.
      if (!known.has(phone)) await this.revoke(phone).catch(() => undefined)
    }
    for (const pairing of pairings) await this.paired(pairing.pairingId, servers)
    if (preserve && preservedPhone) await this.grant(preservedPhone, preserve.token, servers)
  }
  /** The grant stays tracked, and is retried by `restore`, until every region has dropped it. */
  async revoke(phone: string): Promise<void> {
    const results = await Promise.allSettled(
      this.servers.map((server) => this.request(server, phone, 'DELETE'))
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
    await this.store.trackRelayGrant(phone, false)
  }
  async bootstrap(): Promise<RelayEndpoint[]> {
    const phone = randomBytes(16).toString('hex')
    return this.grant(phone, randomBytes(32).toString('base64url'))
  }
}
