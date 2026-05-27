import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('Skipping macOS external hooks build on non-darwin platform.')
  process.exit(0)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const result = spawnSync(
  'swift',
  ['build', '-c', 'release', '--package-path', 'native/vision-ocr'],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
)

process.exit(result.status ?? 1)
