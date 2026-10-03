import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import electron from 'electron'
import { build } from 'esbuild'
import { createElectronBrowserAutomationService } from '../packages/runtime/src/services/browserAutomation/electronBrowserAutomationService.ts'

const { app, BrowserWindow, ipcMain } = electron
app.setActivationPolicy('prohibited')
app.on('window-all-closed', () => {})

async function run(): Promise<void> {
  await app.whenReady()
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-browser-panel-'))
  const artifact = resolve('.yachiyo/artifacts/browser-panel-smoke.png')
  const service = createElectronBrowserAutomationService({
    profilePath: join(directory, 'profile')
  })
  const target = { threadId: 'browser-panel-smoke', session: 'panel' }
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<title>Navigated</title><h1>Navigated</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const navigationUrl = `http://127.0.0.1:${address.port}/navigated`
  let window: InstanceType<typeof BrowserWindow> | undefined
  try {
    const renderer = join(directory, 'panel.js')
    const entry = join(directory, 'panel.tsx')
    await writeFile(
      entry,
      `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserTimelineView} from ${JSON.stringify(resolve('apps/desktop/src/renderer/src/features/chat/components/BrowserTimelineView.tsx'))}; createRoot(document.getElementById('root')!).render(<BrowserTimelineView threadId="browser-panel-smoke" sessionId="panel"/>);`
    )
    await build({
      entryPoints: [entry],
      outfile: renderer,
      bundle: true,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      plugins: [
        {
          name: 'fixture-aliases',
          setup(builder) {
            builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
              path: require.resolve(args.path, { paths: [process.cwd()] })
            }))
            builder.onResolve({ filter: /^@yachiyo\/i18n\/react$/ }, () => ({
              path: 'i18n',
              namespace: 'fixture'
            }))
            builder.onResolve({ filter: /^@renderer\/app\/store\/useAppStore$/ }, () => ({
              path: 'app-store',
              namespace: 'fixture'
            }))
            builder.onResolve(
              { filter: /^@renderer\/features\/chat\/state\/useContentReaderStore$/ },
              () => ({ path: 'reader-store', namespace: 'fixture' })
            )
            builder.onResolve({ filter: /^@renderer\// }, (args) => {
              const path = resolve(
                'apps/desktop/src/renderer/src',
                args.path.slice('@renderer/'.length)
              )
              return { path: existsSync(path + '.tsx') ? path + '.tsx' : path + '.ts' }
            })
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
              contents:
                args.path === 'i18n'
                  ? 'export const useT = () => key => key'
                  : args.path === 'app-store'
                    ? 'export const useAppStore = {getState: () => ({activeThreadId:"browser-panel-smoke",composerDrafts:{},setComposerValue:()=>{}})}'
                    : 'export const useContentReaderStore = {getState: () => ({open:()=>{},ask:()=>{},conversations:{}})}',
              loader: 'js'
            }))
          }
        }
      ]
    })
    const css = await readFile(resolve('apps/desktop/src/renderer/src/assets/main.css'), 'utf8')
    const html = join(directory, 'panel.html')
    await writeFile(
      html,
      `<!doctype html><html><head><style>:root{--yachiyo-rgb-surface:255 255 255;--yachiyo-rgb-ink:30 35 40;--yachiyo-rgb-text-muted:100 106 114;--yachiyo-rgb-danger:190 42 42}html,body{margin:0;width:100%;height:100%;display:flex;overflow:hidden}.work-chat-shell__timeline-row{width:620px;transform:translateZ(0);overflow:hidden}.content-reader-stage{width:620px;transform:translateZ(0);overflow:hidden}.content-reader-panels,.content-reader,.content-reader-body,#root{width:100%;height:100%;display:flex;overflow:hidden}${css}</style></head><body><div class="work-chat-shell__timeline-row"><div class="content-reader-stage"><div class="content-reader-panels"><section class="content-reader"><div class="content-reader-body"><div id="root"></div></div></section></div></div></div><script src="panel.js"></script></body></html>`
    )
    const preload = join(directory, 'preload.cjs')
    await writeFile(
      preload,
      `const {contextBridge, ipcRenderer}=require('electron');const names=['listBrowserAutomationSessions','showBrowserAutomationSession','setBrowserAutomationSessionBounds','hideBrowserAutomationSession','controlBrowserAutomationSession'];contextBridge.exposeInMainWorld('api',{yachiyo:Object.fromEntries(names.map(name=>[name,input=>ipcRenderer.invoke(name,input)]))});`
    )
    window = new BrowserWindow({
      width: 1000,
      height: 740,
      x: 120,
      y: 120,
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
    })
    const host = window
    ipcMain.handle('listBrowserAutomationSessions', (_event, input) => service.listSessions(input))
    ipcMain.handle('showBrowserAutomationSession', (_event, input) =>
      service.showSessionView({ ...input, window: host })
    )
    ipcMain.handle('hideBrowserAutomationSession', (_event, input) =>
      service.hideSessionView(input)
    )
    ipcMain.handle('setBrowserAutomationSessionBounds', (_event, input) =>
      service.setSessionViewBounds(input)
    )
    ipcMain.handle('controlBrowserAutomationSession', (_event, input) =>
      service.controlSession(input)
    )
    await service.open({
      ...target,
      url: 'data:text/html,<title>Panel smoke</title><h1 style="background:orange">Live browser view</h1><input value="Saved form">',
      viewport: { width: 900, height: 650 }
    })
    await host.loadFile(html)
    host.showInactive()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const info = await host.webContents.executeJavaScript(
      `({address:document.querySelector('[aria-label="Page address"]')?.value,back:!!document.querySelector('[aria-label="Back"]'),expand:!!document.querySelector('[aria-label="Expand browser"]')})`
    )
    assert.equal(info.back, true)
    assert.equal(info.expand, true)
    assert.match(info.address, /data:text\/html/)
    await host.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Expand browser"]').click()`
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      await host.webContents.executeJavaScript(
        `!!document.querySelector('.browser-timeline-view--expanded')`
      ),
      true
    )
    const expandedWidth = await host.webContents.executeJavaScript(
      `document.querySelector('.browser-timeline-view--expanded').getBoundingClientRect().width`
    )
    assert.ok(
      expandedWidth > 940,
      `expanded browser remained clipped to narrow reader: ${expandedWidth}`
    )
    await host.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Take over"]').click()`
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      service.listSessions(target).find((session) => session.session === target.session)
        ?.controlledBy,
      'user'
    )
    const native = electron.webContents
      .getAllWebContents()
      .find((contents) => contents.getTitle() === 'Panel smoke')
    assert.ok(native)
    const shell = await host.webContents.capturePage()
    await mkdir(resolve('.yachiyo/artifacts'), { recursive: true })
    await writeFile(resolve('.yachiyo/artifacts/browser-panel-shell.png'), shell.toPNG())
    const image = await native.capturePage()
    assert.equal(image.isEmpty(), false, 'native browser screenshot must not be empty')
    assert.equal(shell.isEmpty(), false, 'renderer shell screenshot must not be empty')
    await writeFile(artifact, image.toPNG())
    console.log(
      'PASS: real BrowserTimelineView address/expand/takeover and native capture',
      artifact
    )
    await service.open({
      threadId: target.threadId,
      session: 'second',
      url: 'data:text/html,<title>Second tab</title><h1>Second tab</h1>',
      viewport: { width: 900, height: 650 }
    })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(
      await host.webContents.executeJavaScript(
        `!!document.querySelector('[aria-label="Browser tabs"]')`
      ),
      true
    )
    const attachedBeforePicker = host.contentView.children.length
    await host.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Browser tabs"]').click()`
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      await host.webContents.executeJavaScript(
        `!!document.querySelector('.browser-timeline-view__picker-placeholder')`
      ),
      true
    )
    assert.ok(
      host.contentView.children.length < attachedBeforePicker,
      'native page must park behind floating tab picker'
    )
    await host.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role="option"]')).find(option=>option.textContent.includes('Second tab')).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      await host.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Page address"]').value`
      ),
      'data:text/html,<title>Second tab</title><h1>Second tab</h1>'
    )
    assert.equal(host.contentView.children.length, attachedBeforePicker)
    console.log('PASS: real new-tab picker parks native page and switches to new native view')
    await host.webContents.executeJavaScript(
      `{const address=document.querySelector('[aria-label="Page address"]');address.focus();address.select()}`
    )
    host.webContents.debugger.attach('1.3')
    await host.webContents.debugger.sendCommand('Input.insertText', { text: navigationUrl })
    host.webContents.debugger.detach()
    await host.webContents.executeJavaScript(
      `document.querySelector('.browser-timeline-view__address').requestSubmit()`
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.match(
      service.listSessions(target).find((session) => session.session === 'second')?.url ?? '',
      /\/navigated/
    )
    console.log('PASS: address input commits real navigation via renderer controls')
    assert.equal(BrowserWindow.getFocusedWindow(), null)
  } finally {
    window?.destroy()
    service.dispose()
    for (const channel of [
      'listBrowserAutomationSessions',
      'showBrowserAutomationSession',
      'hideBrowserAutomationSession',
      'setBrowserAutomationSessionBounds',
      'controlBrowserAutomationSession'
    ])
      ipcMain.removeHandler(channel)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    server.close()
  }
  app.quit()
}
void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
