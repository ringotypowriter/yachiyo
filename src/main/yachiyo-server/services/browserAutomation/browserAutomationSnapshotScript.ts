export function buildBrowserAutomationSnapshotScript(limit: number): string {
  return `(() => {
    const limit = ${JSON.stringify(limit)}
    const isVisible = (el) => {
      if (!(el instanceof Element)) return false
      const style = window.getComputedStyle(el)
      if (!style || style.visibility === 'hidden' || style.display === 'none') return false
      const rect = el.getBoundingClientRect()
      return rect.width > 1 && rect.height > 1
    }

    const clip = (text, length) => {
      const normalized = String(text || '').replace(/\\s+/g, ' ').trim()
      return normalized.length > length ? normalized.slice(0, length - 3) + '...' : normalized
    }

    const elementText = (el) => clip(el.innerText || el.textContent || '', 120)

    const visibleText = (el) => {
      if (!isVisible(el)) return ''
      const rect = el.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight) return ''
      return clip(el.innerText || el.textContent || '', 240)
    }

    const isInViewport = (el) => {
      const rect = el.getBoundingClientRect()
      return (
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight &&
        rect.right >= 0 &&
        rect.left <= window.innerWidth
      )
    }

    const compareDocumentPosition = (left, right) => {
      const leftRect = left.getBoundingClientRect()
      const rightRect = right.getBoundingClientRect()
      return leftRect.top - rightRect.top || leftRect.left - rightRect.left
    }

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
        const tag = node.tagName.toLowerCase()
        let index = 1
        let sibling = node.previousElementSibling
        while (sibling) {
          if (sibling.tagName === node.tagName) index++
          sibling = sibling.previousElementSibling
        }
        parts.unshift(tag + '[' + index + ']')
        node = node.parentElement
      }
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

    const nodes = Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .sort((left, right) => {
        const viewportOrder = Number(!isInViewport(left)) - Number(!isInViewport(right))
        return viewportOrder || compareDocumentPosition(left, right)
      })
      .slice(0, limit)

    const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .map(visibleText)
      .filter(Boolean)
      .slice(0, 12)

    const snippets = Array.from(document.querySelectorAll('main p, article p, p, li'))
      .map(visibleText)
      .filter((text) => text.length >= 20)
      .slice(0, 20)

    const isReadableTextParent = (el) => {
      if (!(el instanceof Element)) return false
      const tag = el.tagName.toLowerCase()
      if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) return false
      if (el.closest('[hidden],[aria-hidden="true"]')) return false
      return isVisible(el)
    }

    const visibleTextNodeLines = () => {
      const walker = document.createTreeWalker(document.body, window.NodeFilter?.SHOW_TEXT ?? 4)
      const lines = []
      let node = walker.nextNode()
      while (node) {
        const parent = node.parentElement
        if (parent && isReadableTextParent(parent)) {
          const rect = parent.getBoundingClientRect()
          if (rect.bottom >= 0 && rect.top <= window.innerHeight) {
            const text = clip(node.nodeValue || '', 240)
            if (text) lines.push(text)
          }
        }
        node = walker.nextNode()
      }
      return lines
    }

    const viewport = clip(
      visibleTextNodeLines()
        .filter((text, index, all) => all.indexOf(text) === index)
        .join('\\n'),
      2000
    )

    const refs = nodes.map((el) => {
      const rect = el.getBoundingClientRect()
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
        xpath: toXpath(el)
      }
    })

    return {
      url: location.href,
      title: document.title || undefined,
      pageText: { headings, snippets, viewport },
      refs
    }
  })()`
}
