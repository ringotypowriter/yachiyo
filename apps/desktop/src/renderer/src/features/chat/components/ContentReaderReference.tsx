import { X } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { useContentReaderStore } from '../state/useContentReaderStore'
import { readerReference } from '../lib/contentReader'

export function ContentReaderReference({
  threadId
}: {
  threadId: string | null
}): React.JSX.Element | null {
  const target = useContentReaderStore((state) => (state.referenceEnabled ? state.target : null))
  const clear = useContentReaderStore((state) => state.clearReference)
  const editing = useAppStore((state) => state.editingMessage)
  if (editing || !readerReference(target, threadId) || !target) return null
  const label =
    target.kind === 'diff'
      ? `Reviewing: ${target.relativePath ?? 'File Changes'}`
      : `Viewing: ${target.path?.split(/[\\/]/).pop() ?? 'Image'}`
  return (
    <div className="content-reader-reference">
      <span title={readerReference(target, threadId) ?? undefined}>{label}</span>
      <button type="button" aria-label="Remove file reference" onClick={clear}>
        <X size={12} />
      </button>
    </div>
  )
}
