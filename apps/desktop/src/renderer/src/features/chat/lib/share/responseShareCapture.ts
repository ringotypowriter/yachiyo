import {
  allocateSharePages,
  measureShareUnits,
  renderSharePageContent,
  SHARE_PAGE_HEIGHT,
  SHARE_WIDTH,
  type ShareLayout
} from './responseSharePagination'

export { SHARE_WIDTH } from './responseSharePagination'

type ImageEngine = Pick<typeof import('html-to-image'), 'toBlob' | 'getFontEmbedCSS'>
export interface ShareCaptureOptions {
  layout: ShareLayout
  signal: AbortSignal
  ready?: () => Promise<void>
  timeoutMs?: number
}
export interface ShareCaptureDependencies {
  loadEngine: () => Promise<ImageEngine>
  prepare: (
    root: HTMLElement,
    options: ShareCaptureOptions
  ) => Promise<{ pages: HTMLElement[]; dispose: () => void }>
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Share generation cancelled', 'AbortError')
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException('Share generation cancelled', 'AbortError'))
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Response image preparation timed out. Retry after content finishes loading.'
              )
            ),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
  }
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

async function waitForResources(root: HTMLElement, options: ShareCaptureOptions): Promise<void> {
  await options.ready?.()
  await root.ownerDocument.fonts.ready
  let stable = 0
  let last = ''
  while (stable < 3) {
    checkAbort(options.signal)
    await frame()
    if (root.querySelector('[data-share-error]'))
      throw new Error('Some response content failed to render. Retry before sharing.')
    if (
      root.querySelector('[data-share-pending],[data-share-code-pending]') ||
      Array.from(root.querySelectorAll('[data-streamdown="mermaid-block"]')).some(
        (block) => !block.querySelector('[aria-label="Mermaid chart"] svg')
      )
    ) {
      stable = 0
      continue
    }
    const images = Array.from(root.querySelectorAll('img'))
    await Promise.all(
      images.map(async (image) => {
        if (!image.complete || !image.naturalWidth) {
          if (image.complete)
            throw new Error('An image failed to load. Remove it or retry before sharing.')
        }
        await image.decode()
        if (!image.naturalWidth) throw new Error('An image is unavailable for sharing')
      })
    )
    const geometry = Array.from(root.querySelectorAll('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return `${rect.x},${rect.y},${rect.width},${rect.height}`
      })
      .join(';')
    stable = geometry === last ? stable + 1 : 0
    last = geometry
  }
}

/** Reuse decoded image pixels, including the exact query-bearing resource identity.
 * Never fetch a URL to recover an unloaded/tainted image. */
function inlineLoadedImages(source: HTMLElement, clone: HTMLElement): void {
  const originals = Array.from(source.querySelectorAll('img'))
  const copies = Array.from(clone.querySelectorAll('img'))
  if (originals.length !== copies.length)
    throw new Error('Share image tree changed while preparing')
  originals.forEach((image, index) => {
    if (!image.complete || !image.naturalWidth) throw new Error('An image is not ready for sharing')
    const canvas = source.ownerDocument.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image conversion is unavailable')
    context.drawImage(image, 0, 0)
    try {
      copies[index]!.src = canvas.toDataURL('image/png')
      copies[index]!.removeAttribute('srcset')
      copies[index]!.removeAttribute('loading')
    } catch {
      throw new Error(
        'A loaded image cannot be shared because its origin does not permit pixel access. No replacement image was downloaded.'
      )
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  })
}

async function preparePages(
  root: HTMLElement,
  options: ShareCaptureOptions
): Promise<{ pages: HTMLElement[]; dispose: () => void }> {
  await waitForResources(root, options)
  checkAbort(options.signal)
  const host = root.ownerDocument.createElement('div')
  const dispose = (): void => {
    host.remove()
    options.signal.removeEventListener('abort', dispose)
  }
  options.signal.addEventListener('abort', dispose, { once: true })
  Object.assign(host.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${SHARE_WIDTH}px`,
    pointerEvents: 'none'
  })
  host.setAttribute('aria-hidden', 'true')
  root.ownerDocument.body.append(host)
  try {
    checkAbort(options.signal)
    const full = root.cloneNode(true) as HTMLElement
    inlineLoadedImages(root, full)
    Object.assign(full.style, { width: `${SHARE_WIDTH}px`, height: 'auto', maxHeight: 'none' })
    host.append(full)
    await waitForResources(full, { ...options, ready: undefined })
    const content = full.querySelector<HTMLElement>('[data-share-content]')
    if (!content) throw new Error('Share document is missing its content container')
    const fullHeight = Math.ceil(full.getBoundingClientRect().height)
    if (options.layout === 'long' || fullHeight <= SHARE_PAGE_HEIGHT) {
      allocateSharePages([{ height: fullHeight }], { layout: options.layout, chromeHeight: 0 })
      const number = full.querySelector('[data-share-page-number]')
      if (number) number.textContent = '1 / 1'
      if (full.scrollWidth > SHARE_WIDTH + 1)
        throw new Error('Share content overflows the image width')
      return { pages: [full], dispose }
    }
    const chromeHeight = Math.ceil(
      full.getBoundingClientRect().height - content.getBoundingClientRect().height
    )
    const cap = SHARE_PAGE_HEIGHT - chromeHeight
    const units = measureShareUnits(content, cap)
    const allocations = allocateSharePages(units, { layout: options.layout, chromeHeight })
    const pages = allocations.map((allocation, index) => {
      const page = full.cloneNode(true) as HTMLElement
      page
        .querySelector('[data-share-content]')!
        .replaceWith(renderSharePageContent(content, allocation))
      const number = page.querySelector('[data-share-page-number]')
      if (number) number.textContent = `${index + 1} / ${allocations.length}`
      host.append(page)
      return page
    })
    full.remove()
    for (const page of pages) {
      await waitForResources(page, { ...options, ready: undefined })
      const height = Math.ceil(page.getBoundingClientRect().height)
      const limit = SHARE_PAGE_HEIGHT
      if (height > limit)
        throw new Error(
          `Rendered page exceeds ${limit}px after pagination. Reduce content or use Long image.`
        )
      if (page.scrollWidth > SHARE_WIDTH + 1)
        throw new Error('Share content overflows the image width')
    }
    checkAbort(options.signal)
    return { pages, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

const defaultDependencies: ShareCaptureDependencies = {
  loadEngine: () => import('html-to-image'),
  prepare: preparePages
}

/** Captures serially; callers own preview URLs. A cancelled batch never returns partial PNGs. */
export async function captureResponseShare(
  root: HTMLElement,
  options: ShareCaptureOptions,
  dependencies: ShareCaptureDependencies = defaultDependencies
): Promise<Blob[]> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) controller.abort()
  const localOptions = { ...options, signal: controller.signal }
  let prepared: Awaited<ReturnType<ShareCaptureDependencies['prepare']>> | undefined
  const work = async (): Promise<Blob[]> => {
    try {
      checkAbort(controller.signal)
      prepared = await dependencies.prepare(root, localOptions)
      checkAbort(controller.signal)
      const engine = await dependencies.loadEngine()
      checkAbort(controller.signal)
      const fontEmbedCSS = await engine.getFontEmbedCSS(prepared.pages[0]!, {
        includeQueryParams: true
      })
      const blobs: Blob[] = []
      for (const page of prepared.pages) {
        checkAbort(controller.signal)
        const blob = await engine.toBlob(page, {
          width: SHARE_WIDTH,
          height: Math.ceil(page.getBoundingClientRect().height),
          pixelRatio: 2,
          includeQueryParams: true,
          fontEmbedCSS,
          cacheBust: false,
          skipAutoScale: true
        })
        checkAbort(controller.signal)
        if (!blob || blob.type !== 'image/png' || !blob.size)
          throw new Error('PNG generation failed')
        blobs.push(blob)
      }
      return blobs
    } finally {
      prepared?.dispose()
    }
  }
  try {
    return await bounded(work(), controller.signal, options.timeoutMs ?? 30000)
  } finally {
    controller.abort()
    prepared?.dispose()
    options.signal.removeEventListener('abort', abort)
  }
}
