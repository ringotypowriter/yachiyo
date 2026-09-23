// Regenerates remote protocol artifacts shared with the iOS client: the JSON Schema built from
// the zod definitions and the deterministic Noise/mailbox cross-language fixtures.
// `--check` fails when a committed file is stale (used by CI).
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { buildRemoteProtocolJsonSchema } from '../packages/shared/src/remote/jsonSchema.ts'
import { REMOTE_COMPRESSED_MESSAGE_TAG } from '../packages/shared/src/remote/wire.ts'
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
