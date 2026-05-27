/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoots = process.argv.slice(2)
const testsDirs = testRoots.length > 0 ? testRoots.map((root) => resolve(repoRoot, root)) : []

/** @type {(directory: string) => string[]} */
const collectTestFiles = (directory) => {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      return collectTestFiles(fullPath)
    }

    if (!entry.isFile()) {
      return []
    }

    if (
      !entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.native.test.ts') ||
      entry.name.endsWith('.mac.test.ts')
    ) {
      return []
    }

    return [fullPath]
  })
}

const testFiles = testsDirs.flatMap(collectTestFiles).sort()
if (testFiles.length === 0) {
  console.log('No server tests found.')
  process.exit(0)
}

const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', '--test-concurrency=1', ...testFiles],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
)

process.exit(result.status ?? 1)
