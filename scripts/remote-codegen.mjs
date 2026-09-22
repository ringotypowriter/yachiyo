// Regenerates the remote protocol JSON Schema from the zod definitions.
// `--check` fails when the committed output is stale (used by CI).
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildRemoteProtocolJsonSchema } from '../packages/shared/src/remote/jsonSchema.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = resolve(root, 'packages/shared/src/remote/generated/remote-protocol.schema.json')
const check = process.argv.includes('--check')

const next = `${JSON.stringify(buildRemoteProtocolJsonSchema(), null, 2)}\n`
const current = await readFile(outputPath, 'utf8').catch(() => null)

if (check) {
  if (current !== next) {
    console.error(`${outputPath} is stale. Run: pnpm run remote:codegen`)
    process.exit(1)
  }
  console.log('remote protocol schema is up to date')
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, next)
  console.log(`wrote ${outputPath}`)
}
