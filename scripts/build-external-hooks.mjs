import { spawnSync } from 'node:child_process'
import process from 'node:process'

if (process.platform !== 'darwin') {
  console.log('Skipping macOS external hooks build on non-darwin platform.')
  process.exit(0)
}

const result = spawnSync(
  'swift',
  ['build', '-c', 'release', '--package-path', 'external-hooks/vision-ocr'],
  {
    cwd: process.cwd(),
    stdio: 'inherit'
  }
)

process.exit(result.status ?? 1)
