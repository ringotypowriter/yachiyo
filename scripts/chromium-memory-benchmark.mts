// Isolated highlighting in a real Chromium renderer; this is not whole-app memory.
// Run: node --experimental-strip-types scripts/chromium-memory-benchmark.mts [output.json]
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const { build } = require('esbuild')
const codeModule = join(root, 'apps/desktop/node_modules/@streamdown/code/dist/index.js')
const directory = await mkdtemp(join(tmpdir(), 'yachiyo-chromium-memory-'))
const output = process.argv[2] ?? join(tmpdir(), 'yachiyo-chromium-memory.json')

const rendererSource = `
import {code} from ${JSON.stringify(codeModule)}
function highlight(source) {
  return new Promise(resolve => {
    const cached = code.highlight({code:source, language:'typescript', themes:code.getThemes()}, resolve)
    if (cached) resolve(cached)
  })
}
function check(source, result) {
  const restored = result.tokens.map(line => line.map(token => token.content).join('')).join('\\n')
  if (restored !== source) throw new Error('Highlight changed source')
}
window.benchmark = {
  async warmup() { await highlight('const warmup = 1') },
  async stream() {
    const start = performance.now()
    let source = ''
    for (let step = 0; step < 200; step++) {
      for (let row = 0; row < 4; row++) {
        const index = step * 4 + row
        source += 'const value'+index+' = {number: '+index+', enabled: true, label: "row'+index+'"}\\n'
      }
      check(source, await highlight(source))
    }
    return {updates:200, characters:source.length, elapsedMs:performance.now()-start}
  },
  async history() {
    const start = performance.now()
    for (let index = 0; index < 200; index++) {
      const source = 'const history'+index+' = "different block '+index+'"\\n'
        + 'const item = {enabled: true, count: 42}\\n'.repeat(100)
      check(source, await highlight(source))
    }
    return {blocks:200, elapsedMs:performance.now()-start}
  }
}
`

try {
  await build({
    stdin: { contents: rendererSource, resolveDir: root, loader: 'ts' },
    outdir: join(directory, 'renderer'),
    bundle: true,
    format: 'esm',
    splitting: true,
    platform: 'browser',
    entryNames: 'benchmark'
  })
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><title>Chromium memory</title><script type="module" src="./renderer/benchmark.js"></script>'
  )
  await writeFile(
    join(directory, 'preload.cjs'),
    `const {contextBridge} = require('electron')
contextBridge.exposeInMainWorld('metrics', {
  read: async () => ({
    memory: await process.getProcessMemoryInfo(),
    heap: process.getHeapStatistics(),
    blink: process.getBlinkMemoryInfo()
  })
})`
  )
  await writeFile(
    join(directory, 'main.cjs'),
    `const {app, BrowserWindow} = require('electron')
const {writeFileSync} = require('node:fs')
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))})
void (async () => {
  await app.whenReady()
  const win = new BrowserWindow({
    show:false,
    webPreferences:{sandbox:true, contextIsolation:true, preload:${JSON.stringify(join(directory, 'preload.cjs'))}}
  })
  try {
    await win.loadFile(${JSON.stringify(join(directory, 'index.html'))})
    win.webContents.debugger.attach('1.3')
    const samples = []
    async function sample(stage) {
      const natural = await win.webContents.executeJavaScript('window.metrics.read()')
      await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage')
      const retained = await win.webContents.executeJavaScript('window.metrics.read()')
      const dom = await win.webContents.debugger.sendCommand('Memory.getDOMCounters')
      samples.push({stage, natural, retained, dom, processes:app.getAppMetrics()})
      console.log(stage, JSON.stringify(retained))
    }
    await sample('module-loaded')
    await win.webContents.executeJavaScript('window.benchmark.warmup()')
    await sample('highlighter-ready')
    const stream = await win.webContents.executeJavaScript('window.benchmark.stream()')
    await sample('after-200-stream-updates')
    const history = await win.webContents.executeJavaScript('window.benchmark.history()')
    await sample('after-200-more-code-blocks')
    writeFileSync(${JSON.stringify(join(directory, 'results.json'))}, JSON.stringify({versions:process.versions, samples, stream, history}))
  } finally {
    win.destroy()
    app.quit()
  }
})().catch(error => { console.error(error); app.exit(1) })`
  )
  const child = spawn(require('electron'), [join(directory, 'main.cjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'inherit'
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, 'Electron memory benchmark failed')
  } finally {
    clearTimeout(timeout)
  }
  const data = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
  await writeFile(
    output,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        benchmarkSha256: createHash('sha256')
          .update(await readFile(import.meta.filename))
          .digest('hex'),
        codeModuleSha256: createHash('sha256')
          .update(await readFile(codeModule))
          .digest('hex'),
        environment: {
          platform: process.platform,
          arch: process.arch,
          release: release(),
          cpu: cpus()[0]?.model,
          totalMemoryBytes: totalmem()
        },
        method:
          'Sandboxed Electron renderer with the installed @streamdown/code plugin. ' +
          '200 growing TypeScript updates ending at 800 lines, then 200 independent 101-line code blocks. ' +
          'Memory and heap fields are KiB. Each stage records natural memory and memory retained after forced GC. ' +
          'Isolated profile, no native rebuild or user data. Measures highlighting, not whole-app memory.',
        ...data
      },
      null,
      2
    )
  )
  console.log(output)
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
}
