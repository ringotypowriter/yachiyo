import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import test from 'node:test'

import { DEFAULT_REMOTE_CONFIG } from '@yachiyo/shared/protocol'

import { WindowsTunnelSupervisor } from './windowsTunnelSupervisor.ts'

test('Windows quick tunnel starts cloudflared from PATH and restarts after exit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yachiyo-win-tunnel-'))
  const children: Array<EventEmitter & { killed: boolean; kill(): boolean }> = []
  const calls: Array<{ command: string; args: string[] }> = []
  const binary = win32.join('C:\\Tools', 'cloudflared.exe')
  const supervisor = new WindowsTunnelSupervisor({
    yachiyoHome: home,
    searchPath: 'C:\\Tools',
    fileExists: (path) => path === binary,
    spawn: (command, args) => {
      calls.push({ command, args })
      const emitter = new EventEmitter()
      const child = Object.assign(emitter, {
        killed: false,
        kill() {
          this.killed = true
          emitter.emit('exit', 0)
          return true
        }
      })
      children.push(child)
      return child
    },
    fetch: (async () => Response.json({ hostname: 'fox.trycloudflare.com' })) as typeof fetch
  })
  try {
    await supervisor.install({ mode: 'quick' }, { port: 47831, metricsPort: 47832 })
    const config = { ...DEFAULT_REMOTE_CONFIG, enabled: true, tunnel: 'quick' as const }
    supervisor.monitor(config, () => undefined)
    await supervisor.poll()
    assert.equal(supervisor.endpoint(config)?.url, 'wss://fox.trycloudflare.com/remote/v1')
    assert.equal((await supervisor.status(config)).agentRunning, true)
    assert.deepEqual(calls[0], {
      command: binary,
      args: [
        'tunnel',
        '--no-autoupdate',
        '--protocol',
        'http2',
        '--url',
        'http://127.0.0.1:47831',
        '--metrics',
        '127.0.0.1:47832'
      ]
    })
    children[0].emit('exit', 1)
    await supervisor.ensureRunning()
    assert.equal(calls.length, 2)
    await supervisor.uninstall()
    assert.equal(children[1].killed, true)
    assert.equal((await supervisor.status(config)).agentRunning, false)
    assert.equal(supervisor.endpoint(config), null)
  } finally {
    supervisor.stopMonitoring()
    await rm(home, { recursive: true, force: true })
  }
})

test('Windows named tunnel keeps a separate config and resumes on app startup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yachiyo-win-tunnel-'))
  const calls: string[][] = []
  const options = {
    yachiyoHome: home,
    searchPath: 'C:\\Tools',
    fileExists: (path: string) => path === win32.join('C:\\Tools', 'cloudflared.exe'),
    spawn: (command: string, args: string[]) => {
      calls.push([command, ...args])
      const child = new EventEmitter()
      return Object.assign(child, {
        kill: () => {
          child.emit('exit', 0)
          return true
        }
      })
    }
  }
  const first = new WindowsTunnelSupervisor(options)
  const second = new WindowsTunnelSupervisor(options)
  try {
    await first.install(
      { mode: 'named', tunnelName: 'yachiyo-win', hostname: 'win.example.com' },
      { port: 47831, metricsPort: 47832 }
    )
    assert.match(await readFile(first.namedConfigPath, 'utf8'), /hostname: win.example.com/)
    first.stopMonitoring()
    second.monitor({ ...DEFAULT_REMOTE_CONFIG, enabled: true, tunnel: 'named' }, () => undefined)
    await second.ensureRunning()
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].slice(-2), ['run', 'yachiyo-win'])
  } finally {
    first.stopMonitoring()
    second.stopMonitoring()
    await rm(home, { recursive: true, force: true })
  }
})

test('replacement waits for the previous process to release its port', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yachiyo-win-tunnel-'))
  const calls: string[] = []
  let oldChild: EventEmitter | null = null
  const supervisor = new WindowsTunnelSupervisor({
    yachiyoHome: home,
    searchPath: 'C:\\Tools',
    fileExists: (path) => path === win32.join('C:\\Tools', 'cloudflared.exe'),
    spawn: () => {
      calls.push('spawn')
      const child = new EventEmitter()
      oldChild = child
      return Object.assign(child, {
        kill: () => {
          calls.push('kill')
          return true
        }
      })
    }
  })
  try {
    await supervisor.install({ mode: 'quick' }, { port: 47831, metricsPort: 47832 })
    const replacing = supervisor.install({ mode: 'quick' }, { port: 47831, metricsPort: 47832 })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, ['spawn', 'kill'])
    oldChild!.emit('exit', 0)
    await replacing
    assert.deepEqual(calls, ['spawn', 'kill', 'spawn'])
  } finally {
    supervisor.stopMonitoring()
    await rm(home, { recursive: true, force: true })
  }
})

test('Windows tunnel reports the platform install command and preserves user config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yachiyo-win-tunnel-'))
  const binary = win32.join('C:\\Tools', 'cloudflared.exe')
  const absent = new WindowsTunnelSupervisor({
    yachiyoHome: home,
    searchPath: '',
    fileExists: () => false
  })
  const conflicting = new WindowsTunnelSupervisor({
    yachiyoHome: home,
    searchPath: 'C:\\Tools',
    fileExists: (path) => path === binary || path.endsWith('config.yaml')
  })
  try {
    await assert.rejects(
      absent.install({ mode: 'quick' }, { port: 1, metricsPort: 2 }),
      /winget install/
    )
    await assert.rejects(
      conflicting.install({ mode: 'quick' }, { port: 1, metricsPort: 2 }),
      /named tunnel/
    )
  } finally {
    absent.stopMonitoring()
    conflicting.stopMonitoring()
    await rm(home, { recursive: true, force: true })
  }
})
