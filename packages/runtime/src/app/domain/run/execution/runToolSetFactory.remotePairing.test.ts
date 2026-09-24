import assert from 'node:assert/strict'
import test from 'node:test'

import { canOfferRemotePairingQr } from './runToolSetFactory.ts'

test('pairing tool is available only to private local runs in local threads', () => {
  const local = {
    isLocalRunTrigger: true,
    isExternalChannel: false,
    source: 'local'
  }
  assert.equal(canOfferRemotePairingQr(local), true)
  assert.equal(canOfferRemotePairingQr({ ...local, source: undefined }), true)
  assert.equal(canOfferRemotePairingQr({ ...local, source: 'telegram' }), false)
  assert.equal(canOfferRemotePairingQr({ ...local, isExternalChannel: true }), false)
  assert.equal(canOfferRemotePairingQr({ ...local, isLocalRunTrigger: false }), false)
  assert.equal(canOfferRemotePairingQr({ ...local, channelGroupId: 'group' }), false)
  assert.equal(
    canOfferRemotePairingQr({
      ...local,
      source: undefined,
      channelUserId: 'user'
    }),
    false
  )
})
