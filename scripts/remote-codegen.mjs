/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Regenerates remote protocol artifacts shared with the iOS client: the JSON Schema built from
// the zod definitions and the deterministic Noise/mailbox cross-language fixtures.
// `--check` fails when a committed file is stale (used by CI).
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants, createDeflateRaw, gzipSync } from 'node:zlib'

import { buildRemoteProtocolJsonSchema } from '../packages/shared/src/remote/jsonSchema.ts'
import {
  REMOTE_COMPRESSED_MESSAGE_TAG,
  REMOTE_STREAM_DEFLATE_MESSAGE_TAG
} from '../packages/shared/src/remote/wire.ts'
import {
  buildMailboxFixture,
  buildNoiseSessionFixtures
} from '../apps/desktop/src/main/remote/noise/crossLanguageFixtures.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const remoteDir = resolve(root, 'packages/shared/src/remote')
const check = process.argv.includes('--check')

const compressionRaw = JSON.stringify({
  kind: 'rpc:response',
  id: 7,
  ok: true,
  value: { content: 'Compression preserves UTF-8: 你好 🌸 café.\n'.repeat(40) }
})

// Consecutive stream events through ONE raw deflate context, each ended with Z_SYNC_FLUSH, so
// the phone's decoder is tested against the exact framing the desktop sends.
const streamDeflateRaw = [0, 1, 2, 3].map((index) =>
  JSON.stringify({
    kind: 'rpc:event',
    payload: {
      type: 'event',
      epoch: 'fixture-epoch',
      seq: index + 1,
      timestamp: '2026-09-25T00:00:00.000Z',
      event: {
        type: 'message.delta',
        threadId: '11111111-1111-4111-8111-111111111111',
        runId: '22222222-2222-4222-8222-222222222222',
        messageId: '33333333-3333-4333-8333-333333333333',
        delta: ['Hello', ', 世界 🌸', ' streaming', ' deltas.'][index]
      }
    }
  })
)

async function streamDeflateSegments(messages) {
  const deflate = createDeflateRaw({ level: 1 })
  const segments = []
  for (const message of messages) {
    const chunks = []
    const onData = (chunk) => chunks.push(chunk)
    deflate.on('data', onData)
    deflate.write(Buffer.from(message, 'utf8'))
    await new Promise((done) => deflate.flush(constants.Z_SYNC_FLUSH, done))
    deflate.off('data', onData)
    segments.push(
      Buffer.concat([Buffer.from([REMOTE_STREAM_DEFLATE_MESSAGE_TAG]), ...chunks]).toString(
        'base64'
      )
    )
  }
  deflate.close()
  return segments
}

const outputs = [
  ['generated/remote-protocol.schema.json', buildRemoteProtocolJsonSchema()],
  ['fixtures/noise-sessions.json', buildNoiseSessionFixtures()],
  ['fixtures/mailbox.json', buildMailboxFixture()],
  [
    'fixtures/remote-compression.json',
    {
      raw: compressionRaw,
      encodedBase64: Buffer.concat([
        Buffer.from([REMOTE_COMPRESSED_MESSAGE_TAG]),
        gzipSync(Buffer.from(compressionRaw), { level: 1 })
      ]).toString('base64')
    }
  ],
  [
    'fixtures/remote-stream-deflate.json',
    { raw: streamDeflateRaw, encodedBase64: await streamDeflateSegments(streamDeflateRaw) }
  ]
]

let stale = false
for (const [path, value] of outputs) {
  const outputPath = resolve(remoteDir, path)
  const next = `${JSON.stringify(value, null, 2)}\n`
  const current = await readFile(outputPath, 'utf8').catch(() => null)
  if (current === next) continue
  if (check) {
    console.error(`${relative(root, outputPath)} is stale. Run: pnpm run remote:codegen`)
    stale = true
    continue
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, next)
  console.log(`wrote ${relative(root, outputPath)}`)
}

if (stale) process.exit(1)
if (check) console.log('remote protocol artifacts are up to date')
