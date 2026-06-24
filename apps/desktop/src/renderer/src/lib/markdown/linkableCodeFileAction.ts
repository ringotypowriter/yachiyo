import { stripInlineCodeFileLocationSuffix } from '@yachiyo/shared/inlineCodeFileReferences'

export type LinkableCodeFileAction = 'open' | 'reveal'

export function getTimelineFileEditorApp(input: { editorApp?: string }): string | undefined {
  return input.editorApp
}

export function getLinkableCodeFileAction(input: {
  reference: string
  altKey: boolean
}): LinkableCodeFileAction {
  if (input.altKey && !isFolderReference(input.reference)) {
    return 'reveal'
  }

  return 'open'
}

function isFolderReference(reference: string): boolean {
  const pathPart = stripInlineCodeFileLocationSuffix(reference.trim())
  return pathPart.endsWith('/') || pathPart.endsWith('\\')
}
