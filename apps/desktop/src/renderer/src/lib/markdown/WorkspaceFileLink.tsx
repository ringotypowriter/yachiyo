import { useCallback } from 'react'
import { useContentReader } from '@renderer/features/chat/hooks/useContentReader'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { resolveTimelineFileOpenTarget } from './linkableCodeFileAction'
import { FilePreviewButton } from './FilePreviewButton'

import { useAppDialog } from '@renderer/components/AppDialogContext'
import type { InlineCodeFileLinkSnapshot } from './inlineCodeFileLinkSnapshot'
import {
  createWorkspaceFileOperationInput,
  resolveWorkspaceFileLink,
  type WorkspaceFileOperationScope
} from './workspaceFileLinkAction'

const LINK_STYLE = {
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 2
} as const

export function WorkspaceFileLink({
  children,
  node,
  fileLinks,
  workspaceScope,
  ...rest
}: React.ComponentProps<'span'> & {
  node?: unknown
  fileLinks?: InlineCodeFileLinkSnapshot
  workspaceScope: WorkspaceFileOperationScope
}): React.JSX.Element {
  const dialog = useAppDialog()
  const reader = useContentReader()
  const editorApp = useAppStore((state) => state.config?.workspace?.editorApp)
  const markdownApp = useAppStore((state) => state.config?.workspace?.markdownApp)
  const resolvedLink = resolveWorkspaceFileLink(node, fileLinks)
  const handleOpen = useCallback(
    async (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => {
      event.preventDefault()
      if (!resolvedLink) return

      try {
        const input = createWorkspaceFileOperationInput(resolvedLink, workspaceScope)
        if (event.altKey) {
          await window.api.yachiyo.revealFile(input)
        } else {
          const target = resolveTimelineFileOpenTarget({
            filePath: input.path,
            editorApp,
            markdownApp
          })
          if (target.mode !== 'configured' && reader?.openFile(input.path)) return
          await window.api.yachiyo.openFile({
            ...input,
            ...(target.mode === 'configured'
              ? { appSelection: target.appSelection, appKind: target.appKind }
              : {})
          })
        }
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : 'Failed to open file.'
        })
      }
    },
    [dialog, resolvedLink, workspaceScope, reader, editorApp, markdownApp]
  )

  if (!resolvedLink) {
    return <span {...rest}>{children}</span>
  }

  return (
    <>
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
      <FilePreviewButton path={resolvedLink.path} />
    </>
  )
}
