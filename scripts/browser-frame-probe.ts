import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import electron from 'electron'
import {
  collectBrowserFrameSnapshots,
  executeBrowserFrameScript,
  framePointToMain
} from '../packages/runtime/src/services/browserAutomation/browserFrameAutomation.ts'
import { clickBrowserPoint } from '../packages/runtime/src/services/browserAutomation/browserPageInput.ts'

const { app, BrowserWindow } = electron
app.setActivationPolicy('prohibited')
app.on('window-all-closed', () => {})

async function serve(host: string, render: (path: string | undefined) => string): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(render(request.url))
  })
  await new Promise((resolve) => server.listen(0, host, resolve))
  return server
}

async function main(): Promise<void> {
  await app.whenReady()
  const frameServer = await serve('127.0.0.1', (path) =>
    path === '/simple'
      ? `<body style="margin:0"><button id="simple" style="position:absolute;left:50px;top:30px;width:20px;height:20px" onclick="this.textContent='Hit'">Target</button></body>`
      : path === '/nested'
        ? `<html><body><button id="frame-action" style="position:absolute;right:0;bottom:0;width:20px;height:20px" onclick="this.textContent='Clicked'">Cross-origin action</button></body></html>`
        : `<html><body><iframe src="/nested" style="position:absolute;left:10px;top:8px;width:200px;height:100px;border:5px solid blue"></iframe></body></html>`
  )
  const frameAddress = frameServer.address()
  assert.ok(frameAddress && typeof frameAddress !== 'string')
  const frameUrl = `http://127.0.0.1:${frameAddress.port}/frame`
  const rootServer = await serve('localhost', (path) =>
    path === '/inverse'
      ? '<body style="margin:0"><iframe src="/outer" style="position:absolute;left:100px;top:100px;width:400px;height:300px;border:0"></iframe></body>'
      : path === '/outer'
        ? `<body style="margin:0"><iframe src="${frameUrl.replace('/frame', '/simple')}" style="position:absolute;left:30px;top:30px;width:200px;height:100px;border:0"></iframe></body>`
        : `<html><body style="height:1600px"><h1>Top frame</h1><iframe src="${frameUrl}" style="position:absolute;left:80px;top:700px;width:250px;height:150px;border:8px solid red"></iframe></body></html>`
  )
  const rootAddress = rootServer.address()
  assert.ok(rootAddress && typeof rootAddress !== 'string')
  const rootUrl = `http://localhost:${rootAddress.port}/`
  const page = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { sandbox: true, backgroundThrottling: false }
  })
  try {
    await page.loadURL(rootUrl)
    const contents = page.webContents
    contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Page.enable')
    await contents.debugger.sendCommand('Runtime.enable')
    await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await contents.executeJavaScript('window.scrollTo(0, 580)')
    const collection = await collectBrowserFrameSnapshots(contents, {
      generation: 'probe',
      maxRefs: 10
    })
    assert.equal(collection.unavailableFrames.length, 0)
    assert.equal(collection.frames.length, 1)
    const frame = collection.frames[0]
    assert.equal(
      frame.snapshot.refs.find((item) => item.id === 'frame-action')?.label,
      'Cross-origin action'
    )
    const newer = await collectBrowserFrameSnapshots(contents, {
      generation: 'probe2',
      maxRefs: 10
    })
    assert.equal(newer.frames.length, 1)
    assert.notEqual(newer.frames[0].snapshot.refs[0].ref, frame.snapshot.refs[0].ref)
    assert.equal(
      await executeBrowserFrameScript(
        contents,
        newer.frames[0],
        `globalThis.__yachiyoBrowserRefs.has(${JSON.stringify(frame.snapshot.refs[0].ref)})`
      ),
      false
    )
    assert.equal(
      await executeBrowserFrameScript(
        contents,
        newer.frames[0],
        `globalThis.__yachiyoBrowserRefs.has(${JSON.stringify(newer.frames[0].snapshot.refs[0].ref)})`
      ),
      true
    )
    const point = await executeBrowserFrameScript(
      contents,
      frame,
      '(() => { const frame=document.querySelector("iframe"); const r=frame.contentDocument.querySelector("#frame-action").getBoundingClientRect();const f=frame.getBoundingClientRect();return {x:f.left+frame.clientLeft+r.left+r.width/2,y:f.top+frame.clientTop+r.top+r.height/2} })()'
    )
    const mainPoint = await framePointToMain(contents, frame, point)
    assert.ok(mainPoint.x > 80 && mainPoint.y > 120)
    await clickBrowserPoint(contents, mainPoint, () => {})
    assert.equal(
      await executeBrowserFrameScript(
        contents,
        newer.frames[0],
        `new Promise((resolve, reject) => { const button=document.querySelector('iframe').contentDocument.querySelector('#frame-action'); if(button.textContent==='Clicked') return resolve(true); const observer=new MutationObserver(() => { if(button.textContent==='Clicked') { observer.disconnect(); resolve(true) } }); observer.observe(button,{childList:true}); setTimeout(() => {observer.disconnect();reject(new Error('Cross-origin click not delivered'))},1500) })`
      ),
      true
    )
    assert.equal(BrowserWindow.getFocusedWindow(), null)
    console.log(
      'PASS: cross-origin OOPIF identity, isolated refs, trusted click, coordinates, no focus'
    )
    await page.loadURL(`${rootUrl}inverse`)
    const inverse = await collectBrowserFrameSnapshots(contents, {
      generation: 'inverse',
      maxRefs: 10
    })
    assert.equal(inverse.unavailableFrames.length, 0)
    const child = inverse.frames.find((frame) =>
      frame.snapshot.refs.some((ref) => ref.id === 'simple')
    )!
    assert.ok(child)
    const mapped = await framePointToMain(contents, child, { x: 60, y: 40 })
    assert.deepEqual(mapped, { x: 190, y: 170 })
    await clickBrowserPoint(contents, mapped, () => {})
    assert.equal(
      await executeBrowserFrameScript(
        contents,
        child,
        `new Promise((resolve,reject)=>{const node=document.querySelector('#simple');if(node.textContent==='Hit') return resolve(true);const observer=new MutationObserver(()=>{if(node.textContent==='Hit'){observer.disconnect();resolve(true)}});observer.observe(node,{childList:true});setTimeout(()=>{observer.disconnect();reject(new Error('Inverse frame click not delivered'))},1500)})`
      ),
      true
    )
    console.log(
      'PASS: same-origin outer / cross-origin inner maps exactly once and clicks the target'
    )
  } finally {
    page.destroy()
    await Promise.all([
      new Promise((resolve) => rootServer.close(resolve)),
      new Promise((resolve) => frameServer.close(resolve))
    ])
    app.quit()
  }
}
void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
