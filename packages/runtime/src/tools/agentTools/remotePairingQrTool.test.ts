import assert from 'node:assert/strict'
import test from 'node:test'

import { createRemotePairingQrTool } from './remotePairingQrTool.ts'

test('pairing tool returns a short asset image reference with encoded spaces', async () => {
  const imagePath = '/private/Yachiyo Data (local)/pairing qr/abc.png'
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  const result = await createRemotePairingQrTool(async () => ({
    imagePath,
    expiresAt
  })).execute?.({}, { toolCallId: 'test', messages: [], context: {} })
  assert.match(String(result), /^Scan in Yachiyo on iPhone before /)
  assert.match(
    String(result),
    /!\[Pair iPhone with this Mac\]\(yachiyo-asset:\/\/local\/\?p=%2Fprivate%2FYachiyo%20Data%20%28local%29%2Fpairing%20qr%2Fabc\.png\)/
  )
  assert.doesNotMatch(
    String(result),
    /data:image|base64|yachiyo:\/\/|https?:\/\/|\/private\/Yachiyo/
  )
})

test('pairing tool refuses an expired image', async () => {
  const qr = {
    imagePath: '/private/pairing.png',
    expiresAt: new Date(0).toISOString()
  }
  await assert.rejects(
    Promise.resolve(
      createRemotePairingQrTool(async () => qr).execute?.(
        {},
        { toolCallId: 'test', messages: [], context: {} }
      )
    ),
    /expired/
  )
})
