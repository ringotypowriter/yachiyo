import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const { build: buildVite } = await import(desktopRequire.resolve('vite'))
const { default: tailwindcss } = await import(desktopRequire.resolve('@tailwindcss/vite'))
await mkdir('.yachiyo', { recursive: true })
const directory = await mkdtemp(join(process.cwd(), '.yachiyo/generative-ui-smoke-'))
try {
  await mkdir(join(directory, 'electron-profile'))
  const fixture = join(directory, 'fixture.js')
  await buildVite({
    configFile: false,
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@renderer': join(process.cwd(), 'apps/desktop/src/renderer/src'),
        '@yachiyo/shared': join(process.cwd(), 'packages/shared/src')
      }
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: directory,
      emptyOutDir: false,
      lib: {
        entry: 'scripts/fixtures/generativeUi.tsx',
        name: 'GenerativeUiSmoke',
        formats: ['iife'],
        fileName: () => 'fixture.js',
        cssFileName: 'style'
      },
      cssCodeSplit: false,
      assetsInlineLimit: 100000
    }
  })
  const main = join(directory, 'smoke.cjs')
  await build({
    entryPoints: ['apps/desktop/src/preload/index.ts'],
    outfile: join(directory, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  await build({
    entryPoints: ['scripts/generative-ui-smoke.ts'],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [main, fixture, directory], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', YACHIYO_HOME: join(directory, 'home') }
    })
    const timeout = setTimeout(() => {
      console.error('Generative UI smoke exceeded its 120-second deadline')
      child.kill('SIGKILL')
    }, 120_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve(signal ? 1 : (code ?? 1))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
}
