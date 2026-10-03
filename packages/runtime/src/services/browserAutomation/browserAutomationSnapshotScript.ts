export function buildBrowserAutomationSnapshotScript(
  limit: number,
  options: { generation: string; query?: string; scopeRef?: string } = { generation: 'default' }
): string {
  return `(() => {
    const limit = ${JSON.stringify(limit)}
    const options = ${JSON.stringify(options)}
    const previous = globalThis.__yachiyoBrowserRefs
    const scope = options.scopeRef ? previous?.get(options.scopeRef) : document
    if (!scope || (options.scopeRef && !scope.isConnected)) throw new Error('Stale browser scope ref: ' + options.scopeRef)
    // A snapshot replaces the entire registry; old generations cannot resolve to new nodes.
    const registry = new Map()
    globalThis.__yachiyoBrowserRefs = registry
    const MAX_SCAN_NODES = 10000
    const MAX_REF_CANDIDATES = 1000
    let truncated = false
    let inaccessibleFrames = 0
    let scanned = 0
    let candidateCount = 0
    let textLength = 0
    const geometry = new WeakMap()
    const visibleRect = (el) => {
      if (geometry.has(el)) return geometry.get(el)
      const view = el.ownerDocument.defaultView || window
      const style = view.getComputedStyle(el)
      const rect = style && style.visibility !== 'hidden' && style.display !== 'none'
        ? el.getBoundingClientRect() : null
      const visible = rect && rect.width > 1 && rect.height > 1 ? rect : null
      geometry.set(el, visible)
      return visible
    }
    const clip = (text, length) => {
      const normalized = String(text || '').replace(/\\s+/g, ' ').trim()
      return normalized.length > length ? normalized.slice(0, length - 3) + '...' : normalized
    }
    const elementText = (el) => clip(el.innerText || el.textContent || '', 120)
    const visibleText = (el) => {
      const rect = visibleRect(el)
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) return ''
      return clip(el.innerText || el.textContent || '', 240)
    }
    const cssIdentifier = (value) => globalThis.CSS?.escape
      ? globalThis.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
    const cssAttributeValue = (value) => String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"')
    const selector = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="switch"]', '[role="combobox"]', '[role="menuitem"]', '[role="textbox"]',
      '[contenteditable="true"]', 'summary'
    ].join(',')
    const candidates = []
    const headings = []
    const snippets = []
    const lines = []
    const seenLines = new Set()
    const hiddenAncestors = new WeakMap()
    const bodyElements = new WeakSet()
    const query = options.query?.toLocaleLowerCase()
    const controlDetails = (el) => {
      const root = el.getRootNode()
      const labelledBy = el.getAttribute('aria-labelledby')?.split(/\\s+/).map((id) =>
        root.getElementById?.(id)?.textContent || el.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim()
      const associated = el.labels && Array.from(el.labels).map((label) => label.textContent).join(' ').trim()
      const label = labelledBy || el.getAttribute('aria-label') || associated ||
        (el.id && root.querySelector('label[for="' + cssAttributeValue(el.id) + '"]')?.textContent) ||
        (el.closest('label')?.textContent) || el.textContent || undefined
      const sensitive = el.tagName.toLowerCase() === 'input' && el.type === 'password'
      const value = !sensitive && ('value' in el) ? String(el.value) : undefined
      return { label, value: value || undefined, sensitive }
    }
    const matchesQuery = (el) => {
      if (!query) return true
      const { label, value, sensitive } = controlDetails(el)
      return [el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'),
        el.getAttribute('name'), label, value, sensitive ? null : el.textContent]
        .some((text) => text?.toLocaleLowerCase().includes(query))
    }
    const roots = [{ root: scope, frame: null }]
    while (roots.length && scanned < MAX_SCAN_NODES) {
      const { root, frame } = roots.shift()
      const doc = root.ownerDocument || root
      const view = doc.defaultView || window
      const walker = doc.createTreeWalker(root, view.NodeFilter?.SHOW_ALL ?? 0xffffffff)
      // TreeWalker excludes its root node; scoped interactive elements must be included.
      let node = root.nodeType === 1 ? root : walker.nextNode()
      while (node && scanned < MAX_SCAN_NODES) {
        scanned++
        if (node.nodeType === 1) {
          if (node === doc.body || root === node || bodyElements.has(node.parentElement) ||
              node.getRootNode()?.nodeType === 11) bodyElements.add(node)
          hiddenAncestors.set(node, Boolean(hiddenAncestors.get(node.parentElement)) ||
            node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true')
          if (limit > 0 && node.matches(selector) && matchesQuery(node)) {
            if (candidateCount < MAX_REF_CANDIDATES) {
              candidateCount++
              const rect = visibleRect(node)
              if (rect) {
                let offset = { x: 0, y: 0 }
                for (let current = frame; current; current = current.ownerDocument.defaultView?.frameElement) {
                  const parentRect = current.getBoundingClientRect()
                  offset = { x: offset.x + parentRect.x, y: offset.y + parentRect.y }
                }
                const x = rect.x + offset.x
                const y = rect.y + offset.y
                candidates.push({ el: node, rect: { x, y, width: rect.width, height: rect.height },
                  inViewport: y + rect.height >= 0 && y <= window.innerHeight &&
                    x + rect.width >= 0 && x <= window.innerWidth })
              }
            } else truncated = true
          }
          if (headings.length < 12 && node.matches('h1,h2,h3,[role="heading"]')) {
            const text = visibleText(node)
            if (text && (!query || text.toLocaleLowerCase().includes(query))) headings.push(text)
          }
          if (snippets.length < 20 && node.matches('p,li')) {
            const text = visibleText(node)
            if (text.length >= 20 && (!query || text.toLocaleLowerCase().includes(query))) snippets.push(text)
          }
          if (node.shadowRoot) roots.push({ root: node.shadowRoot, frame })
          if (node.tagName?.toLowerCase() === 'iframe') {
            try {
              const inner = node.contentDocument
              if (inner) roots.push({ root: inner, frame: node })
              else inaccessibleFrames++
            } catch { inaccessibleFrames++ }
          }
        } else if (node.nodeType === 3 && textLength < 2000) {
          const parent = node.parentElement
          if (!parent || !bodyElements.has(parent) || hiddenAncestors.get(parent) ||
              ['script', 'style', 'noscript', 'template', 'svg'].includes(parent.tagName.toLowerCase())) {
            node = scanned < MAX_SCAN_NODES ? walker.nextNode() : null; continue
          }
          const text = clip(node.nodeValue || '', 240)
          if (!text || seenLines.has(text) || (query && !text.toLocaleLowerCase().includes(query))) {
            node = scanned < MAX_SCAN_NODES ? walker.nextNode() : null; continue
          }
          const rect = visibleRect(parent)
          if (rect && rect.bottom >= 0 && rect.top <= window.innerHeight) {
            seenLines.add(text)
            textLength += text.length + (lines.length ? 1 : 0)
            lines.push(text)
          }
        }
        node = scanned < MAX_SCAN_NODES ? walker.nextNode() : null
      }
    }
    if (scanned === MAX_SCAN_NODES || textLength >= 2000) truncated = true
    const nodes = candidates.sort((left, right) =>
      Number(!left.inViewport) - Number(!right.inViewport) ||
      left.rect.y - right.rect.y || left.rect.x - right.rect.x
    ).slice(0, limit)
    if (candidates.length > limit) truncated = true
    const refs = nodes.map(({ el, rect }, index) => {
      const ref = options.generation + ':' + (index + 1)
      registry.set(ref, el)
      const id = (el.id || '').trim() || undefined
      const role = (el.getAttribute('role') || '').trim() ||
        ({ a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', summary: 'button' }[el.tagName.toLowerCase()]) ||
        (el.tagName.toLowerCase() === 'input'
          ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button' }[el.type] || 'textbox')
          : undefined)
      const name = (el.getAttribute('name') || '').trim() || undefined
      const testId = (el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '').trim() || undefined
      const { label, value, sensitive } = controlDetails(el)
      const selectorHint = id ? '#' + cssIdentifier(id) : testId
        ? '[data-testid="' + cssAttributeValue(testId) + '"]' : undefined
      return {
        ref, tag: el.tagName.toLowerCase(), text: sensitive ? undefined : elementText(el) || undefined,
        label: clip(label, 120) || undefined, value: clip(value, 120) || undefined,
        checked: el.matches('input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch]')
          ? (('checked' in el ? Boolean(el.checked) : el.hasAttribute('checked')) || el.getAttribute('aria-checked') === 'true') : undefined,
        disabled: el.matches('button,input,select,textarea,option,[aria-disabled]')
          ? (('disabled' in el ? Boolean(el.disabled) : el.hasAttribute('disabled')) || el.getAttribute('aria-disabled') === 'true') : undefined,
        expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : undefined,
        ariaLabel: (el.getAttribute('aria-label') || '').trim() || undefined,
        placeholder: (el.getAttribute('placeholder') || '').trim() || undefined,
        href: (el.getAttribute('href') || '').trim() || undefined,
        id, role, name, testId, selectorHint,
        box: { x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height) }
      }
    })
    return {
      url: location.href,
      title: document.title || undefined,
      pageText: { headings, snippets, viewport: clip(
        (truncated ? '[Snapshot scan budget reached or output truncated: scan, candidate or ref limit reached; content and refs may be incomplete.] ' : '') +
        (inaccessibleFrames ? '[Cross-origin frames inaccessible: ' + inaccessibleFrames + '.] ' : '') + lines.join('\\n'), 2000
      ) },
      truncated,
      inaccessibleFrames,
      refs
    }
  })()`
}
