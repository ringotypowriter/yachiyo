import { useEffect, useRef, useState } from 'react'
import type { FilePreviewContent } from '@yachiyo/shared/filePreview'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { ReaderTarget } from '../lib/contentReader'

function PdfDocument({ content, title }: { content: string; title: string }): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    if (frame.current) frame.current.src = `${url}#navpanes=0&view=FitH`
    return () => URL.revokeObjectURL(url)
  }, [content])
  return <iframe ref={frame} className="content-reader-pdf" title={title} />
}

export function DocumentReader({
  target,
  revision
}: {
  target: Extract<ReaderTarget, { kind: 'file' }>
  revision: string
}): React.JSX.Element {
  const [document, setDocument] = useState<FilePreviewContent | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  }, [target.path, target.workspacePath, target.threadId, revision])

  return (
    <div className="content-reader-document">
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
        <PdfDocument
          content={document.content}
          title={target.path.split(/[\\/]/).pop() ?? 'PDF document'}
        />
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
        <pre className="content-reader-text content-selectable">{document.content}</pre>
      ) : null}
    </div>
  )
}
