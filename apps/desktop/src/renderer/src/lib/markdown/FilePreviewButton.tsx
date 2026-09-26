import { Eye } from 'lucide-react'
import { Tooltip } from '@renderer/components/Tooltip'
import { useContentReader } from '@renderer/features/chat/hooks/useContentReader'
import { getFilePreviewKind } from '@yachiyo/shared/filePreview'

export function FilePreviewButton({ path }: { path: string }): React.JSX.Element | null {
  const reader = useContentReader()
  if (!reader || !getFilePreviewKind(path)) return null
  return (
    <Tooltip content="Preview in Yachiyo">
      <button
        type="button"
        className="inline-file-preview"
        aria-label="Preview in Yachiyo"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          reader.openFile(path)
        }}
      >
        <Eye size={12} />
      </button>
    </Tooltip>
  )
}
