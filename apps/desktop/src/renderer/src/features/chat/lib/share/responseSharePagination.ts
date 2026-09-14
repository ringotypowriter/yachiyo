export const SHARE_WIDTH = 720
export const SHARE_PAGE_HEIGHT = 1080
export const SHARE_LONG_HEIGHT = 6000
export const SHARE_MAX_PAGES = 30
export type ShareLayout = 'auto' | 'pages' | 'long'

export interface ShareUnit {
  height: number
  keepWithNext?: boolean
  /** Repeated fragment chrome, charged once per contiguous group on each page. */
  overhead?: number
  group?: unknown
}

/** Pure allocation: limits include the repeated document chrome; never drops units. */
export function allocateSharePages<T extends ShareUnit>(
  units: readonly T[],
  options: { layout: ShareLayout; chromeHeight: number }
): T[][] {
  const { layout, chromeHeight } = options
  if (!Number.isFinite(chromeHeight) || chromeHeight < 0)
    throw new Error('Invalid share document chrome')
  if (
    units.some(
      (unit) =>
        !Number.isFinite(unit.height) ||
        unit.height < 0 ||
        !Number.isFinite(unit.overhead ?? 0) ||
        (unit.overhead ?? 0) < 0
    )
  ) {
    throw new Error('Invalid share content measurement')
  }
  const cost = (unit: T, previous?: T): number =>
    unit.height +
    (unit.group !== undefined && previous?.group === unit.group ? 0 : (unit.overhead ?? 0))
  const fullHeight =
    chromeHeight + units.reduce((sum, unit, index) => sum + cost(unit, units[index - 1]), 0)
  if (layout === 'long') {
    if (fullHeight > SHARE_LONG_HEIGHT)
      throw new Error('Long image exceeds 6000px. Choose Pages instead.')
    return [[...units]]
  }
  if (fullHeight <= SHARE_PAGE_HEIGHT) return [[...units]]
  const capacity = SHARE_PAGE_HEIGHT - chromeHeight
  if (capacity <= 0) throw new Error('Share header and footer exceed the page height')
  const pages: T[][] = []
  let page: T[] = []
  let used = 0
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!
    if (cost(unit) > capacity) throw new Error('A share content fragment is too tall for a page')
    let required = cost(unit, page[page.length - 1])
    for (let next = index; units[next]?.keepWithNext && next + 1 < units.length; next++) {
      required += cost(units[next + 1]!, units[next])
    }
    if (required > capacity && unit.keepWithNext)
      throw new Error('A heading and its following content cannot fit on one page')
    if (page.length && used + required > capacity) {
      pages.push(page)
      page = []
      used = 0
    }
    used += cost(unit, page[page.length - 1])
    page.push(unit)
  }
  if (page.length) pages.push(page)
  if (pages.length > SHARE_MAX_PAGES)
    throw new Error('Response exceeds 30 pages. Reduce the selected content.')
  return pages.length ? pages : [[]]
}

export interface DOMShareUnit extends ShareUnit {
  source: HTMLElement
  range?: Range
  scale?: number
  continuation?: string
  clone?: HTMLElement
  /** Text owned directly by a mixed-content wrapper, not a new wrapper clone. */
  direct?: boolean
}

function textLines(element: HTMLElement, directNode?: Node): Range[] {
  const doc = element.ownerDocument
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const lines: Range[] = []
  let current: Range | undefined
  let top: number | undefined
  const nodes: Node[] = []
  if (directNode) nodes.push(directNode)
  else {
    let node: Node | null
    while ((node = walker.nextNode())) nodes.push(node)
  }
  for (const node of nodes) {
    for (let offset = 0; offset < (node.textContent?.length ?? 0); offset++) {
      const character = doc.createRange()
      character.setStart(node, offset)
      character.setEnd(node, offset + 1)
      const rect = character.getBoundingClientRect()
      if (!rect.height) continue
      if (top === undefined || Math.abs(rect.top - top) > 2) {
        current = doc.createRange()
        current.setStart(node, offset)
        current.setEnd(node, offset + 1)
        lines.push(current)
        top = rect.top
      } else current!.setEnd(node, offset + 1)
    }
  }
  // Include whitespace and inline DOM between visible lines, without changing markup.
  if (lines.length) {
    lines[0]!.setStart(directNode ?? element, 0)
    for (let index = 0; index < lines.length - 1; index++) {
      const next = lines[index + 1]!
      lines[index]!.setEnd(next.startContainer, next.startOffset)
    }
    lines[lines.length - 1]!.setEnd(
      directNode ?? element,
      directNode ? (directNode.textContent?.length ?? 0) : element.childNodes.length
    )
  }
  return lines
}

/** Measure the complete readonly DOM, not a canvas. Ranges preserve inline markup. */
export function measureShareUnits(content: HTMLElement, capacity: number): DOMShareUnit[] {
  const units: DOMShareUnit[] = []
  const visit = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    if (!rect.height) return
    const style = getComputedStyle(element)
    const margins =
      Math.max(0, parseFloat(style.marginTop) || 0) +
      Math.max(0, parseFloat(style.marginBottom) || 0)
    const height = rect.height + margins
    let ancestorChrome = 0
    for (
      let parent = element.parentElement;
      parent && parent !== content;
      parent = parent.parentElement
    ) {
      const css = getComputedStyle(parent)
      ancestorChrome += [
        'paddingTop',
        'paddingBottom',
        'borderTopWidth',
        'borderBottomWidth',
        'marginTop',
        'marginBottom'
      ].reduce(
        (sum, key) =>
          sum + Math.max(0, parseFloat(css[key as keyof CSSStyleDeclaration] as string) || 0),
        0
      )
    }
    const available = capacity - ancestorChrome - 24
    const heading = /^H[1-6]$/.test(element.tagName)
    const media = element.matches('img,svg,canvas,[data-share-atomic],.mermaid')
    if (media) {
      const scale = Math.min(1, available / height)
      units.push({ source: element, height: height * scale + ancestorChrome, scale })
      return
    }
    if (element.tagName === 'TR') {
      if (element.closest('thead')) return
      const table = element.closest('table')
      const headHeight = table?.querySelector('thead')?.getBoundingClientRect().height ?? 0
      if (height + headHeight > available) {
        const cells = Array.from(element.children) as HTMLElement[]
        if (element.querySelector('[rowspan]:not([rowspan="1"]),img,svg,table'))
          throw new Error(
            'An oversized table row contains merged cells or media and cannot be safely split'
          )
        const lines = cells.map((cell) => textLines(cell))
        const count = Math.max(...lines.map((cell) => cell.length))
        if (!count) throw new Error('An oversized table row has no measurable text lines')
        for (let line = 0; line < count; line++) {
          const row = element.cloneNode(false) as HTMLElement
          let lineHeight = 0
          cells.forEach((cell, column) => {
            const clone = cell.cloneNode(false) as HTMLElement
            const range = lines[column]![line]
            if (range) {
              clone.append(range.cloneContents())
              lineHeight = Math.max(lineHeight, range.getBoundingClientRect().height)
            }
            clone.style.width = `${cell.getBoundingClientRect().width}px`
            row.append(clone)
          })
          const padding = Math.max(
            ...cells.map((cell) => {
              const css = getComputedStyle(cell)
              return (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0) + 2
            })
          )
          units.push({
            source: element,
            clone: row,
            height: lineHeight + padding,
            overhead: headHeight + ancestorChrome,
            group: table
          })
        }
        return
      }
      units.push({ source: element, height, overhead: headHeight + ancestorChrome, group: table })
      return
    }
    if (element.tagName === 'THEAD') return
    const previous = units[units.length - 1]
    const followsHeading =
      previous?.keepWithNext && previous.height + height + ancestorChrome > capacity
    if (height <= available && !followsHeading) {
      units.push({ source: element, height: height + ancestorChrome, keepWithNext: heading })
      return
    }
    const leaf = heading || element.matches('p,pre,li,blockquote') || !element.children.length
    if (leaf && !element.querySelector('img,svg,table,pre,p,ul,ol,blockquote')) {
      const lines = heading ? [] : textLines(element)
      if (lines.length > 1) {
        const firstTop = lines[0]!.getBoundingClientRect().top
        const lastBottom = lines[lines.length - 1]!.getBoundingClientRect().bottom
        const overhead = Math.max(0, height - (lastBottom - firstTop))
        lines.forEach((range, index) => {
          const bounds = range.getBoundingClientRect()
          const next = lines[index + 1]?.getBoundingClientRect()
          units.push({
            source: element,
            range,
            height: next ? next.top - bounds.top : bounds.height,
            overhead: overhead + ancestorChrome + 24,
            group: element,
            continuation: element.tagName === 'PRE' ? 'Code (continued)' : undefined
          })
        })
      } else units.push({ source: element, height, keepWithNext: heading })
      return
    }
    if (element.children.length) {
      // childNodes, not children: direct prose surrounding nested lists/images is content too.
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === 1) visit(child as HTMLElement)
        else if (child.nodeType === 3 && child.textContent) {
          const lines = textLines(element, child)
          if (!lines.length) {
            const range = element.ownerDocument.createRange()
            range.selectNodeContents(child)
            lines.push(range)
          }
          const css = getComputedStyle(element)
          const ownChrome = [
            'paddingTop',
            'paddingBottom',
            'borderTopWidth',
            'borderBottomWidth'
          ].reduce(
            (sum, key) => sum + (parseFloat(css[key as keyof CSSStyleDeclaration] as string) || 0),
            margins
          )
          lines.forEach((range, index) => {
            const bounds = range.getBoundingClientRect()
            const next = lines[index + 1]?.getBoundingClientRect()
            units.push({
              source: element,
              range,
              direct: true,
              height: Math.max(0, next ? next.top - bounds.top : bounds.height),
              overhead: ancestorChrome + ownChrome,
              group: element
            })
          })
        }
      }
    } else units.push({ source: element, height })
  }
  Array.from(content.children).forEach((child) => visit(child as HTMLElement))
  return units
}

/** A finite page built from DOM fragments. No full-response bitmap or cropping. */
export function renderSharePageContent(content: HTMLElement, units: DOMShareUnit[]): HTMLElement {
  const result = content.cloneNode(false) as HTMLElement
  result.removeAttribute('id')
  const wrappers = new Map<HTMLElement, HTMLElement>([[content, result]])
  const setListStart = (source: HTMLElement, wrapper: HTMLElement): void => {
    if (source.parentElement?.tagName !== 'OL' || wrapper.children.length) return
    const list = source.parentElement
    const items = Array.from(list.children)
    const direction = list.hasAttribute('reversed') ? -1 : 1
    let ordinal = list.hasAttribute('start')
      ? Number(list.getAttribute('start'))
      : direction === -1
        ? items.length
        : 1
    for (const item of items) {
      if (item.hasAttribute('value')) ordinal = Number(item.getAttribute('value'))
      if (item === source) break
      ordinal += direction
    }
    wrapper.setAttribute('start', String(ordinal))
  }
  const ensureWrapper = (source: HTMLElement): HTMLElement => {
    const existing = wrappers.get(source)
    if (existing) return existing
    const wrapper = source.cloneNode(false) as HTMLElement
    wrappers.set(source, wrapper)
    if (source.matches('.response-share-tool,[data-share-tool]')) {
      const heading = source.querySelector('.response-share-tool-heading')
      const first = units.find((unit) => source.contains(unit.source))
      if (heading && first && !heading.contains(first.source)) {
        const label = heading.cloneNode(true) as HTMLElement
        label.append(source.ownerDocument.createTextNode(' (continued)'))
        wrapper.append(label)
      }
    }
    if (source.tagName === 'TABLE') {
      const head = source.querySelector('thead')
      if (head) wrapper.append(head.cloneNode(true))
    }
    const parent = ensureWrapper(source.parentElement!)
    setListStart(source, parent)
    parent.append(wrapper)
    return wrapper
  }
  for (let index = 0; index < units.length;) {
    const unit = units[index]!
    let end = index + 1
    while (
      end < units.length &&
      units[end]!.source === unit.source &&
      units[end]!.direct === unit.direct &&
      unit.range &&
      units[end]!.range
    )
      end++
    const fragment = unit.clone
      ? (unit.clone.cloneNode(true) as HTMLElement)
      : (unit.source.cloneNode(!unit.range) as HTMLElement)
    if (unit.range) {
      const range = unit.range.cloneRange()
      const last = units[end - 1]!.range!
      range.setEnd(last.endContainer, last.endOffset)
      if (unit.direct) {
        ensureWrapper(unit.source).append(range.cloneContents())
        index = end
        continue
      }
      fragment.append(range.cloneContents())
      if (unit.range.startContainer !== unit.source || unit.range.startOffset !== 0) {
        fragment.style.marginTop = '0'
        if (unit.continuation) {
          const label = content.ownerDocument.createElement('div')
          label.textContent = unit.continuation
          label.style.cssText = 'font-size:11px;line-height:18px;opacity:0.65'
          ensureWrapper(unit.source.parentElement!).append(label)
        }
      }
    }
    if (unit.scale && unit.scale < 1) {
      fragment.style.width = `${unit.source.getBoundingClientRect().width * unit.scale}px`
      fragment.style.height = `${unit.source.getBoundingClientRect().height * unit.scale}px`
      fragment.style.objectFit = 'contain'
    }
    const wrapper = ensureWrapper(unit.source.parentElement!)
    setListStart(unit.source, wrapper)
    wrapper.append(fragment)
    index = end
  }
  return result
}
