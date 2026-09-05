import { useMemo, type ReactNode } from 'react'
import { ReaderContext, type ReaderActions } from '../hooks/useContentReader'
import { getFilePreviewKind } from '@yachiyo/shared/filePreview'
import { extractLocalPath } from '@renderer/lib/markdown/imageUrl'
import { useContentReaderStore } from '../state/useContentReaderStore'

export function ContentReaderProvider({
  threadId,
  workspacePath,
  children
}: {
  threadId: string | null
  workspacePath?: string | null
  children: ReactNode
}): React.JSX.Element {
  const value = useMemo<ReaderActions | null>(() => {
    if (!threadId) return null
    const open = useContentReaderStore.getState().open
    return {
      openFile: (path) => {
        const kind = getFilePreviewKind(path)
        if (!kind) return false
        if (kind === 'image') {
          open({
            kind: 'image',
            threadId,
            workspacePath,
            path,
            src: `yachiyo-asset://local/?p=${encodeURIComponent(path)}`
          })
        } else {
          open({ kind: 'file', threadId, workspacePath, path })
        }
        return true
      },
      openImage: (src, alt, path) =>
        open({
          kind: 'image',
          threadId,
          workspacePath,
          src,
          alt,
          path: path ?? extractLocalPath(src) ?? undefined
        }),
      openDiff: (input) => open({ kind: 'diff', ...input })
    }
  }, [threadId, workspacePath])
  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>
}
