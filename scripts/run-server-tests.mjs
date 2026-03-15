import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const rootDir = process.cwd()
const testsDir = resolve(rootDir, 'src/main/yachiyo-server')

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      return collectTestFiles(fullPath)
    }

    if (!entry.isFile()) {
      return []
    }

    if (!entry.name.endsWith('.test.ts') || entry.name.endsWith('.native.test.ts')) {
      return []
    }

    return [fullPath]
  })
}

const testFiles = collectTestFiles(testsDir).sort()
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...testFiles], {
  cwd: rootDir,
  stdio: 'inherit'
})

process.exit(result.status ?? 1)
