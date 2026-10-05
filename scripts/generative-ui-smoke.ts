import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import electron from 'electron'
import { MAX_RENDER_UI_INLINE_HEIGHT } from '../apps/desktop/src/renderer/src/features/chat/lib/render-ui/renderUiBoundary.ts'
import {
  registerGenerativeUiScheme,
  installGenerativeUiProtocol,
  installGenerativeUiResourceGuard,
  isGenerativeUiFrameUrl,
  installGenerativeUiNavigationGuard
} from '../apps/desktop/src/main/electron/generativeUiProtocol.ts'
import {
  registerYachiyoAssetScheme,
  installYachiyoAssetProtocolHandler,
  buildAssetUrl
} from '../apps/desktop/src/main/electron/yachiyoAssetProtocol.ts'

const { app, BrowserWindow } = electron
app.setPath('userData', join(process.argv[3], 'electron-profile'))
app.setActivationPolicy('prohibited')
registerGenerativeUiScheme()
registerYachiyoAssetScheme()
app.on('window-all-closed', () => {})

async function run(): Promise<void> {
  await app.whenReady()
  installGenerativeUiProtocol()
  installYachiyoAssetProtocolHandler()
  const imagePath = join(process.argv[3], 'private.png')
  await writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=',
      'base64'
    )
  )
  const assetUrl = buildAssetUrl(imagePath)
  assert.ok(assetUrl)
  const fixture = await readFile(process.argv[2], 'utf8')
  const fixtureCss = await readFile(join(process.argv[3], 'style.css'), 'utf8')
  const rendererHtml = await readFile('apps/desktop/src/renderer/index.html', 'utf8')
  const csp = rendererHtml.match(/content="([^"]*default-src[^"]*)"/)?.[1]
  assert.ok(csp, 'Read production renderer CSP')
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp))
  let networkHits = 0
  const server = createServer((request, response) => {
    if (request.url === '/style.css') {
      response.setHeader('Content-Type', 'text/css')
      response.end(fixtureCss)
      return
    }
    if (request.url === '/fixture.js') {
      response.setHeader('Content-Type', 'application/javascript')
      response.end(fixture)
      return
    }
    if (request.url !== '/') networkHits += 1
    response.setHeader('Content-Security-Policy', csp)
    response.setHeader('Content-Type', 'text/html')
    response.end(
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const rootUrl = `http://127.0.0.1:${address.port}/`
  const page = new BrowserWindow({
    show: false,
    width: 960,
    height: 840,
    webPreferences: {
      preload: join(process.argv[3], 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  installGenerativeUiNavigationGuard(page.webContents)
  installGenerativeUiResourceGuard(page.webContents)
  let popups = 0
  page.webContents.setWindowOpenHandler(() => {
    popups += 1
    return { action: 'deny' }
  })
  page.webContents.on('console-message', ({ message }) => {
    if (!message.includes('Content Security Policy')) console.log(`renderer: ${message}`)
  })
  const bounded = async (execution: Promise<unknown>, label: string): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        execution,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Evaluation stalled: ${label}`)), 10_000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const evaluate = (script: string): Promise<unknown> =>
    bounded(page.webContents.executeJavaScript(script), script)
  const wait = async (predicate: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await evaluate(predicate)) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`Timed out: ${predicate}`)
  }
  const frame = (): Electron.WebFrameMain => {
    const match = page.webContents.mainFrame.framesInSubtree.find((item) =>
      isGenerativeUiFrameUrl(item.url)
    )
    assert.ok(match, 'Isolated UI frame exists')
    return match
  }
  const inFrame = (script: string): Promise<unknown> =>
    bounded(frame().executeJavaScript(script), script)
  const waitFrame = async (predicate: string, previousFrameId?: number): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const current = page.webContents.mainFrame.framesInSubtree.find((item) =>
        isGenerativeUiFrameUrl(item.url)
      )
      if (
        current &&
        current.frameTreeNodeId !== previousFrameId &&
        (await bounded(current.executeJavaScript(predicate), predicate).catch(() => false))
      )
        return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`Frame timed out: ${predicate}`)
  }
  try {
    await page.loadURL(rootUrl)
    assert.equal(
      await evaluate('Boolean(window.api?.yachiyo)'),
      true,
      'Production preload exposed to host only'
    )
    await wait('Boolean(window.__uiSmoke && document.querySelector("iframe"))')
    if (process.env.YACHIYO_UI_REPLAY_SOURCE) {
      await waitFrame('Boolean(document.querySelector("#amount"))')
      assert.equal(
        await inFrame('Boolean(document.querySelector("article #fixed"))'),
        true,
        'Real mortgage result nodes survive sanitization'
      )
      const preparing = frame().frameTreeNodeId
      await evaluate('window.__uiSmoke.complete()')
      await waitFrame('document.querySelectorAll("#chart path").length === 2', preparing)
      assert.match(
        String(await inFrame('document.querySelector("#fixed").textContent')),
        /4,270\.16/
      )
      assert.equal(
        await evaluate('document.querySelector("[role=alert]")?.textContent ?? null'),
        null
      )
      await inFrame(
        '(() => { for (const [id,value] of [["amount",500000],["rate",0],["years",10]]) document.getElementById(id).value=value; document.getElementById("years").dispatchEvent(new Event("input",{bubbles:true})); document.getElementById("month").value=60; document.getElementById("month").dispatchEvent(new Event("input",{bubbles:true})); })()'
      )
      assert.match(
        String(await inFrame('document.querySelector("#fixed").textContent')),
        /4,166\.67/
      )
      assert.match(
        String(await inFrame('document.querySelector("#inspect").textContent')),
        /250,000\.00/
      )
      await inFrame(
        'document.querySelector("#amount").value=-1; document.querySelector("#amount").dispatchEvent(new Event("input",{bubbles:true}))'
      )
      assert.equal(await inFrame('document.querySelector("#results").hidden'), true)
      await inFrame('document.querySelector("#reset").click()')
      assert.match(
        String(await inFrame('document.querySelector("#fixed").textContent')),
        /4,270\.16/
      )
      assert.equal(
        await inFrame(
          '!document.querySelector("#results").hidden && document.querySelector("#results").getBoundingClientRect().height > 0'
        ),
        true
      )
      const originalFrame = frame().frameTreeNodeId
      await evaluate('window.__uiSmoke.expand()')
      await wait('Boolean(document.querySelector("dialog[aria-modal=true]"))')
      assert.equal(
        await evaluate(
          'Math.abs(document.querySelector("dialog").getBoundingClientRect().width-innerWidth) < 1 && Math.abs(document.querySelector("dialog").getBoundingClientRect().height-innerHeight) < 1'
        ),
        true,
        'Fullscreen fills the viewport without a framed overlay'
      )
      assert.equal(frame().frameTreeNodeId, originalFrame)
      await evaluate('window.__uiSmoke.closeExpand()')
      assert.equal(frame().frameTreeNodeId, originalFrame)
      await waitFrame(
        'Math.abs(innerHeight-Math.max(160,Math.ceil(Math.max(document.querySelector("#content").getBoundingClientRect().height,document.querySelector("#content").scrollHeight)))) <= 1'
      )
      const screenshots = join(process.cwd(), '.yachiyo/generative-ui-verification')
      await mkdir(screenshots, { recursive: true })
      for (const variant of ['light', 'dark']) {
        await evaluate(`window.__uiSmoke.theme(${JSON.stringify(variant)})`)
        await waitFrame(`document.documentElement.dataset.theme === ${JSON.stringify(variant)}`)
        await inFrame(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
        )
        await evaluate(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
        )
        await writeFile(
          join(screenshots, `mortgage-${variant}.png`),
          (await page.webContents.capturePage()).toPNG()
        )
      }
      page.setSize(480, 840)
      await waitFrame('innerWidth <= 432')
      await evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
      )
      await waitFrame(
        'document.querySelector("#content").getBoundingClientRect().height <= innerHeight'
      )
      await writeFile(
        join(screenshots, 'mortgage-narrow.png'),
        (await page.webContents.capturePage()).toPNG()
      )
      console.log(
        'PASS: unchanged database mortgage source, recomputation, chart, validation and preserved fullscreen frame'
      )
      return
    }
    await waitFrame('Boolean(document.querySelector("#count"))')
    assert.equal(await inFrame('document.querySelector("output").dataset.result'), 'counter')
    assert.equal(
      await inFrame('document.querySelector("output").getAttribute("aria-live")'),
      'polite'
    )
    assert.equal(await inFrame('document.querySelector("#count")?.textContent'), '0')
    assert.equal(await inFrame('Boolean(window.__executions || window.__htmlAttack)'), false)
    assert.equal(
      await inFrame(
        'Boolean(document.querySelector("script:not([nonce]), iframe, meta[http-equiv], base, [onclick]"))'
      ),
      false
    )
    const firstFrame = frame().frameTreeNodeId
    await evaluate('window.__uiSmoke.preview()')
    await waitFrame('document.body.textContent.includes("Preview updated")')
    assert.equal(frame().frameTreeNodeId, firstFrame, 'Streaming does not reload iframe')
    await evaluate('window.__uiSmoke.complete()')
    await waitFrame('window.__executions === 1')
    assert.equal(await inFrame('window.__executions'), 1)
    await inFrame('document.querySelector("#increment").click()')
    assert.equal(await inFrame('document.querySelector("#count").textContent'), '1')
    await evaluate('window.__uiSmoke.theme("dark")')
    await waitFrame('document.documentElement.dataset.theme === "dark"')
    assert.equal(
      await inFrame('document.querySelector("#count").textContent'),
      '1',
      'Theme updates preserve interaction'
    )
    assert.equal(await inFrame('window.__executions'), 1)
    console.log('PASS: production CSP, progressive preview, final JS once, interaction and theme')

    assert.deepEqual(
      await inFrame(`(() => {
      const denied = (fn) => { try { fn(); return false } catch { return true } };
      return {node:typeof require,process:typeof process,api:typeof window.api,parent:denied(()=>parent.document.body),storage:denied(()=>localStorage.getItem('x')),popup:window.open('https://example.com')===null};
    })()`),
      {
        node: 'undefined',
        process: 'undefined',
        api: 'undefined',
        parent: true,
        storage: true,
        popup: true
      }
    )
    assert.deepEqual(
      await inFrame(
        `Promise.all(${JSON.stringify([`${rootUrl}blocked`, 'file:///etc/passwd', 'yachiyo-asset://local/etc/passwd'])}.map(url=>fetch(url).then(()=>false,()=>true)))`
      ),
      [true, true, true]
    )
    const imageProbe = `new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(true);image.onerror=()=>resolve(false);image.src=${JSON.stringify(assetUrl)};document.body.appendChild(image)})`
    assert.equal(await evaluate(imageProbe), true, 'Normal host asset loading still works')
    assert.equal(await inFrame(imageProbe), false, 'Sandbox cannot load privileged local images')
    const sandboxFrame = frame()
    await bounded(sandboxFrame.executeJavaScript('location.hash = "bypass"'), 'same-document hash')
    assert.equal(
      await bounded(sandboxFrame.executeJavaScript(imageProbe), 'privileged image after hash'),
      false,
      'Hash navigation cannot bypass local resource isolation'
    )
    await bounded(sandboxFrame.executeJavaScript('location.hash = ""'), 'restore same-document URL')
    assert.equal(
      await bounded(
        sandboxFrame.executeJavaScript(
          `(() => { try { top.location.href=${JSON.stringify(rootUrl + 'escape')}; return false } catch { return true } })()`
        ),
        'top navigation'
      ),
      true
    )
    await bounded(
      sandboxFrame.executeJavaScript('location.href="https://example.com/escape"; true'),
      'self navigation'
    )
    assert.ok(
      isGenerativeUiFrameUrl(sandboxFrame.url),
      'Sandbox navigation cannot escape its guarded scheme'
    )
    assert.equal(page.webContents.getURL(), rootUrl)
    assert.equal(networkHits, 0)
    assert.equal(popups, 0)
    console.log('PASS: Node/preload/parent/storage/network/file/asset/popup isolation')

    // A rejected script-initiated navigation can discard the renderer document.
    // Reset must recover a fresh isolated frame before exercising further interactions.
    const afterAttack = frame().frameTreeNodeId
    await evaluate('window.__uiSmoke.reset()')
    await waitFrame('window.__executions === 1', afterAttack)

    await inFrame('window.yachiyoUi.continueConversation("Explain the result")')
    await wait('window.__uiSmoke.pendingReady()')
    assert.equal(await evaluate('window.__uiSmoke.draft()'), 'Existing draft')
    assert.deepEqual(await evaluate('window.__uiSmoke.openedLinks()'), [])
    await evaluate('window.__uiSmoke.confirmDraft()')
    assert.equal(await evaluate('window.__uiSmoke.draft()'), 'Existing draft\nExplain the result')
    assert.equal(await evaluate('window.__uiSmoke.attachmentCount()'), 1)
    await inFrame(
      'new Promise(resolve => setTimeout(() => { window.yachiyoUi.openLink("https://example.com/ui"); resolve() }, 250))'
    )
    await wait('document.body.textContent.includes("Open link")')
    await evaluate('window.__uiSmoke.confirmLink()')
    assert.deepEqual(await evaluate('window.__uiSmoke.openedLinks()'), ['https://example.com/ui'])
    await evaluate(
      '(() => { const rogue = document.createElement("iframe"); rogue.id = "rogue"; rogue.src = "about:blank"; document.body.appendChild(rogue) })()'
    )
    const rogue = page.webContents.mainFrame.framesInSubtree.find(
      (item) => item.url === 'about:blank'
    )
    assert.ok(rogue)
    await bounded(
      rogue.executeJavaScript(
        'parent.postMessage({type:"yachiyo-ui-ready"},"*"); parent.postMessage({type:"continueConversation",text:"Forged draft"},"*"); true'
      ),
      'forged sibling messages'
    )
    assert.equal(await evaluate('window.__uiSmoke.pendingReady()'), false)
    assert.equal(await evaluate('window.__uiSmoke.draft()'), 'Existing draft\nExplain the result')
    await evaluate('document.querySelector("#rogue").remove()')
    console.log('PASS: host bridge requires user confirmation and preserves draft/attachments')

    await inFrame(
      '(() => {const probe=document.createElement("div");probe.id="height-probe";probe.style.cssText="float:left;height:400px;width:1px";document.querySelector("#content").appendChild(probe)})()'
    )
    await evaluate('window.__uiSmoke.theme("light")')
    await waitFrame(
      'document.querySelector("#height-probe").getBoundingClientRect().bottom <= innerHeight'
    )
    await inFrame('document.querySelector("#height-probe").remove()')
    await waitFrame('innerHeight < 400')
    await inFrame('window.yachiyoUi.reportHeight(99999);window.yachiyoUi.reportHeight(160)')
    await wait('Number.parseFloat(document.querySelector("iframe").style.height) === 160')
    await wait(
      `Number.parseFloat(document.querySelector("iframe").style.height) <= ${MAX_RENDER_UI_INLINE_HEIGHT}`
    )
    await evaluate('window.__uiSmoke.source()')
    await wait('window.__uiSmoke.sourceReady()')
    assert.equal(await evaluate('Boolean(window.__htmlAttack)'), false)
    await evaluate('window.__uiSmoke.source()')
    const beforeReset = frame().frameTreeNodeId
    await evaluate('window.__uiSmoke.reset()')
    await waitFrame(
      'window.__executions === 1 && document.querySelector("#count")?.textContent === "0"',
      beforeReset
    )
    assert.equal(await inFrame('document.querySelector("#count").textContent'), '0')
    await evaluate('window.__uiSmoke.expand()')
    await wait('Boolean(document.querySelector("dialog[aria-modal=true]"))')
    await evaluate('window.__uiSmoke.closeExpand()')
    const beforeRestore = frame().frameTreeNodeId
    await evaluate('window.__uiSmoke.restore()')
    await waitFrame('window.__executions === 1', beforeRestore)
    assert.equal(await inFrame('window.__executions'), 1)
    assert.equal(
      await inFrame(
        'Boolean(document.querySelector("canvas")) && Boolean(document.querySelector("svg circle"))'
      ),
      true
    )
    console.log('PASS: bounded resize, source escaping, reset, expansion and historical remount')
    const beforeFailure = frame().frameTreeNodeId
    await evaluate('window.__uiSmoke.fail()')
    await waitFrame('Boolean(document.querySelector("#count"))', beforeFailure)
    assert.equal(await inFrame('Boolean(window.__executions || window.__htmlAttack)'), false)
    console.log('PASS: failed/cancelled UI remains static; forged sibling messages are ignored')
    const beforeClean = frame().frameTreeNodeId
    await evaluate('window.__uiSmoke.clean()')
    await waitFrame('window.__executions === 1', beforeClean)
    const screenshots = join(process.cwd(), '.yachiyo/generative-ui-verification')
    await mkdir(screenshots, { recursive: true })
    for (const variant of ['light', 'dark']) {
      await evaluate(`window.__uiSmoke.theme(${JSON.stringify(variant)})`)
      await waitFrame(`document.documentElement.dataset.theme === ${JSON.stringify(variant)}`)
      assert.equal(
        await inFrame(
          'getComputedStyle(document.documentElement).getPropertyValue("--yachiyo-font-ui").trim()'
        ),
        await evaluate(
          'getComputedStyle(document.documentElement).getPropertyValue("--yachiyo-font-ui").trim()'
        )
      )
      await evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
      )
      await writeFile(
        join(screenshots, `${variant}.png`),
        (await page.webContents.capturePage()).toPNG()
      )
    }
    page.setSize(480, 840)
    await evaluate('window.__uiSmoke.theme("light")')
    await waitFrame('document.documentElement.dataset.theme === "light"')
    await evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    assert.equal(
      await evaluate(
        'document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth'
      ),
      true
    )
    await writeFile(join(screenshots, 'narrow.png'), (await page.webContents.capturePage()).toPNG())
    console.log(
      `PASS: production chat CSS, native font/theme tokens and narrow layout; screenshots ${screenshots}`
    )
    assert.equal(BrowserWindow.getFocusedWindow(), null)
  } finally {
    page.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

run().then(
  () => {
    console.log('Generative UI native smoke passed')
    app.exit(0)
  },
  (error) => {
    console.error(error)
    app.exit(1)
  }
)
