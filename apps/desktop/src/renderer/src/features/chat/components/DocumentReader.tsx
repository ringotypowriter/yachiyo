import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PreviewReadingState } from '../lib/previewRetention'
import type { FilePreviewContent } from '@yachiyo/shared/filePreview'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { ReaderTarget } from '../lib/contentReader'
import { detectLanguage } from '../lib/code-blocks/detectLanguage'
import { codeHighlightTokenStyle } from '../lib/code-blocks/codeHighlightTheme'
import { useCodeHighlightTokens } from '../lib/code-blocks/useCodeHighlightTokens'
import type { HighlightToken } from '../lib/code-blocks/highlightTokens'

const PdfDocument = lazy(() =>
  import('./PdfDocument').then((module) => ({ default: module.PdfDocument }))
)

export function DocumentReader({
  target,
  revision,
  reading,
  onReadingChange
}: {
  target: Extract<ReaderTarget, { kind: 'file' }>
  revision: string
  reading?: PreviewReadingState
  onReadingChange?: (reading: PreviewReadingState) => void
}): React.JSX.Element {
  return (
    <LoadedDocumentReader
      key={JSON.stringify([target.path, target.threadId, target.workspacePath, revision])}
      target={target}
      reading={reading}
      onReadingChange={onReadingChange}
    />
  )
}

function LoadedDocumentReader({
  target,
  reading,
  onReadingChange
}: {
  target: Extract<ReaderTarget, { kind: 'file' }>
  reading?: PreviewReadingState
  onReadingChange?: (reading: PreviewReadingState) => void
}): React.JSX.Element {
  const [document, setDocument] = useState<FilePreviewContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const [initialReading] = useState(reading)
  useLayoutEffect(() => {
    if (!document || !surface.current || document.kind === 'pdf') return
    surface.current.scrollTop = initialReading?.scrollTop ?? 0
    surface.current.scrollLeft = initialReading?.scrollLeft ?? 0
  }, [document, initialReading])
  useEffect(() => {
    let cancelled = false
    void window.api.yachiyo
      .readFilePreview({
        path: target.path,
        threadId: target.threadId,
        workspacePath: target.workspacePath
      })
      .then((result) => {
        if (!cancelled) {
          setDocument(result)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to read this file.')
      })
    return () => {
      cancelled = true
    }
  }, [target.path, target.workspacePath, target.threadId])

  return (
    <div
      ref={surface}
      className="content-reader-document"
      onScroll={(event) =>
        onReadingChange?.({
          scrollTop: event.currentTarget.scrollTop,
          scrollLeft: event.currentTarget.scrollLeft
        })
      }
    >
      {error ? (
        <div className="content-reader-notice" role="alert">
          {error} Use Open externally to continue.
        </div>
      ) : null}
      {!document && !error ? (
        <div className="content-reader-notice" role="status">
          Loading document…
        </div>
      ) : null}
      {document?.kind === 'pdf' ? (
        <Suspense
          fallback={
            <div className="content-reader-notice" role="status">
              Loading PDF…
            </div>
          }
        >
          <PdfDocument
            content={document.content}
            title={target.path.split(/[\\/]/).pop() ?? 'PDF document'}
            reading={initialReading}
            onReadingChange={onReadingChange}
          />
        </Suspense>
      ) : null}
      {document?.kind === 'markdown' ? (
        <article className="content-reader-paper content-selectable">
          <MessageMarkdown
            content={document.content}
            imageContext={{
              threadId: target.threadId,
              messageId: '',
              workspacePath: target.path.replace(/[\\/][^\\/]+$/, '')
            }}
            workspaceFileScope={{ threadId: target.threadId, workspacePath: target.workspacePath }}
          />
        </article>
      ) : null}
      {document?.kind === 'text' ? (
        <TextDocument content={document.content} path={target.path} />
      ) : null}
    </div>
  )
}

function TextDocument({ content, path }: { content: string; path: string }): React.JSX.Element {
  const tokens = useCodeHighlightTokens(content, detectLanguage(path))
  return <TextDocumentContent content={content} tokens={tokens} />
}

export function TextDocumentContent({
  content,
  tokens
}: {
  content: string
  tokens: HighlightToken[][] | null
}): React.JSX.Element {
  const lines = content.split('\n')
  return (
    <pre className="content-reader-text content-selectable">
      {tokens
        ? lines.map((line, index) => (
            <Fragment key={index}>
              {tokens[index]?.map((token, tokenIndex) => (
                <span
                  key={tokenIndex}
                  className="yachiyo-code-token"
                  style={codeHighlightTokenStyle(token) as CSSProperties | undefined}
                >
                  {token.content}
                </span>
              )) ?? line}
              {index < lines.length - 1 ? '\n' : null}
            </Fragment>
          ))
        : content}
    </pre>
  )
}
