import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
await mkdir('.yachiyo', { recursive: true })
const directory = await mkdtemp(join(process.cwd(), '.yachiyo/browser-runner-'))
try {
  const fixture = join(directory, 'fixture.js')
  await build({
    entryPoints: ['scripts/fixtures/browserForm.tsx'],
    outfile: fixture,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  for (const script of ['browser-automation-smoke', 'browser-frame-probe']) {
    const main = join(directory, `${script}.cjs`)
    await build({
      entryPoints: [`scripts/${script}.ts`],
      outfile: main,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron', 'esbuild']
    })
    const code = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [main, fixture], {
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
      })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        resolve(signal ? 1 : (code ?? 1))
      })
    })
    if (code) {
      process.exitCode = code
      break
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
}
