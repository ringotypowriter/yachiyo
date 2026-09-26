import type {
  BrowserPreviewReadingState,
  ReleaseBrowserPreviewResult
} from '@yachiyo/shared/protocol'

interface PreviewResource {
  protected: () => boolean
  shared: () => boolean
  current: () => boolean
  inspect: () => Promise<{ safe: boolean; reading: BrowserPreviewReadingState }>
  detach: () => void
  destroy: () => void
}

export async function releaseBrowserPreview(
  resource: PreviewResource,
  mode: 'auto' | 'close'
): Promise<ReleaseBrowserPreviewResult> {
  if (mode === 'close') {
    if (resource.shared()) resource.detach()
    else resource.destroy()
    return { released: true }
  }
  try {
    if (resource.protected()) return { released: false }
    const inspection = await resource.inspect()
    if (!inspection.safe || resource.protected() || !resource.current()) return { released: false }
    resource.destroy()
    return { released: true, reading: inspection.reading }
  } catch {
    // A crashed, inaccessible or nonresponding frame is not evidence of a safe page.
    return { released: false }
  }
}

/** Installed after frame loads and queried again before discard. Dirty is sticky until navigation.
 * This intentionally errs toward retaining editors/custom elements. It is not a general SPA
 * unsaved-state detector. Missing instrumentation or inaccessible frames must fail closed.
 */
export const BROWSER_PREVIEW_INSPECTION_SCRIPT = `(() => {
  const key = '__yachiyoPreviewReadState';
  let state = window[key];
  const tracked = !!state && state.document === document;
  if (!tracked) {
    state = { document, dirty: false };
    window[key] = state;
    document.addEventListener('input', () => { state.dirty = true }, true);
    document.addEventListener('change', () => { state.dirty = true }, true);
  }
  let unsafe = !tracked || state.dirty || document.readyState !== 'complete';
  const inspect = (root) => {
    for (const node of root.querySelectorAll('*')) {
      if (node.isContentEditable) unsafe = true;
      if (node.localName.includes('-') && !node.shadowRoot) unsafe = true;
      if (node.shadowRoot) inspect(node.shadowRoot);
      if (node instanceof HTMLInputElement) {
        if (node.type === 'file' && node.files.length) unsafe = true;
        if (node.value !== node.defaultValue || node.checked !== node.defaultChecked) unsafe = true;
      }
      if (node instanceof HTMLTextAreaElement && node.value !== node.defaultValue) unsafe = true;
      if (node instanceof HTMLSelectElement && [...node.options].some(option => option.selected !== option.defaultSelected)) unsafe = true;
      if (node instanceof HTMLMediaElement && !node.paused && !node.ended) unsafe = true;
    }
  };
  inspect(document);
  return { safe: !unsafe, scrollX, scrollY };
})()`

export async function inspectBrowserPreviewFrames(
  frames: Array<{ executeJavaScript: (script: string) => Promise<unknown> }>,
  zoom: number,
  timeoutMs = 1000
): Promise<{ safe: boolean; reading: BrowserPreviewReadingState }> {
  if (!frames.length) return { safe: false, reading: {} }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const results = await Promise.race([
      Promise.all(
        frames.map((frame) => frame.executeJavaScript(BROWSER_PREVIEW_INSPECTION_SCRIPT))
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Frame inspection timed out')), timeoutMs)
      })
    ])
    const valid = results.every(
      (result) =>
        !!result && typeof result === 'object' && (result as { safe?: unknown }).safe === true
    )
    const top = results[0] as { scrollX?: number; scrollY?: number }
    return {
      safe: valid,
      reading: { webScrollX: top?.scrollX ?? 0, webScrollY: top?.scrollY ?? 0, webZoom: zoom }
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
