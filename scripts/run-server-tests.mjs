import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { collectServerTestFiles } from './server-test-collector.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const basket = process.argv.includes('--native') ? 'native' : 'node'
const testRoots = process.argv.slice(2).filter((argument) => argument !== '--native')
const testsDirs = testRoots.length > 0 ? testRoots.map((root) => resolve(repoRoot, root)) : []

const testFiles = testsDirs.flatMap((directory) => collectServerTestFiles(directory, basket)).sort()
if (testFiles.length === 0) {
  console.error(`No ${basket} server tests found.`)
  process.exit(basket === 'native' ? 1 : 0)
}

console.log(`Collected ${testFiles.length} ${basket} server test file(s):`)
for (const testFile of testFiles) {
  console.log(`- ${relative(repoRoot, testFile)}`)
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
