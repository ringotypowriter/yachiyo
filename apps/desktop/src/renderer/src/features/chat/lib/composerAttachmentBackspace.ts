const IME_PROCESSING_KEY_CODE = 229

type ComposerBackspaceEvent = {
  key: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  isComposing: boolean
  keyCode?: number
}

type ComposerAttachmentReference = {
  id: string
}

export type ComposerBackspaceAttachmentRemoval =
  | {
      kind: 'image'
      id: string
    }
  | {
      kind: 'file'
      id: string
    }

export function selectComposerBackspaceAttachmentRemoval(input: {
  event: ComposerBackspaceEvent
  text: string
  selectionStart: number
  selectionEnd: number
  images: readonly ComposerAttachmentReference[]
  files: readonly ComposerAttachmentReference[]
}): ComposerBackspaceAttachmentRemoval | null {
  const { event } = input

  if (
    event.key !== 'Backspace' ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.isComposing ||
    event.keyCode === IME_PROCESSING_KEY_CODE
  ) {
    return null
  }

  if (input.text.length !== 0 || input.selectionStart !== 0 || input.selectionEnd !== 0) {
    return null
  }

  const lastFile = input.files[input.files.length - 1]
  if (lastFile) {
    return { kind: 'file', id: lastFile.id }
  }

  const lastImage = input.images[input.images.length - 1]
  if (lastImage) {
    return { kind: 'image', id: lastImage.id }
  }

  return null
}
