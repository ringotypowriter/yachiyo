import { randomBytes } from 'node:crypto'

import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'

import type { RelayCredential } from './relayActivation.ts'
import { relayPhoneEndpoint } from './relayHost.ts'
import type { PairingStore } from './pairingStore.ts'

/** Per-phone grants live in the relay's memory; never log request bodies or bearer URLs. */
export class RelayAccess {
  readonly credential: RelayCredential
  private readonly store: PairingStore
  private readonly fetchImpl: typeof fetch
  constructor(credential: RelayCredential, store: PairingStore, fetchImpl: typeof fetch = fetch) {
    this.credential = credential
    this.store = store
    this.fetchImpl = fetchImpl
  }

  private async request(phone: string, method: 'PUT' | 'DELETE', key?: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.credential.server}/v1/hosts/${encodeURIComponent(this.credential.hostId)}/phones/${encodeURIComponent(phone)}`,
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
  async grant(phone: string, key: string): Promise<Extract<RemoteEndpoint, { kind: 'relay' }>> {
    await this.store.trackRelayGrant(phone, true)
    await this.request(phone, 'PUT', key)
    return relayPhoneEndpoint(this.credential.server, this.credential.hostId, phone, key)
  }
  async paired(pairingId: string): Promise<Extract<RemoteEndpoint, { kind: 'relay' }>> {
    const key = await this.store.relayKey(pairingId)
    return this.grant(pairingId, key)
  }
  endpoint(pairingId: string, key: string): Extract<RemoteEndpoint, { kind: 'relay' }> {
    return relayPhoneEndpoint(this.credential.server, this.credential.hostId, pairingId, key)
  }
  async restore(preserve?: Extract<RemoteEndpoint, { kind: 'relay' }>): Promise<void> {
    const pairings = await this.store.list()
    const known = new Set(pairings.map((pairing) => pairing.pairingId))
    const preservedPhone = preserve ? new URL(preserve.url).pathname.split('/')[4] : null
    if (preservedPhone) known.add(preservedPhone)
    for (const phone of await this.store.relayGrantIds()) {
      if (!known.has(phone)) await this.revoke(phone)
    }
    for (const pairing of pairings) await this.paired(pairing.pairingId)
    if (preserve && preservedPhone) await this.grant(preservedPhone, preserve.token)
  }
  async revoke(phone: string): Promise<void> {
    await this.request(phone, 'DELETE')
    await this.store.trackRelayGrant(phone, false)
  }
  async bootstrap(): Promise<Extract<RemoteEndpoint, { kind: 'relay' }>> {
    const phone = randomBytes(16).toString('hex')
    return this.grant(phone, randomBytes(32).toString('base64url'))
  }
}
