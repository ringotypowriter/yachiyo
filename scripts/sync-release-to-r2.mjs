/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Mirrors electron-builder artifacts to the R2 release mirror and prunes old
// versions. Layout: <bucket>/stable keeps 1 version, <bucket>/nightly keeps 5,
// each with its own latest-mac.yml. Skips silently when R2 secrets are absent
// so forks and secret-less runs stay green.

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const KEEP_PER_CHANNEL = { stable: 1, nightly: 5 }
const MANIFEST = 'latest-mac.yml'
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?/

/** @type {(keys: string[], keep: number) => string[]} */
export function selectStaleReleaseKeys(keys, keep) {
  /** @type {Map<string, { sortKey: number[], keys: string[] }>} */
  const versions = new Map()
  for (const key of keys) {
    const match = key.match(VERSION_PATTERN)
    if (!match) continue
    const version = match[0]
    const entry = versions.get(version) ?? {
      sortKey: [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)],
      keys: []
    }
    entry.keys.push(key)
    versions.set(version, entry)
  }

  const newestFirst = [...versions.values()].sort((a, b) => {
    for (let i = 0; i < a.sortKey.length; i++) {
      if (a.sortKey[i] !== b.sortKey[i]) return b.sortKey[i] - a.sortKey[i]
    }
    return 0
  })
  return newestFirst.slice(keep).flatMap((entry) => entry.keys)
}

function parseArgs(argv) {
  const args = { channel: '', dist: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--channel') args.channel = argv[++i] ?? ''
    else if (argv[i] === '--dist') args.dist = argv[++i] ?? ''
  }
  if (!(args.channel in KEEP_PER_CHANNEL) || !args.dist) {
    throw new Error('Usage: sync-release-to-r2.mjs --channel <stable|nightly> --dist <dir>')
  }
  return args
}

function main() {
  const { channel, dist } = parseArgs(process.argv.slice(2))

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    console.log('R2 mirror secrets not configured; skipping mirror sync.')
    return
  }

  const awsEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: 'auto',
    // R2 rejects the streaming checksums newer aws-cli versions send by default
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required'
  }
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`

  const aws = (args) =>
    execFileSync('aws', [...args, '--endpoint-url', endpoint], {
      env: awsEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })

  const artifacts = readdirSync(dist).filter(
    (name) => name.endsWith('.zip') || name.endsWith('.zip.blockmap')
  )
  if (artifacts.length === 0 || !readdirSync(dist).includes(MANIFEST)) {
    throw new Error(`No release artifacts or ${MANIFEST} found in ${dist}`)
  }

  // Upload binaries first, the manifest last, so the feed never points at a
  // file that is not there yet.
  for (const name of [...artifacts, MANIFEST]) {
    console.log(`Uploading ${name} -> ${channel}/${name}`)
    aws(['s3', 'cp', join(dist, name), `s3://${R2_BUCKET}/${channel}/${name}`])
  }

  const listed = aws([
    's3api',
    'list-objects-v2',
    '--bucket',
    R2_BUCKET,
    '--prefix',
    `${channel}/`,
    '--query',
    'Contents[].Key',
    '--output',
    'json'
  ])
  const keys = JSON.parse(listed || 'null') ?? []

  for (const key of selectStaleReleaseKeys(keys, KEEP_PER_CHANNEL[channel])) {
    console.log(`Pruning ${key}`)
    aws(['s3', 'rm', `s3://${R2_BUCKET}/${key}`])
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
