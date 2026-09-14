export function buildBrowserAutomationSnapshotScript(limit: number): string {
  return `(() => {
    const limit = ${JSON.stringify(limit)}
    // These bound explicit DOM work, not wall time: browser layout and text getters
    // can themselves be expensive. Results beyond the scan budgets are omitted.
    const MAX_SCAN_NODES = 10000
    const MAX_REF_CANDIDATES = 1000
    let xpathSteps = 10000
    let truncated = false
    const geometry = new WeakMap()
    const visibleRect = (el) => {
      if (!(el instanceof Element)) return null
      if (geometry.has(el)) return geometry.get(el)
      const style = window.getComputedStyle(el)
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

    const isInViewport = (rect) => (
      rect.bottom >= 0 && rect.top <= window.innerHeight &&
      rect.right >= 0 && rect.left <= window.innerWidth
    )

    const cssIdentifier = (value) => {
      if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
        return globalThis.CSS.escape(value)
      }
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
    }

    const cssAttributeValue = (value) => String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"')

    const toXpath = (el) => {
      if (!(el instanceof Element)) return ''
      if (el.id) return '//*[@id=' + JSON.stringify(el.id) + ']'
      const parts = []
      let node = el
      while (node && node.nodeType === 1 && parts.length < 32) {
        if (xpathSteps-- <= 0) { truncated = true; return '' }
        const tag = node.tagName.toLowerCase()
        let index = 1
        let sibling = node.previousElementSibling
        while (sibling) {
          if (xpathSteps-- <= 0) { truncated = true; return '' }
          if (sibling.tagName === node.tagName) index++
          sibling = sibling.previousElementSibling
        }
        parts.unshift(tag + '[' + index + ']')
        node = node.parentElement
      }
      if (node && node.nodeType === 1) { truncated = true; return '' }
      return '/' + parts.join('/')
    }

    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[contenteditable="true"]'
    ].join(',')

    const candidates = []
    const headings = []
    const snippets = []
    const lines = []
    const seenLines = new Set()
    const hiddenAncestors = new WeakMap()
    const bodyElements = new WeakSet()
    let textLength = 0
    let candidateCount = 0
    let scanned = 0
    // SHOW_ALL is intentional: a filtered walker may traverse unbounded numbers
    // of nonmatching nodes inside a single nextNode() call.
    const walker = document.createTreeWalker(document, window.NodeFilter?.SHOW_ALL ?? 0xffffffff)
    while (scanned < MAX_SCAN_NODES) {
      const node = walker.nextNode()
      if (!node) break
      scanned++
      if (node instanceof Element) {
        if (node === document.body || bodyElements.has(node.parentElement)) bodyElements.add(node)
        hiddenAncestors.set(node, Boolean(hiddenAncestors.get(node.parentElement)) ||
          node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true')
        if (limit > 0 && node.matches(selector)) {
          if (candidateCount < MAX_REF_CANDIDATES) {
            candidateCount++
            const rect = visibleRect(node)
            if (rect) candidates.push({ el: node, rect, inViewport: isInViewport(rect) })
          } else truncated = true
        }
        if (headings.length < 12 && node.matches('h1,h2,h3,[role="heading"]')) {
          const text = visibleText(node)
          if (text) headings.push(text)
        }
        if (snippets.length < 20 && node.matches('p,li')) {
          const text = visibleText(node)
          if (text.length >= 20) snippets.push(text)
        }
      } else if (node.nodeType === 3 && textLength < 2000) {
        const parent = node.parentElement
        if (!parent || !bodyElements.has(parent) || hiddenAncestors.get(parent) ||
            ['script', 'style', 'noscript', 'template', 'svg'].includes(parent.tagName.toLowerCase())) continue
        const text = clip(node.nodeValue || '', 240)
        if (!text || seenLines.has(text)) continue
        const rect = visibleRect(parent)
        if (rect && rect.bottom >= 0 && rect.top <= window.innerHeight) {
          seenLines.add(text)
          textLength += text.length + (lines.length ? 1 : 0)
          lines.push(text)
        }
      }
    }
    if (scanned === MAX_SCAN_NODES) truncated = true
    const nodes = candidates.sort((left, right) =>
      Number(!left.inViewport) - Number(!right.inViewport) ||
      left.rect.top - right.rect.top || left.rect.left - right.rect.left
    ).slice(0, limit)

    const refs = nodes.flatMap(({ el, rect }) => {
      const xpath = toXpath(el)
      if (!xpath) return []
      const id = (el.id || '').trim() || undefined
      const role = (el.getAttribute('role') || '').trim() || undefined
      const name = (el.getAttribute('name') || '').trim() || undefined
      const testId = (el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '').trim() || undefined
      const selectorHint = id
        ? '#' + cssIdentifier(id)
        : testId
          ? '[data-testid="' + cssAttributeValue(testId) + '"]'
          : undefined
      return {
        tag: el.tagName.toLowerCase(),
        text: elementText(el) || undefined,
        ariaLabel: (el.getAttribute('aria-label') || '').trim() || undefined,
        placeholder: (el.getAttribute('placeholder') || '').trim() || undefined,
        href: (el instanceof HTMLAnchorElement ? el.href : (el.getAttribute('href') || '').trim()) || undefined,
        id,
        role,
        name,
        testId,
        selectorHint,
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        xpath
      }
    })

    return {
      url: location.href,
      title: document.title || undefined,
      pageText: { headings, snippets, viewport: clip(
        (truncated ? '[Snapshot scan budget reached; content and refs may be incomplete.] ' : '') + lines.join('\\n'),
        2000
      ) },
      refs
    }
  })()`
}
