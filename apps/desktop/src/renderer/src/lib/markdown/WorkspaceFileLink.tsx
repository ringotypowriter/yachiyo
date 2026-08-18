import { useCallback } from 'react'

import { useAppDialog } from '@renderer/components/AppDialogContext'
import type { InlineCodeFileLinkSnapshot } from './inlineCodeFileLinkSnapshot'
import { resolveWorkspaceFileLink } from './workspaceFileLinkAction'

const LINK_STYLE = {
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 2
} as const

export function WorkspaceFileLink({
  children,
  node,
  fileLinks,
  ...rest
}: React.ComponentProps<'span'> & {
  node?: unknown
  fileLinks?: InlineCodeFileLinkSnapshot
}): React.JSX.Element {
  const dialog = useAppDialog()
  const resolvedLink = resolveWorkspaceFileLink(node, fileLinks)
  const handleOpen = useCallback(
    async (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => {
      event.preventDefault()
      if (!resolvedLink) return

      try {
        if (event.altKey) {
          await window.api.yachiyo.revealFile({ path: resolvedLink.path })
        } else {
          await window.api.yachiyo.openFile({ path: resolvedLink.path })
        }
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : 'Failed to open file.'
        })
      }
    },
    [dialog, resolvedLink]
  )

  if (!resolvedLink) {
    return <span {...rest}>{children}</span>
  }

  return (
    <span
      {...rest}
      role="link"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void handleOpen(event)
      }}
      style={{ ...rest.style, ...LINK_STYLE }}
    >
      {children}
    </span>
  )
}
