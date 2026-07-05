/**
 * Dev-only spike entry (YACHIYO_SPIKE_UTILITY=1), forked as an Electron
 * utilityProcess. Verifies the Phase-2 hard points of the runtime process
 * extraction from inside a real utility process, and serves the results over
 * the same RPC layer + MessagePort transport the extraction will use.
 * Throwaway diagnostic code — not part of the app runtime.
 * See docs/yachiyo-runtime-process-extraction.md §5.
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'

import { resolveRuntimeNodeModule } from '@yachiyo/runtime/config/runtimeNodeModules'
import {
  messagePortMainTransport,
  type MessagePortMainLike
} from '@yachiyo/shared/rpc/messagePortMainTransport'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'

const require = createRequire(import.meta.url)

interface SpikeCheckResult {
  ok: boolean
  detail: string
}

interface SpikeSqliteClient {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): void
    get(...params: unknown[]): Record<string, unknown>
  }
  close(): void
}
type SpikeSqliteConstructor = new (path: string) => SpikeSqliteClient

const spikeChecks = {
  // Hard point 1: Chromium-stack fetch (system proxy, TLS) inside the utility
  // process — discord.js and provider traffic depend on it.
  async checkNetFetch(input: { url: string }): Promise<SpikeCheckResult> {
    const response = await net.fetch(input.url)
    const body = (await response.text()).slice(0, 60).replace(/\s+/g, ' ')
    return { ok: response.ok, detail: `status=${response.status} body="${body}"` }
  },

  // Hard point 2: the prebuilt better-sqlite3 binary loads under the same
  // Electron ABI, through the same resolver the runtime uses.
  checkSqlite(): SpikeCheckResult {
    const loaded = require(resolveRuntimeNodeModule('better-sqlite3', require)) as
      | SpikeSqliteConstructor
      | { default?: SpikeSqliteConstructor }
    const BetterSqlite3 = typeof loaded === 'function' ? loaded : loaded.default
    if (!BetterSqlite3) {
      throw new Error('better-sqlite3 loaded but exported no constructor')
    }
    const dbPath = join(tmpdir(), `yachiyo-spike-${process.pid}.db`)
    const db = new BetterSqlite3(dbPath)
    try {
      db.exec('CREATE TABLE spike (id INTEGER PRIMARY KEY, note TEXT)')
      db.prepare('INSERT INTO spike (note) VALUES (?)').run('hello')
      const row = db.prepare('SELECT note FROM spike WHERE id = 1').get()
      return { ok: row['note'] === 'hello', detail: `open+insert+select ok at ${dbPath}` }
    } finally {
      db.close()
      rmSync(dbPath, { force: true })
    }
  },

  // Hard point 3a: child processes (sync-core binary and the osascript
  // activity poll use this same mechanism).
  async checkChildProcess(): Promise<SpikeCheckResult> {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('echo', ['yachiyo-spike'])
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve(out.trim())
        } else {
          reject(new Error(`echo exited with code ${code}`))
        }
      })
    })
    return { ok: stdout === 'yachiyo-spike', detail: `spawn stdout="${stdout}"` }
  },

  // Hard point 3b: WebAssembly instantiation (memory recall's segmenter),
  // mirroring recallPolicy's dynamic import + tag usage.
  async checkJieba(): Promise<SpikeCheckResult> {
    const jieba = (await import('jieba-wasm')) as {
      tag: (text: string, hmm: boolean) => Array<{ word: string }>
    }
    const tokens = jieba.tag('八千代运行时进程抽离', true)
    return {
      ok: tokens.length > 0,
      detail: `tag → ${tokens
        .slice(0, 4)
        .map((token) => token.word)
        .join('/')}`
    }
  },

  // Hard point 4: bundle-relative assets (drizzle migrations, jieba wasm)
  // resolve from the utility entry's location — dev and packaged/asar.
  checkPaths(): SpikeCheckResult {
    const migrationsDir = join(__dirname, 'drizzle')
    const wasmFile = join(__dirname, 'jieba_rs_wasm_bg.wasm')
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    return {
      ok: existsSync(migrationsDir) && existsSync(wasmFile),
      detail: `__dirname=${__dirname} drizzle=${existsSync(migrationsDir)} wasm=${existsSync(
        wasmFile
      )} resourcesPath=${resourcesPath ?? 'unset'}`
    }
  }
}

process.parentPort.on('message', (event) => {
  const [port] = event.ports
  if (!port) {
    console.error('[spike-utility] control message carried no MessagePort')
    return
  }
  serveRpcTarget({
    transport: messagePortMainTransport(port as MessagePortMainLike),
    target: spikeChecks
  })
  console.log('[spike-utility] RPC server ready inside utility process')
})
