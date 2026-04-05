import { useContext, useState, useCallback } from 'react'
import { StreamdownContext } from 'streamdown'
import { LinkSafetyModal } from './LinkSafetyModal'

const URL_RE = /^https?:\/\/\S+$/

/**
 * Inline code component that makes URL-only code spans clickable.
 * Falls back to a normal `<code>` for everything else.
 */
export function LinkableCode({
  children,
  node,
  ...rest
}: React.ComponentProps<'code'> & { node?: unknown }): React.JSX.Element {
  // `node` is the hast AST node injected by Streamdown — strip it so it doesn't hit the DOM.
  void node
  const { linkSafety } = useContext(StreamdownContext)
  const [modalOpen, setModalOpen] = useState(false)

  const text = typeof children === 'string' ? children : ''
  const isUrl = URL_RE.test(text)

  const handleClick = useCallback(
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

  const handleConfirm = useCallback(() => {
    window.open(text, '_blank', 'noreferrer')
  }, [text])

  if (!isUrl) return <code {...rest}>{children}</code>

  return (
    <>
      <code
        {...rest}
        role="link"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleClick(e as unknown as React.MouseEvent)
        }}
        style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
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
