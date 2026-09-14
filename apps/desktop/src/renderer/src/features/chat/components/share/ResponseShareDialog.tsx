import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Download, Image, RefreshCw } from 'lucide-react'
import { AppDialog } from '@renderer/components/AppDialog'
import { SimpleSelect } from '../../../../../settings/components/primitives'
import type { ResponseShareSnapshot } from '../../lib/share/responseShareModel'
import { useResponseShareTheme } from '../../lib/share/responseShareTheme'
import { captureResponseShare } from '../../lib/share/responseShareCapture'
import { ShareDocument, type ShareDocumentOptions } from './ShareDocument'

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function ResponseShareDialog({
  snapshot,
  onClose
}: {
  snapshot: ResponseShareSnapshot
  onClose: () => void
}): React.JSX.Element {
  const theme = useResponseShareTheme()
  const [options, setOptions] = useState<ShareDocumentOptions>({
    includeQuestion: false,
    toolDetails: false,
    toolOverrides: {},
    hiddenBlocks: []
  })
  const [layout, setLayout] = useState<'auto' | 'long' | 'pages'>('auto')
  const [pages, setPages] = useState<Blob[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [generating, setGenerating] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const rootRef = useRef<HTMLElement>(null)
  const generation = useRef<AbortController | null>(null)
  const hasContent = snapshot.blocks.some(
    (block) => block.kind !== 'user' && !options.hiddenBlocks.includes(block.id)
  )
  useEffect(() => {
    const controller = new AbortController()
    generation.current = controller
    setPages([])
    setPageIndex(0)
    setGenerating(true)
    setNotice('')
    if (!hasContent) {
      setGenerating(false)
      setNotice('Include at least one response or tool block.')
      return () => controller.abort()
    }
    const root = rootRef.current
    if (root)
      void captureResponseShare(root, { layout, signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) {
            setPages(result)
            setGenerating(false)
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setGenerating(false)
            setNotice(error instanceof Error ? error.message : 'Could not generate image.')
          }
        })
    return () => controller.abort()
  }, [snapshot, options, layout, retry, hasContent, theme])
  useEffect(() => {
    const page = pages[pageIndex]
    const url = page ? URL.createObjectURL(page) : undefined
    setPreviewUrl(url)
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [pages, pageIndex])
  const close = (): void => {
    generation.current?.abort()
    onClose()
  }
  async function exportImage(copy: boolean): Promise<void> {
    const current = generation.current
    if (!current || current.signal.aborted || !pages.length || generating || saving) return
    const isCurrent = (): boolean => generation.current === current && !current.signal.aborted
    setSaving(true)
    setNotice('')
    try {
      if (copy) {
        const src = await blobDataUrl(pages[pageIndex])
        if (!isCurrent()) return
        await window.api.yachiyo.copyImageToClipboard({ src })
        if (isCurrent()) setNotice('Current page copied.')
      } else if (pages.length === 1) {
        const pngData = await pages[0].arrayBuffer()
        if (!isCurrent()) return
        const result = await window.api.yachiyo.savePngFile({
          pngData,
          defaultFilename: 'yachiyo-response.png'
        })
        if (isCurrent() && !result.canceled) setNotice('Image saved.')
      } else {
        const buffers = await Promise.all(pages.map((page) => page.arrayBuffer()))
        if (!isCurrent()) return
        const result = await window.api.yachiyo.savePngFiles({
          pages: buffers,
          filenamePrefix: 'yachiyo-response'
        })
        if (isCurrent() && !result.canceled) setNotice('All pages saved.')
      }
    } catch (error) {
      if (isCurrent()) setNotice(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <AppDialog
      title="Share response"
      description="Create a read-only image. Review the preview before sharing."
      onClose={close}
      showCloseButton
      width={1060}
      height="min(850px, calc(100vh - 32px))"
      bodyStyle={{ minHeight: 0, overflow: 'auto' }}
    >
      <div className="response-share-dialog">
        <fieldset className="response-share-options" disabled={saving}>
          <label>
            <input
              type="checkbox"
              checked={options.includeQuestion}
              disabled={!snapshot.question}
              onChange={(event) =>
                setOptions({
                  ...options,
                  includeQuestion: event.target.checked
                })
              }
            />
            Include question
          </label>
          <p className="response-share-hint">Uses your current app theme and fonts.</p>
          <div>
            <h3>Layout</h3>
            <SimpleSelect
              value={layout}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'long', label: 'Long image' },
                { value: 'pages', label: 'Pages' }
              ]}
              onChange={setLayout}
              width="100%"
            />
          </div>
          <label>
            <input
              type="checkbox"
              checked={options.toolDetails}
              onChange={(event) =>
                setOptions({
                  ...options,
                  toolDetails: event.target.checked,
                  toolOverrides: {}
                })
              }
            />
            Show all tool details
          </label>
          <p className="response-share-hint">
            Tool details may contain local paths or private data. Review before sharing.
          </p>
          <details>
            <summary>Included blocks</summary>
            <p className="response-share-hint">Hidden blocks mark the image as an excerpt.</p>
            {snapshot.blocks
              .filter((block) => options.includeQuestion || block.kind !== 'user')
              .map((block, index) => (
                <div className="response-share-block-option" key={block.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!options.hiddenBlocks.includes(block.id)}
                      onChange={(event) =>
                        setOptions({
                          ...options,
                          hiddenBlocks: event.target.checked
                            ? options.hiddenBlocks.filter((id) => id !== block.id)
                            : [...options.hiddenBlocks, block.id]
                        })
                      }
                    />
                    {index + 1}.{' '}
                    {block.kind === 'tool'
                      ? block.toolCall.toolName
                      : block.kind === 'user'
                        ? 'User message'
                        : 'Response text'}
                  </label>
                  {block.kind === 'tool' ? (
                    <label className="response-share-detail-option">
                      <input
                        type="checkbox"
                        checked={options.toolOverrides[block.id] ?? options.toolDetails}
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            toolOverrides: {
                              ...options.toolOverrides,
                              [block.id]: event.target.checked
                            }
                          })
                        }
                      />
                      Details
                    </label>
                  ) : null}
                  {block.kind !== 'tool' ? (
                    <p className="response-share-hint">
                      {block.content.slice(0, 90)}
                      {block.content.length > 90 ? '…' : ''}
                    </p>
                  ) : null}
                </div>
              ))}
          </details>
        </fieldset>
        <div className="response-share-preview-panel">
          <div className="response-share-preview" aria-busy={generating}>
            {previewUrl && !generating ? (
              <img
                src={previewUrl}
                alt={`Final PNG preview, page ${pageIndex + 1} of ${pages.length}`}
              />
            ) : (
              <div className="response-share-empty">
                <Image size={32} />
                <span>{generating ? 'Preparing image…' : 'No preview available'}</span>
                {!generating ? (
                  <button onClick={() => setRetry((value) => value + 1)}>
                    <RefreshCw size={15} />
                    Try again
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <div className="response-share-toolbar">
            <button
              aria-label="Previous page"
              disabled={pageIndex === 0 || generating}
              onClick={() => setPageIndex((value) => value - 1)}
            >
              <ChevronLeft size={17} />
            </button>
            <span>{pages.length ? `${pageIndex + 1} / ${pages.length}` : 'Preview'}</span>
            <button
              aria-label="Next page"
              disabled={pageIndex >= pages.length - 1 || generating}
              onClick={() => setPageIndex((value) => value + 1)}
            >
              <ChevronRight size={17} />
            </button>
            <span className="response-share-spacer" />
            <button
              disabled={!pages.length || generating || saving || !hasContent}
              onClick={() => void exportImage(true)}
            >
              <Copy size={16} />
              Copy image
            </button>
            <button
              disabled={!pages.length || generating || saving || !hasContent}
              onClick={() => void exportImage(false)}
            >
              <Download size={16} />
              {pages.length > 1 ? 'Save all' : 'Save image'}
            </button>
          </div>
          <p role="status" className="response-share-notice">
            {notice ||
              (pages.length > 1
                ? 'Each page is copied separately. Save all exports the complete set.'
                : '')}
          </p>
        </div>
      </div>
      <div className="response-share-staging" aria-hidden="true">
        <ShareDocument
          key={`${JSON.stringify(options)}:${JSON.stringify(theme)}:${retry}`}
          snapshot={snapshot}
          options={options}
          theme={theme}
          documentRef={rootRef}
        />
      </div>
    </AppDialog>
  )
}
