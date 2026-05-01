import { useContext, useState, useCallback } from 'react'
import { StreamdownContext } from 'streamdown'
import { LinkSafetyModal } from './LinkSafetyModal'
import type { InlineCodeFileLinkSnapshot } from './inlineCodeFileLinkSnapshot'
import { toInlineCodeFileReferenceCandidate } from '../../../../shared/yachiyo/inlineCodeFileReferences.ts'

const URL_RE = /^https?:\/\/\S+$/
const LINK_STYLE = { cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }

/**
 * Inline code component that makes URL-only code spans clickable.
 * Falls back to a normal `<code>` for everything else.
 */
export function LinkableCode({
  children,
  node,
  fileLinks,
  ...rest
}: React.ComponentProps<'code'> & {
  node?: unknown
  fileLinks?: InlineCodeFileLinkSnapshot
}): React.JSX.Element {
  // `node` is the hast AST node injected by Streamdown — strip it so it doesn't hit the DOM.
  void node
  const { linkSafety } = useContext(StreamdownContext)
  const [modalOpen, setModalOpen] = useState(false)

  const text = typeof children === 'string' ? children : ''
  const isUrl = URL_RE.test(text)
  const fileReference = toInlineCodeFileReferenceCandidate(text)
  const filePath = fileReference ? fileLinks?.get(fileReference) : undefined

  if (fileReference) {
    console.log('[inline-code-file-links] code span candidate', {
      text,
      fileReference,
      linked: Boolean(filePath),
      filePath
    })
  }

  const handleUrlClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (linkSafety?.enabled) {
        setModalOpen(true)
      } else {
        window.open(text, '_blank', 'noreferrer')
      }
    },
    [linkSafety, text]
  )

  const handleFileClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault()
      if (!filePath) return

      try {
        await window.api.yachiyo.openFile({ path: filePath })
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Failed to open file.')
      }
    },
    [filePath]
  )

  const handleConfirm = useCallback(() => {
    window.open(text, '_blank', 'noreferrer')
  }, [text])

  if (filePath) {
    return (
      <code
        {...rest}
        role="link"
        tabIndex={0}
        onClick={handleFileClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleFileClick(e as unknown as React.MouseEvent)
        }}
        style={LINK_STYLE}
      >
        {children}
      </code>
    )
  }

  if (!isUrl) return <code {...rest}>{children}</code>

  return (
    <>
      <code
        {...rest}
        role="link"
        tabIndex={0}
        onClick={handleUrlClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleUrlClick(e as unknown as React.MouseEvent)
        }}
        style={LINK_STYLE}
      >
        {children}
      </code>
      <LinkSafetyModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onConfirm={handleConfirm}
        url={text}
      />
    </>
  )
}
