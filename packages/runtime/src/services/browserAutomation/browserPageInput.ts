import type { WebContents } from 'electron'

export async function browserCdp<T = unknown>(
  contents: WebContents,
  method: string,
  parameters: Record<string, unknown> = {}
): Promise<T> {
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  return contents.debugger.sendCommand(method, parameters) as Promise<T>
}

/** Resolve a node identity, never a selector that could now match another node. */
export function browserRefExpression(ref: string): string {
  return `(() => {
    const node = globalThis.__yachiyoBrowserRefs?.get(${JSON.stringify(ref)})
    if (!node?.isConnected) throw new Error('Stale browser ref. Take a new snapshot.')
    return node
  })()`
}

export function browserTargetScript(ref: string, editable = false): string {
  return `(() => {
    const node = ${browserRefExpression(ref)}
    const view = node.ownerDocument.defaultView
    if (node.matches(':disabled,[aria-disabled="true"]')) throw new Error('Target is disabled.')
    if (${editable} && (node.readOnly || node.getAttribute('aria-readonly') === 'true')) throw new Error('Target is read-only.')
    if (${editable} && !node.matches('input,textarea') && !node.isContentEditable) throw new Error('Target is not editable.')
    node.scrollIntoView({block:'center',inline:'center',behavior:'instant'})
    const rect = node.getBoundingClientRect()
    const style = view.getComputedStyle(node)
    if (rect.width < 1 || rect.height < 1 || style.visibility === 'hidden' || style.display === 'none') throw new Error('Target is not visible.')
    let x = Math.max(0, rect.left) + (Math.min(view.innerWidth, rect.right) - Math.max(0, rect.left)) / 2
    let y = Math.max(0, rect.top) + (Math.min(view.innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2
    const hit = node.getRootNode().elementFromPoint?.(x,y) ?? node.ownerDocument.elementFromPoint(x,y)
    if (!hit || (hit !== node && !node.contains(hit))) throw new Error('Target is covered by another element.')
    let frame = view.frameElement
    while (frame) {
      const frameRect = frame.getBoundingClientRect()
      x += frameRect.left + frame.clientLeft; y += frameRect.top + frame.clientTop
      const topHit = frame.ownerDocument.elementFromPoint(x,y)
      if (topHit !== frame) throw new Error('Target frame is covered by another element.')
      frame = frame.ownerDocument.defaultView.frameElement
    }
    const checkable = node.matches('input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch]')
    return {x,y,checked:checkable ? ('checked' in node ? node.checked : node.getAttribute('aria-checked') === 'true') : undefined}
  })()`
}

export async function clickBrowserPoint(
  contents: WebContents,
  point: { x: number; y: number },
  assertCurrent: () => void,
  resolvePoint?: () => Promise<{ x: number; y: number }>
): Promise<void> {
  // Layout queries can finish before a hidden page's compositor publishes its
  // hit-test regions (notably after OOPIF navigation). Await a rendered frame;
  // the low-quality image is discarded, never saved or exposed to the model.
  assertCurrent()
  await browserCdp(contents, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 1,
    fromSurface: true,
    captureBeyondViewport: false
  })
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    if (type === 'mousePressed' && resolvePoint) {
      const current = await resolvePoint()
      if (Math.abs(current.x - point.x) > 1 || Math.abs(current.y - point.y) > 1)
        throw new Error('Target moved after hover. Take a new snapshot before clicking.')
    }
    assertCurrent()
    await browserCdp(contents, 'Input.dispatchMouseEvent', {
      type,
      ...point,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1
    })
  }
}

export async function pressBrowserKey(
  contents: WebContents,
  combination: string,
  assertCurrent: () => void
): Promise<void> {
  const parts = combination === '+' ? ['+'] : combination.split('+')
  const name = parts.pop() ?? ''
  const modifiers = parts.reduce((mask, part) => {
    const bits: Record<string, number> = {
      alt: 1,
      control: 2,
      ctrl: 2,
      meta: 4,
      cmd: 4,
      command: 4,
      shift: 8
    }
    const bit = bits[part.trim().toLowerCase()]
    if (!bit) throw new Error(`Unknown key modifier: ${part}`)
    return mask | bit
  }, 0)
  const keys: Record<string, [string, number]> = {
    Enter: ['Enter', 13],
    Tab: ['Tab', 9],
    Escape: ['Escape', 27],
    Esc: ['Escape', 27],
    Backspace: ['Backspace', 8],
    Delete: ['Delete', 46],
    ArrowLeft: ['ArrowLeft', 37],
    ArrowUp: ['ArrowUp', 38],
    ArrowRight: ['ArrowRight', 39],
    ArrowDown: ['ArrowDown', 40],
    Home: ['Home', 36],
    End: ['End', 35],
    PageUp: ['PageUp', 33],
    PageDown: ['PageDown', 34],
    Space: [' ', 32]
  }
  const special = keys[name]
  if (!special && [...name].length !== 1) throw new Error(`Unsupported key: ${name}`)
  const key = special?.[0] ?? name
  const code = special?.[0] ?? (/^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : name)
  const windowsVirtualKeyCode = special?.[1] ?? name.toUpperCase().charCodeAt(0)
  for (const type of ['keyDown', 'keyUp']) {
    assertCurrent()
    await browserCdp(contents, 'Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
      ...(type === 'keyDown' && !(modifiers & 6) && (key.length === 1 || key === 'Enter')
        ? { text: key === 'Enter' ? '\r' : key }
        : {}),
      ...(type === 'keyDown' && modifiers & 6 && name.toLowerCase() === 'a'
        ? { commands: ['selectAll'] }
        : {})
    })
  }
}
