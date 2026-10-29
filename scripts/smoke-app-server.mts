import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppServerAddress } from '@yachiyo/shared/appServer/protocol'
import { connectAppServer } from '../packages/runtime/src/appServer/connect.ts'

// Uses the existing Electron build and native modules; never rebuilds dependencies.
const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'ya-'))
const home = join(directory, 'data')
const entryPath = resolve(root, 'apps/desktop/out/main/app-server.js')
const preload = resolve(root, 'apps/desktop/out/preload/index.js')
const fixture = join(directory, 'index.html')
const entry = join(directory, 'shell.cjs')
let address: AppServerAddress | undefined
let daemonPid: number | undefined
async function runShell(extraArgs: string[] = []): Promise<void> {
  const shell = spawn(
    require('electron'),
    [entry, '--yachiyo-plaintext-credentials', ...extraArgs],
    {
      env: { ...process.env, YACHIYO_HOME: home, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let output = ''
  shell.stdout.on('data', (chunk) => {
    output += chunk
  })
  shell.stderr.on('data', (chunk) => {
    output += chunk
  })
  const timeout = setTimeout(() => shell.kill('SIGKILL'), 45_000)
  try {
    const [code] = await once(shell, 'exit')
    assert.equal(code, 0, output)
    assert.match(output, /PASS sandboxed renderer/)
  } finally {
    clearTimeout(timeout)
  }
}
async function waitForServerExit(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error('App server did not exit after shutdown')
    await delay(50)
  }
}
try {
  await writeFile(fixture, '<!doctype html><title>App server smoke</title>')
  await build({
    stdin: {
      contents: `
import assert from 'node:assert/strict'
import {app,BrowserWindow,ipcMain} from 'electron'
import {createDesktopAppServer} from './apps/desktop/src/main/runtimeHost/desktopAppServer.ts'
import {prepareElectronProviderCredentials} from './apps/desktop/src/main/security/providerCredentials.ts'
app.setPath('userData',${JSON.stringify(join(directory, 'electron'))})
void main().catch(error=>{console.error(error);app.exit(1)})
async function main(){
 await app.whenReady()
 prepareElectronProviderCredentials(${JSON.stringify(join(home, 'config.toml'))})
 const server=createDesktopAppServer({entryPath:${JSON.stringify(entryPath)},isDev:true,startupReady:Promise.resolve(),mainServicesTarget:{},onConnectionChange:()=>{},onConnected:()=>{}})
 await server.ready()
 ipcMain.handle('yachiyo:app-server-session',()=>server.createClientSession('file://'))
 ipcMain.handle('yachiyo:pick-workspace-directory',()=>'/native-dialog-result')
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,preload:${JSON.stringify(preload)}}})
 try{
  await win.loadFile(${JSON.stringify(fixture)})
  const snapshot=await win.webContents.executeJavaScript('window.api.yachiyo.bootstrap()')
  assert.ok(Array.isArray(snapshot.threads))
  assert.ok(snapshot.streamCursor.instanceId)
  assert.equal(await win.webContents.executeJavaScript('window.api.yachiyo.pickWorkspaceDirectory()'),'/native-dialog-result')
  await server.reconnect()
  console.log('PASS sandboxed renderer, native IPC and host reconnect')
  if(process.argv.includes('--shutdown-server')) await server.shutdown()
 }finally{win.destroy();server.dispose();app.quit()}
}`,
      resolveDir: root,
      sourcefile: 'app-server-smoke.ts',
      loader: 'ts'
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  for (let launch = 0; launch < 2; launch++) {
    await runShell()
    address = JSON.parse(await readFile(join(home, 'app-server.json'), 'utf8'))
    const connection = await connectAppServer(address!)
    try {
      const status = (await connection.client.call('server.status', [])) as {
        pid: number
        nativeHost: boolean
      }
      assert.equal(status.nativeHost, false)
      if (daemonPid)
        assert.equal(status.pid, daemonPid, 'Reopening the shell must reuse the daemon')
      daemonPid = status.pid
    } finally {
      connection.client.close()
    }
  }
  console.log('PASS app server survives shell exit; reopening uses the same PID')
  await runShell(['--shutdown-server'])
  await assert.rejects(readFile(join(home, 'app-server.json')), { code: 'ENOENT' })
  address = undefined
  console.log('PASS attached shell shuts down the daemon before an update')
} catch (error) {
  console.error(await readFile(join(home, 'app-server.log'), 'utf8').catch(() => 'No server log'))
  throw error
} finally {
  try {
    address ??= JSON.parse(await readFile(join(home, 'app-server.json'), 'utf8'))
    const connection = await connectAppServer(address!)
    try {
      daemonPid ??= ((await connection.client.call('server.status', [])) as { pid: number }).pid
      const closed = new Promise<void>((resolve) => connection.transport.onClose(resolve))
      await connection.client.call('server.shutdown', [])
      await closed
      await waitForServerExit(daemonPid)
    } finally {
      connection.client.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('App server smoke cleanup failed:', error)
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
}
