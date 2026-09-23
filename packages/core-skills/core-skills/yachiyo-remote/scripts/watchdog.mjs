#!/usr/bin/env node
// Install from the bundled skill; no npm packages or app restart required.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { TunnelWatchdog } from './watchdog-policy.mjs'
import { observeTunnel, restartTunnel } from './watchdog-probes.mjs'

const exec = promisify(execFile)
const label = 'sh.ringo.yachiyo.tunnel-watchdog'
const home = homedir()
const dataHome = resolve(process.env.YACHIYO_HOME || join(home, '.yachiyo'))
const root = join(dataHome, 'helpers', 'tunnel-watchdog')
const statePath = join(root, 'status.json')
const lockPath = join(root, 'run.pid')
const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`)
const logPath = join(dataHome, 'logs', 'tunnel-watchdog.log')
const uid = process.getuid?.()
const target = `gui/${uid}/${label}`
const files = ['watchdog.mjs', 'watchdog-policy.mjs', 'watchdog-probes.mjs']

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }))
}

async function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export function serializeWrites(write) {
  let tail = Promise.resolve()
  return (value) => {
    const operation = tail.then(() => write(value))
    tail = operation.catch(() => {})
    return operation
  }
}

async function agentInfo() {
  try {
    const { stdout } = await exec('/bin/launchctl', ['print', target], { timeout: 5000 })
    return stdout
  } catch {
    return null
  }
}

async function agentPid() {
  return Number((await agentInfo())?.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function status() {
  const state = await readJson(statePath)
  const pid = await agentPid()
  const checked = state?.lastCheckedAt
  const checkedMs = typeof checked === 'number' ? checked : Date.parse(checked || '')
  return {
    installed: existsSync(plistPath),
    running: pid !== null && state?.pid === pid && state?.running === true,
    pid,
    sampleFresh:
      Number.isFinite(checkedMs) && Date.now() - checkedMs >= 0 && Date.now() - checkedMs < 120_000,
    logPath,
    state
  }
}

async function unload() {
  try {
    await exec('/bin/launchctl', ['bootout', target], { timeout: 10_000 })
  } catch {
    // An absent job is already unloaded. A surviving process is an error, not permission to duplicate it.
    if ((await agentInfo()) !== null) throw new Error('The existing watchdog did not unload.')
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await agentInfo()) === null) return
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error('The previous watchdog is still stopping; retry after it exits.')
}

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function install() {
  if (process.platform !== 'darwin' || process.versions.electron) {
    throw new Error('Run this installer with standalone Node.js on macOS, not Electron.')
  }
  for (const tool of ['/usr/bin/shlock', '/usr/bin/plutil', '/usr/bin/curl', '/bin/launchctl']) {
    if (!existsSync(tool)) throw new Error(`Required macOS utility not found: ${tool}`)
  }
  const source = dirname(fileURLToPath(import.meta.url))
  // Read and validate the whole bundle before stopping an existing healthy watcher.
  const contents = await Promise.all(files.map((file) => readFile(join(source, file))))
  const sourceHash = createHash('sha256').update(Buffer.concat(contents)).digest('hex')
  await unload()
  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
  await mkdir(dirname(plistPath), { recursive: true })
  for (const [index, file] of files.entries()) {
    const destination = join(root, file)
    const temporary = `${destination}.installing`
    await writeFile(temporary, contents[index], { mode: 0o600 })
    await rename(temporary, destination)
  }
  await atomicJson(join(root, 'installation.json'), {
    installedAt: new Date().toISOString(),
    source,
    sourceHash,
    node: realpathSync(process.execPath)
  })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(realpathSync(process.execPath))}</string><string>${xml(join(root, 'watchdog.mjs'))}</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string><key>YACHIYO_HOME</key><string>${xml(dataHome)}</string></dict>
<key>StandardOutPath</key><string>${xml(logPath)}</string><key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>\n`
  await writeFile(plistPath, plist, { mode: 0o600 })
  await exec('/usr/bin/plutil', ['-lint', plistPath], { timeout: 5000 })
  try {
    await exec('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath], { timeout: 10_000 })
  } catch (error) {
    if ((await agentInfo()) !== null) throw error
    // bootout/bootstrap can briefly race in launchd; one delayed retry, never sudo or an infinite loop.
    await new Promise((done) => setTimeout(done, 1500))
    await exec('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath], { timeout: 10_000 })
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await status()
    if (current.running && current.state?.sourceHash === sourceHash) return current
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`Watchdog launch was not confirmed. Inspect ${logPath}`)
}

async function run() {
  if (process.platform !== 'darwin') throw new Error('The managed watchdog requires macOS.')
  await mkdir(root, { recursive: true, mode: 0o700 })
  // BSD shlock provides PID-aware atomic ownership and stale-lock recovery.
  try {
    await exec('/usr/bin/shlock', ['-p', String(process.pid), '-f', lockPath], { timeout: 3000 })
  } catch {
    throw new Error('Another watchdog already owns this tunnel monitor.')
  }
  const installation = await readJson(join(root, 'installation.json'))
  const previousState = await readJson(statePath)
  const startedAt = new Date().toISOString()
  let lastObservation = null
  let previousLog = ''
  let busy = false
  let stopping = false
  const saveSnapshot = serializeWrites(async (snapshot) => {
    await atomicJson(statePath, snapshot)
    const signature = JSON.stringify([
      snapshot.reason,
      snapshot.haConnections,
      snapshot.lastRestartAt,
      snapshot.observation?.endpoint
    ])
    if (signature !== previousLog) {
      log('health', snapshot)
      previousLog = signature
    }
  })
  const watchdog = new TunnelWatchdog({
    budget: previousState?.policyBudget,
    observe: async (signal) => {
      lastObservation = await observeTunnel({ home, uid, signal })
      return lastObservation
    },
    restart: async (signal) => {
      // Persist the consumed attempt before launchctl, including if this process dies during restart.
      await publish()
      if (signal.aborted) throw signal.reason
      log('restart-requested', { target: 'sh.ringo.yachiyo.cloudflared' })
      await restartTunnel({ home, uid, signal })
      log('restart-issued')
    }
  })
  function publish() {
    const state = watchdog.status()
    const snapshot = {
      ...state,
      pid: process.pid,
      running: !stopping,
      startedAt,
      policyBudget: watchdog.checkpoint(),
      sourceHash: installation?.sourceHash ?? null,
      observation: lastObservation
    }
    return saveSnapshot(snapshot)
  }
  async function cycle() {
    if (busy || stopping) return
    busy = true
    try {
      await watchdog.tick()
      await publish()
    } catch (error) {
      log('check-error', { message: error.message })
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => {
    void cycle()
  }, 30_000)
  async function stop() {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    watchdog.stop()
    while (busy) await new Promise((done) => setTimeout(done, 50))
    await publish()
    if ((await readFile(lockPath, 'utf8').catch(() => '')).trim() === String(process.pid)) {
      await rm(lockPath, { force: true })
    }
    process.exit(0)
  }
  process.once('SIGTERM', () => {
    void stop().catch(() => process.exit(1))
  })
  process.once('SIGINT', () => {
    void stop().catch(() => process.exit(1))
  })
  log('started', { pid: process.pid, sourceHash: installation?.sourceHash ?? null })
  await cycle()
}

async function main() {
  switch (process.argv[2] || 'status') {
    case 'install':
      console.log(JSON.stringify(await install(), null, 2))
      break
    case 'run':
      await run()
      break
    case 'status':
      console.log(JSON.stringify(await status(), null, 2))
      break
    case 'check':
      console.log(
        JSON.stringify(
          await observeTunnel({ home, uid, signal: AbortSignal.timeout(20_000) }),
          null,
          2
        )
      )
      break
    case 'uninstall':
      await unload()
      await rm(plistPath, { force: true })
      console.log('Watchdog removed. The tunnel and pairings were not changed.')
      break
    default:
      throw new Error('Usage: node watchdog.mjs install|status|check|uninstall')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
