// Synthetic payloads over real Electron transports. No user profile or native rebuild.
// Run: node --experimental-strip-types scripts/app-server-benchmark.mts [output.json]
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listenAppServer } from '../packages/runtime/src/appServer/listener.ts'
import { AppHostBridge } from '../packages/runtime/src/appServer/hostBridge.ts'
import { connectAppServer } from '../packages/runtime/src/appServer/connect.ts'
import { createRpcClient } from '../packages/shared/src/rpc/rpcClient.ts'
import { serveRpcTarget } from '../packages/shared/src/rpc/rpcServer.ts'
import {
  messagePortMainTransport,
  type MessagePortMainLike
} from '../packages/shared/src/rpc/messagePortMainTransport.ts'
import type { AppServerAddress } from '../packages/shared/src/appServer/protocol.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const rounds = 5
const modes = ['ipc-direct', 'ipc-utility', 'websocket']
const cases = [
  { name: 'small-echo', method: 'bench.echo', args: [{ value: 42 }], count: 5000, warmup: 500 },
  { name: 'snapshot-64k', method: 'bench.read', args: ['snapshot64'], count: 200, warmup: 20 },
  { name: 'snapshot-1m', method: 'bench.read', args: ['snapshot1024'], count: 50, warmup: 5 },
  { name: 'attachment-1m', method: 'bench.read', args: ['attachment1024'], count: 50, warmup: 5 },
  { name: 'typed-binary-1m', method: 'bench.read', args: ['binary1024'], count: 25, warmup: 3 },
  { name: 'concurrent-16', method: 'bench.echo', args: [{ value: 42 }], count: 10000, warmup: 1000 }
]

function snapshot(kib: number): object {
  return {
    thread: { id: 'benchmark-thread', title: 'Synthetic conversation' },
    messages: Array.from({ length: kib / 2 }, (_, index) => ({
      id: `message-${index}`,
      threadId: 'benchmark-thread',
      role: index % 2 === 0 ? 'user' : 'assistant',
      status: 'completed',
      content: 'Synthetic benchmark text. '.repeat(72),
      createdAt: '2026-01-01T00:00:00.000Z',
      textBlocks: [{ type: 'text', text: `block-${index}` }]
    }))
  }
}

const fixtures: Record<string, unknown> = {
  snapshot64: snapshot(64),
  snapshot1024: snapshot(1024),
  attachment1024: `data:application/octet-stream;base64,${Buffer.alloc(1024 * 1024, 42).toString('base64')}`,
  binary1024: new Uint8Array(1024 * 1024).fill(42)
}

function target(publish: (event: unknown) => void): Record<string, (...args: never[]) => unknown> {
  return {
    'bench.echo': (value: unknown) => value,
    'bench.read': (name: string) => {
      assert(Object.hasOwn(fixtures, name))
      return fixtures[name]
    },
    'bench.events': (input: { batch: string; count: number }) => {
      for (let sequence = 0; sequence < input.count; sequence++) {
        publish({
          type: 'message.delta',
          threadId: 'benchmark-thread',
          runId: 'benchmark-run',
          batch: input.batch,
          sequence,
          delta: 'x'.repeat(256)
        })
      }
      return input.count
    }
  }
}

async function runUtility(): Promise<void> {
  const parent = (
    process as unknown as {
      parentPort: { on(type: string, fn: (event: { ports: MessagePortMainLike[] }) => void): void }
    }
  ).parentPort
  parent.on('message', (event) => {
    const listeners = new Set<(event: unknown) => void>()
    serveRpcTarget({
      transport: messagePortMainTransport(event.ports[0]),
      target: target((value) => {
        for (const listener of listeners) listener(value)
      }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    })
  })
}

async function runServer(): Promise<void> {
  const listeners = new Set<(event: unknown) => void>()
  const server = await listenAppServer({
    host: new AppHostBridge(),
    target: target((event) => {
      for (const listener of listeners) listener(event)
    }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
  assert(process.send)
  process.send(server.address)
  process.once('SIGTERM', () => {
    void server.close().then(() => process.exit(0))
  })
}

const preloadSource = `
import {contextBridge,ipcRenderer} from 'electron'
import {createAppServerClient,openBrowserAppSocket} from './packages/shared/src/appServer/client.ts'
const listeners=new Set()
const client=createAppServerClient({
 resolveAddress:()=>ipcRenderer.invoke('bench:session'),connect:openBrowserAppSocket,
 onReset:()=>{throw new Error('Unexpected server reset')},
 onConnectionError:error=>console.error(error)
})
ipcRenderer.on('bench:event',(_event,value)=>{for(const fn of listeners)fn(value)})
client.subscribe(value=>{for(const fn of listeners)fn(value)})
contextBridge.exposeInMainWorld('benchmark',{
 call:(mode,method,args)=>mode==='websocket'?client.call(method,args):ipcRenderer.invoke(mode,method,args),
 subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}
})
window.addEventListener('unload',()=>client.close())
`

const rendererSource = `
function stats(samples,totalMs){
 const sorted=[...samples].sort((a,b)=>a-b)
 const percentile=p=>sorted[Math.ceil(sorted.length*p)-1]
 return {count:samples.length,totalMs,meanMs:samples.reduce((a,b)=>a+b,0)/samples.length,
  p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),operationsPerSecond:samples.length*1000/totalMs}
}
function check(name,result){
 if(name==='small-echo'||name==='concurrent-16'){
  if(result.value!==42)throw new Error('Echo changed')
 }else if(name==='attachment-1m'){
  const prefix='data:application/octet-stream;base64,'
  if(typeof result!=='string'||!result.startsWith(prefix)||!result.endsWith('Kg==')||
   result.length!==prefix.length+4*Math.ceil(1048576/3))throw new Error('Attachment payload changed')
 }else if(name==='typed-binary-1m'){
  if(!(result instanceof Uint8Array)||result.length!==1048576||result[0]!==42||result.at(-1)!==42)
   throw new Error('Binary payload changed')
 }else{
  const count=name==='snapshot-64k'?32:512
  if(result.messages.length!==count||result.messages.at(-1).id!=='message-'+(count-1))
   throw new Error('Snapshot changed')
 }
}
window.measure=async(mode,scenario,warmup=false)=>{
 const count=warmup?scenario.warmup:scenario.count
 const samples=[]
 let next=0,last
 const started=performance.now()
 async function worker(){
  while(next++<count){
   const start=performance.now()
   last=await window.benchmark.call(mode,scenario.method,scenario.args)
   samples.push(performance.now()-start)
  }
 }
 await Promise.all(Array.from({length:scenario.name==='concurrent-16'?16:1},worker))
 const totalMs=performance.now()-started
 check(scenario.name,last)
 return stats(samples,totalMs)
}
window.stream=async(mode,batch)=>{
 const count=1000
 let received=0,off
 const start=performance.now()
 const done=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Missing stream events')),10000)
  off=window.benchmark.subscribe(event=>{
   if(event.batch!==batch)return
   if(event.sequence!==received||event.delta.length!==256){
    clearTimeout(timeout);reject(new Error('Out-of-order stream event'));return
   }
   if(++received===count){clearTimeout(timeout);resolve(performance.now()-start)}
  })
 })
 try{
  const [totalMs]=await Promise.all([done,window.benchmark.call(mode,'bench.events',[{batch,count}])])
  return {count,totalMs,operationsPerSecond:count*1000/totalMs}
 }finally{off()}
}
true
`

async function runMain(directory: string): Promise<void> {
  const { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } =
    await import('electron')
  app.setPath('userData', join(directory, 'electron'))
  await app.whenReady()
  const entry = join(directory, 'benchmark.cjs')
  const child = utilityProcess.fork(entry, ['--benchmark-role=utility'], { stdio: 'pipe' })
  const daemon = spawn(process.execPath, [entry, '--benchmark-role=server'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  child.stderr?.pipe(process.stderr)
  daemon.stderr?.pipe(process.stderr)
  const { port1, port2 } = new MessageChannelMain()
  child.once('spawn', () => child.postMessage({}, [port1]))
  const utility = createRpcClient(messagePortMainTransport(port2))
  let admin: Awaited<ReturnType<typeof connectAppServer>> | undefined
  let window: Electron.BrowserWindow | undefined
  try {
    const [address] = (await once(daemon, 'message')) as [AppServerAddress]
    admin = await connectAppServer(address)
    ipcMain.handle('bench:session', () =>
      admin!.client.call('app.createClientSession', [{ origin: 'file://' }])
    )
    const direct = target((event) => window!.webContents.send('bench:event', event))
    ipcMain.handle('ipc-direct', (_event, method: string, args: never[]) => direct[method](...args))
    ipcMain.handle('ipc-utility', (_event, method: string, args: unknown[]) =>
      utility.call(method, args)
    )
    utility.subscribe((event) => window!.webContents.send('bench:event', event))
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(directory, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })
    await window.loadFile(join(directory, 'index.html'))
    await window.webContents.executeJavaScript(rendererSource)
    for (const scenario of cases) {
      for (const mode of modes) {
        await window.webContents.executeJavaScript(
          `window.measure(${JSON.stringify(mode)},${JSON.stringify(scenario)},true)`
        )
      }
    }
    // Fill the bounded replay journal before measuring its steady-state event cost.
    for (let burst = 0; burst < 4; burst++) {
      for (const mode of modes)
        await window.webContents.executeJavaScript(
          `window.stream(${JSON.stringify(mode)},'warmup')`
        )
    }
    const measurements: object[] = []
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index <= cases.length; index++) {
        const order = modes.map((_, offset) => modes[(round + index + offset) % modes.length])
        for (const mode of order) {
          const scenario = cases[index]
          const cpu = process.cpuUsage()
          const result = await window.webContents.executeJavaScript(
            scenario
              ? `window.measure(${JSON.stringify(mode)},${JSON.stringify(scenario)})`
              : `window.stream(${JSON.stringify(mode)},${JSON.stringify(`${round}-${mode}`)})`
          )
          const used = process.cpuUsage(cpu)
          measurements.push({
            round,
            mode,
            scenario: scenario?.name ?? 'events-1000',
            ...result,
            electronMainCpuMs: (used.user + used.system) / 1000
          })
        }
      }
      console.log(`Completed benchmark round ${round + 1}/${rounds}`)
    }
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          versions: process.versions,
          payloadBytes: {
            snapshot64: Buffer.byteLength(JSON.stringify(fixtures.snapshot64)),
            snapshot1024: Buffer.byteLength(JSON.stringify(fixtures.snapshot1024)),
            attachment1024: Buffer.byteLength(JSON.stringify(fixtures.attachment1024)),
            binary1024: (fixtures.binary1024 as Uint8Array).byteLength
          },
          measurements
        },
        null,
        2
      )
    )
  } finally {
    window?.destroy()
    utility.close()
    admin?.client.close()
    const utilityExit = once(child, 'exit')
    const daemonExit = once(daemon, 'exit')
    child.kill()
    daemon.kill('SIGTERM')
    await Promise.all([utilityExit, daemonExit])
    app.quit()
  }
}

async function runDriver(): Promise<void> {
  assert(process.argv.length <= 3, 'Usage: app-server-benchmark.mts [output.json]')
  const output = process.argv[2] ?? join(tmpdir(), 'yachiyo-app-server-benchmark.json')
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-bench-'))
  try {
    const { build } = await import('esbuild')
    await build({
      entryPoints: [source],
      outfile: join(directory, 'benchmark.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron', 'esbuild'],
      define: { 'import.meta.url': JSON.stringify(import.meta.url) }
    })
    await build({
      stdin: {
        contents: preloadSource,
        resolveDir: root,
        sourcefile: 'benchmark-preload.ts',
        loader: 'ts'
      },
      outfile: join(directory, 'preload.cjs'),
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      external: ['electron']
    })
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><title>Transport benchmark</title>'
    )
    const electron = spawn(
      require('electron'),
      [join(directory, 'benchmark.cjs'), '--benchmark-role=main', directory],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', YACHIYO_HOME: join(directory, 'data') },
        stdio: 'inherit'
      }
    )
    const timeout = setTimeout(() => electron.kill('SIGKILL'), 180_000)
    try {
      const [code] = await once(electron, 'exit')
      assert.equal(code, 0, 'Electron benchmark failed')
    } finally {
      clearTimeout(timeout)
    }
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    await writeFile(
      output,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          benchmarkSourceSha256: createHash('sha256')
            .update(await readFile(source))
            .digest('hex'),
          commit: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8'
          }).trim(),
          environment: {
            platform: process.platform,
            arch: process.arch,
            os: release(),
            cpu: cpus()[0]?.model,
            totalMemoryBytes: totalmem()
          },
          method:
            'Synthetic fixtures, real sandboxed renderer/contextBridge. ipc-utility reproduces the previous default renderer -> main -> utility MessagePort RPC path. websocket uses production authenticated AppServerClient/listenAppServer in a separate Electron-as-Node process. ipc-direct is a single-hop reference, not the previous default. Five rounds after warmup, rotating transport order; no DB, providers, user data, or native rebuild. Measurements exclude connection setup. Main CPU excludes renderer and server CPU. Events include the production replay journal, warmed to its bounded capacity. Large snapshots are responses, not echoed requests. Attachment format matches readAttachmentFile (base64 data URL); typed-binary is a codec probe, not that business method. Timings use renderer performance.now(), with roughly 0.1 ms resolution; compare round means for submillisecond RPCs.',
          rounds,
          cases,
          ...result
        },
        null,
        2
      )
    )
    console.log(`Results: ${output}`)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  }
}

async function run(): Promise<void> {
  const role = process.argv.find((arg) => arg.startsWith('--benchmark-role='))?.split('=')[1]
  if (role === 'utility') await runUtility()
  else if (role === 'server') await runServer()
  else if (role === 'main') await runMain(process.argv.at(-1)!)
  else await runDriver()
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
