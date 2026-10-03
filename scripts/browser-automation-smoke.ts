import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import electron from 'electron'
import { createElectronBrowserAutomationService } from '../packages/runtime/src/services/browserAutomation/electronBrowserAutomationService.ts'
import { createTool } from '../packages/runtime/src/tools/agentTools/useBrowserTool.ts'
import type {
  UseBrowserToolInput,
  UseBrowserToolOutput
} from '../packages/runtime/src/tools/agentTools/shared.ts'
import {
  browserCdp,
  clickBrowserPoint
} from '../packages/runtime/src/services/browserAutomation/browserPageInput.ts'

const { app, BrowserWindow, nativeImage } = electron
app.setActivationPolicy('prohibited')
app.on('window-all-closed', () => {})
async function run(): Promise<void> {
  await app.whenReady()
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-browser-smoke-'))
  const service = createElectronBrowserAutomationService({
    profilePath: join(directory, 'profile')
  })
  const target = { threadId: 'smoke', session: 'background' }
  try {
    await service.open({
      ...target,
      viewport: { width: 1280, height: 840 },
      url: 'data:text/html,<title>Browser smoke</title><h1>Background rendering</h1><input placeholder="Message"><button disabled>Disabled</button>'
    })
    const geometry = await service.evaluateScript({
      ...target,
      script: 'return {width:innerWidth,height:innerHeight}',
      timeoutMs: 1000
    })
    assert.deepEqual(geometry.value, { width: 1280, height: 840 })
    const capture = await service.screenshot({ ...target, workspacePath: directory })
    const image = nativeImage.createFromBuffer(await readFile(capture.savedFilePath))
    assert.ok(image.getSize().width >= 1280)
    assert.ok(image.getSize().height >= 840)
    assert.equal(BrowserWindow.getFocusedWindow(), null)
    console.log('PASS: background viewport, screenshot, and focus isolation')
    await service.evaluateScript({
      ...target,
      script: `window.received = []; document.addEventListener('keydown', event => window.received.push({key:event.key,trusted:event.isTrusted}));`,
      timeoutMs: 1000
    })
    let snapshot = await service.snapshot(target)
    const field = snapshot.refs.find((ref) => ref.placeholder === 'Message')!
    await service.fill({ ...target, ref: field.ref, text: 'Hello 世界' })
    await service.press({ ...target, key: 'Enter' })
    const inputResult = await service.evaluateScript({
      ...target,
      script: 'return {value:document.querySelector("input").value, events:window.received}',
      timeoutMs: 1000
    })
    assert.deepEqual(inputResult.value, {
      value: 'Hello 世界',
      events: [{ key: 'Enter', trusted: true }]
    })
    snapshot = await service.snapshot(target)
    await assert.rejects(
      service.click({ ...target, ref: snapshot.refs.find((ref) => ref.text === 'Disabled')!.ref }),
      /disabled/i
    )
    console.log('PASS: trusted background keyboard and disabled action refusal')
    const popup = await service.evaluateScript({
      ...target,
      script:
        'window.popup = window.open("about:blank", "smoke-child"); return Boolean(window.popup)',
      timeoutMs: 1000
    })
    assert.equal(popup.value, true)
    assert.equal(service.listSessions(target).length, 2)
    console.log('PASS: child tabs retain native window.open semantics')
    const contents = electron.webContents
      .getAllWebContents()
      .find((page) => page.getTitle() === 'Browser smoke')!
    await service.controlSession({ ...target, action: 'annotate' })
    const heading = await contents.executeJavaScript(
      '(() => {const r=document.querySelector("h1").getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()'
    )
    await clickBrowserPoint(contents, heading, () => {})
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(
      service.listSessions(target).find((page) => page.session === target.session)?.annotation
        ?.text,
      'Background rendering'
    )
    await service.controlSession({ ...target, action: 'annotate' })
    await browserCdp(contents, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 20,
      y: 20,
      button: 'left',
      clickCount: 1
    })
    await browserCdp(contents, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 220,
      y: 100,
      button: 'left',
      buttons: 1
    })
    await browserCdp(contents, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 220,
      y: 100,
      button: 'left',
      clickCount: 1
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(
      service.listSessions(target).find((page) => page.session === target.session)?.annotation
        ?.width,
      200
    )
    await service.controlSession({ ...target, action: 'resume' })
    const dialogResult = contents.executeJavaScript('confirm("Continue smoke test?")')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(
      service.listSessions(target).find((page) => page.session === target.session)?.dialog?.message,
      'Continue smoke test?'
    )
    await service.controlSession({ ...target, action: 'dismissDialog' })
    assert.equal(await dialogResult, false)
    assert.equal(BrowserWindow.getFocusedWindow(), null)
    console.log('PASS: element annotation and explicit dialog handling')
    await service.controlSession({ ...target, action: 'resume' })
    snapshot = await service.snapshot(target)
    const currentField = snapshot.refs.find((ref) => ref.placeholder === 'Message')!
    await service.type({ ...target, ref: currentField.ref, text: ' + 中文🙂' })
    assert.equal(
      await contents.executeJavaScript('document.querySelector("input").value'),
      'Hello 世界 + 中文🙂'
    )
    await service.fill({ ...target, ref: currentField.ref, text: '' })
    assert.equal(await contents.executeJavaScript('document.querySelector("input").value'), '')
    const oldRef = currentField.ref
    await service.snapshot(target)
    await assert.rejects(service.fill({ ...target, ref: oldRef, text: 'wrong' }), /stale/i)
    console.log('PASS: Unicode typing, clear input, and stale-ref rejection')
    snapshot = await service.snapshot(target)
    const protectedRef = snapshot.refs.find((ref) => ref.placeholder === 'Message')!.ref
    await contents.executeJavaScript('window.__yachiyoBrowserRefs = new Map()')
    await service.fill({ ...target, ref: protectedRef, text: 'Protected identity' })
    assert.equal(
      await contents.executeJavaScript('document.querySelector("input").value'),
      'Protected identity'
    )
    console.log('PASS: page scripts cannot replace the automation ref registry')
    await contents.executeJavaScript(
      `document.body.innerHTML = '<input type="date" aria-label="Date" value="2025-01-01"><div role="checkbox" aria-label="Custom" aria-checked="false">Accept</div>'; document.querySelector('[role="checkbox"]').onclick = event => event.currentTarget.setAttribute('aria-checked','true'); void 0`
    )
    snapshot = await service.snapshot(target)
    await service.fill({
      ...target,
      ref: snapshot.refs.find((ref) => ref.ariaLabel === 'Date')!.ref,
      text: '2026-02-02'
    })
    assert.equal(
      await contents.executeJavaScript('document.querySelector("input").value'),
      '2026-02-02'
    )
    await service.check({
      ...target,
      ref: snapshot.refs.find((ref) => ref.ariaLabel === 'Custom')!.ref,
      checked: true
    })
    assert.equal(
      await contents.executeJavaScript(
        'document.querySelector("[role=checkbox]").getAttribute("aria-checked")'
      ),
      'true'
    )
    console.log('PASS: date inputs and custom checkbox state')
    await contents.executeJavaScript(
      `document.body.innerHTML='<button id="target" style="position:fixed;left:100px;top:300px;width:100px;height:40px">Target</button><button id="other" style="display:none;position:fixed;left:100px;top:300px;width:100px;height:40px">Other</button>'; window.hits=[]; document.querySelector('#target').onmouseover=()=>{document.querySelector('#target').style.left='400px';document.querySelector('#other').style.display='block'}; for(const node of document.querySelectorAll('button')) node.onclick=()=>window.hits.push(node.id); void 0`
    )
    snapshot = await service.snapshot(target)
    await assert.rejects(
      service.click({ ...target, ref: snapshot.refs.find((ref) => ref.id === 'target')!.ref }),
      /moved|covered/
    )
    assert.deepEqual(await contents.executeJavaScript('window.hits'), [])
    console.log('PASS: hover layout changes never redirect a ref click')
    if (process.argv[2]) {
      await service.loadUrl({
        ...target,
        url: 'data:text/html,<title>React form</title><div id="root"></div>'
      })
      await contents.executeJavaScript(await readFile(process.argv[2], 'utf8'))
      await service.waitForFunction({
        ...target,
        predicate: 'Boolean(document.querySelector("form"))',
        timeoutMs: 2000
      })
      let form = await service.snapshot(target)
      await service.check({
        ...target,
        ref: form.refs.find((ref) => ref.label === 'Accept')!.ref,
        checked: true
      })
      await service.select({
        ...target,
        ref: form.refs.find((ref) => ref.tag === 'select')!.ref,
        value: 'second'
      })
      for (let iteration = 0; iteration < 20; iteration++) {
        form = await service.snapshot(target)
        await service.fill({
          ...target,
          ref: form.refs.find((ref) => ref.label === 'Name')!.ref,
          text: `Run ${iteration}`
        })
        await service.press({ ...target, key: 'Enter' })
        assert.equal(
          await contents.executeJavaScript('document.querySelectorAll("li").length'),
          iteration + 1
        )
        assert.equal(
          await contents.executeJavaScript('document.querySelector("li:last-child").textContent'),
          `Run ${iteration}:true:second`
        )
      }
      form = await service.snapshot(target)
      await service.fill({
        ...target,
        ref: form.refs.find((ref) => ref.ariaLabel === 'Notes')!.ref,
        text: 'Editable 中文'
      })
      assert.equal(
        await contents.executeJavaScript('document.querySelector("[contenteditable]").textContent'),
        'Editable 中文'
      )
      form = await service.snapshot(target)
      await contents.executeJavaScript(
        `(() => { const cover = document.createElement('div'); cover.style.cssText='position:fixed;inset:0;background:white;z-index:9999'; document.body.append(cover);setTimeout(()=>cover.remove(),150) })()`
      )
      await service.click({ ...target, ref: form.refs.find((ref) => ref.text === 'Save')!.ref })
      assert.equal(await contents.executeJavaScript('document.querySelectorAll("li").length'), 21)
      console.log('PASS: 20/20 React controlled submissions, checkbox, select, and contenteditable')
    }
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html')
      const address = server.address() as { port: number }
      if (request.url === '/download') {
        response.setHeader('Content-Type', 'text/plain')
        response.setHeader('Content-Disposition', 'attachment; filename="browser-smoke.txt"')
        response.end('verified download')
        return
      }
      if (request.url === '/form') {
        response.end(
          `<title>Efficiency form</title><form onsubmit="event.preventDefault();document.querySelector('output').textContent=Array.from(new FormData(this).values()).join(' ')"><input name="first" placeholder="First"><input name="last" placeholder="Last"><input name="status" placeholder="Status"><button>Submit benchmark</button></form><output></output>`
        )
        return
      }
      response.end(
        request.url === '/frame'
          ? '<label>Cross name<input></label><button onclick="this.textContent=document.querySelector(\'input\').value">Submit cross frame</button>'
          : `<h1>Frame host</h1><iframe style="margin:40px;border:8px solid red;width:500px;height:240px" src="http://127.0.0.1:${address.port}/frame"></iframe>`
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      await service.loadUrl({ ...target, url: `http://localhost:${address.port}/` })
      const frames = await service.snapshot(target)
      const crossInput = frames.refs.find((ref) => ref.label === 'Cross name')
      assert.ok(crossInput, 'Cross-origin input is present in the browser snapshot')
      await service.fill({ ...target, ref: crossInput.ref, text: 'Frame success' })
      await contents.executeJavaScript(
        `const cover=document.createElement('div');cover.id='cover';cover.style.cssText='position:fixed;inset:0;z-index:99999';document.body.append(cover);void 0`
      )
      await assert.rejects(
        service.click({
          ...target,
          ref: frames.refs.find((ref) => ref.text === 'Submit cross frame')!.ref
        }),
        /covered/
      )
      await contents.executeJavaScript('document.querySelector("#cover").remove()')
      await service.click({
        ...target,
        ref: frames.refs.find((ref) => ref.text === 'Submit cross frame')!.ref
      })
      assert.ok((await service.snapshot(target)).refs.some((ref) => ref.text === 'Frame success'))
      console.log('PASS: exact cross-origin frame targeting, trusted typing and click')
      const browserTool = createTool(
        { workspacePath: directory, threadId: target.threadId },
        { browserAutomationService: service }
      )
      let toolCalls = 0
      let outputCharacters = 0
      const began = performance.now()
      const invoke = async (
        input: Pick<UseBrowserToolInput, 'action'> & Partial<UseBrowserToolInput>
      ): Promise<string> => {
        const output = (await browserTool.execute!(
          { session: 'efficiency', timeoutMs: 15000, maxRefs: 60, ...input },
          { toolCallId: `efficiency-${++toolCalls}`, messages: [], context: undefined }
        )) as UseBrowserToolOutput
        assert.equal(output.error, undefined)
        const text = output.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n')
        outputCharacters += text.length
        return text
      }
      let observation = await invoke({
        action: 'open',
        url: `http://localhost:${address.port}/form`
      })
      for (const [placeholder, text] of [
        ['First', 'Ada'],
        ['Last', 'Lovelace'],
        ['Status', 'Ready']
      ]) {
        const line = observation
          .split('\n')
          .find((line) => line.includes(`placeholder="${placeholder}"`))!
        const ref = line.match(/^@(\S+)/)![1]
        observation = await invoke({ action: 'fill', ref, text })
      }
      const submitRef = observation
        .split('\n')
        .find((line) => line.startsWith('@') && line.includes('Submit benchmark'))!
        .match(/^@(\S+)/)![1]
      observation = await invoke({ action: 'click', ref: submitRef })
      const benchmarkContents = electron.webContents
        .getAllWebContents()
        .find((page) => page.getTitle() === 'Efficiency form')!
      assert.equal(
        await benchmarkContents.executeJavaScript('document.querySelector("output").textContent'),
        'Ada Lovelace Ready'
      )
      assert.match(observation, /Ada Lovelace Ready/)
      assert.equal(toolCalls, 5)
      assert.equal(BrowserWindow.getFocusedWindow(), null)
      console.log(
        `PASS: real useBrowser form completed in ${toolCalls} calls, ${outputCharacters} output characters, ${Math.round(performance.now() - began)} ms; zero explicit waits/snapshots`
      )
      const downloaded = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Download did not complete')), 5000)
        contents.session.once('will-download', (_event, item) => {
          item.setSavePath(join(directory, 'browser-smoke.txt'))
          item.once('done', (_event, state) => {
            clearTimeout(timeout)
            if (state === 'completed') resolve()
            else reject(new Error(`Download ${state}`))
          })
        })
      })
      contents.downloadURL(`http://localhost:${address.port}/download`)
      await downloaded
      assert.equal(
        await readFile(join(directory, 'browser-smoke.txt'), 'utf8'),
        'verified download'
      )
      assert.equal(
        service.listSessions(target).find((page) => page.session === target.session)?.download
          ?.state,
        'completed'
      )
      console.log('PASS: actual download bytes and user-visible completion state')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      console.warn
    )
  }
  app.quit()
}
void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
