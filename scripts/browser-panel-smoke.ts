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

/** Polls until `check` holds, so assertions follow UI state instead of fixed delays. */
async function waitFor(
  label: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

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
  let holdSessionChecks = false
  const sessionChecks: Array<() => void> = []
  try {
    const renderer = join(directory, 'panel.js')
    const entry = join(directory, 'panel.tsx')
    await writeFile(
      entry,
      `import React from 'react'; import {createRoot} from 'react-dom/client'; import {RetainedBrowserPreview} from ${JSON.stringify(resolve('apps/desktop/src/renderer/src/features/chat/components/RetainedBrowserPreview.tsx'))}; const root=createRoot(document.getElementById('root')!); const target={kind:'web',threadId:'browser-panel-smoke',session:'panel',url:'https://example.test/panel',title:'Panel smoke'}; window.renderPreview=(suspended=false)=>root.render(<RetainedBrowserPreview target={target} reading={{}} suspended={suspended}/>); window.renderPreview();`
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
    ipcMain.handle('listBrowserAutomationSessions', (_event, input) =>
      holdSessionChecks
        ? new Promise((resolve) => sessionChecks.push(() => resolve(service.listSessions(input))))
        : service.listSessions(input)
    )
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
    await waitFor('the browser preview controls', () =>
      host.webContents.executeJavaScript(
        `!!document.querySelector('[aria-label="Page address"]')?.value`
      )
    )
    const info = await host.webContents.executeJavaScript(
      `({address:document.querySelector('[aria-label="Page address"]')?.value,back:!!document.querySelector('[aria-label="Back"]'),expand:!!document.querySelector('[aria-label="Expand browser"]')})`
    )
    assert.equal(info.back, true)
    assert.equal(info.expand, true)
    assert.match(info.address, /data:text\/html/)
    await host.webContents.executeJavaScript(
      `window.savedTimeline=document.querySelector('.browser-timeline-view');window.renderPreview(true);void 0`
    )
    await host.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
    )
    holdSessionChecks = true
    await host.webContents.executeJavaScript('window.renderPreview(false);void 0')
    await host.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
    )
    assert.equal(
      await host.webContents.executeJavaScript(
        `document.querySelector('.browser-timeline-view')===window.savedTimeline && !document.querySelector('.content-reader-notice')`
      ),
      true
    )
    holdSessionChecks = false
    for (const finish of sessionChecks.splice(0)) finish()
    console.log('PASS: retained preview stays mounted while its resume check is pending')
    await host.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Expand browser"]').click()`
    )
    await waitFor('the expanded browser', () =>
      host.webContents.executeJavaScript(
        `!!document.querySelector('.browser-timeline-view--expanded')`
      )
    )
    await waitFor(
      'the expanded browser to grow past the narrow reader',
      async () =>
        (await host.webContents.executeJavaScript(
          `document.querySelector('.browser-timeline-view--expanded').getBoundingClientRect().width`
        )) > 940
    )
    await host.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Take over"]').click()`
    )
    await waitFor(
      'user takeover',
      () =>
        service.listSessions(target).find((session) => session.session === target.session)
          ?.controlledBy === 'user'
    )
    // Both captures go through CDP with fromSurface, like the service's own screenshots:
    // webContents.capturePage() waits for a fresh frame and never settles when the
    // compositor of a background or occluded view has none to publish.
    host.webContents.debugger.attach('1.3')
    const shell = await host.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    })
    host.webContents.debugger.detach()
    const shellImage = Buffer.from(shell.data, 'base64')
    assert.ok(shellImage.byteLength > 0, 'renderer shell screenshot must not be empty')
    await mkdir(resolve('.yachiyo/artifacts'), { recursive: true })
    await writeFile(resolve('.yachiyo/artifacts/browser-panel-shell.png'), shellImage)
    const capture = await service.screenshot({ ...target, workspacePath: directory })
    await writeFile(artifact, await readFile(capture.savedFilePath))
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
    await waitFor('the browser tabs button', () =>
      host.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Browser tabs"]')`)
    )
    const attachedBeforePicker = host.contentView.children.length
    await host.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Browser tabs"]').click()`
    )
    await waitFor('the floating tab picker', () =>
      host.webContents.executeJavaScript(
        `!!document.querySelector('.browser-timeline-view__picker-placeholder')`
      )
    )
    await waitFor(
      'the native page to park behind the floating tab picker',
      () => host.contentView.children.length < attachedBeforePicker
    )
    await host.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role="option"]')).find(option=>option.textContent.includes('Second tab')).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`
    )
    await waitFor(
      'the second tab in the address bar',
      async () =>
        (await host.webContents.executeJavaScript(
          `document.querySelector('[aria-label="Page address"]').value`
        )) === 'data:text/html,<title>Second tab</title><h1>Second tab</h1>'
    )
    await waitFor(
      'the second native view to attach',
      () => host.contentView.children.length === attachedBeforePicker
    )
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
    await waitFor('the address bar navigation', () =>
      /\/navigated/.test(
        service.listSessions(target).find((session) => session.session === 'second')?.url ?? ''
      )
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
