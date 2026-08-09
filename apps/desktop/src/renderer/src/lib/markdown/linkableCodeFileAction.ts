import { stripInlineCodeFileLocationSuffix } from '@yachiyo/shared/inlineCodeFileReferences'

export type LinkableCodeFileAction = 'open' | 'reveal'

export type TimelineFileOpenTarget =
  | {
      mode: 'configured'
      appSelection: string
      appKind: 'editor' | 'markdown'
    }
  | { mode: 'default' }
  | { mode: 'unavailable' }

export function resolveTimelineFileOpenTarget(input: {
  filePath: string
  editorApp?: string
  markdownApp?: string
}): TimelineFileOpenTarget {
  if (/\.(?:md|markdown)$/iu.test(input.filePath)) {
    return input.markdownApp
      ? {
          mode: 'configured',
          appSelection: input.markdownApp,
          appKind: 'markdown'
        }
      : { mode: 'default' }
  }

  return input.editorApp
    ? {
        mode: 'configured',
        appSelection: input.editorApp,
        appKind: 'editor'
      }
    : { mode: 'unavailable' }
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
