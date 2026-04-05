import { useState, useCallback } from 'react'
import { LinkSafetyModal } from './LinkSafetyModal'

export function LinkSpan({ url }: { url: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setOpen(true)
  }, [])

  const handleConfirm = useCallback(() => {
    window.open(url, '_blank', 'noreferrer')
  }, [url])

  return (
    <>
      <a
        href={url}
        style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 }}
        onClick={handleClick}
      >
        {url}
      </a>
      <LinkSafetyModal
        isOpen={open}
        onClose={() => setOpen(false)}
        onConfirm={handleConfirm}
        url={url}
      />
    </>
  )
}
