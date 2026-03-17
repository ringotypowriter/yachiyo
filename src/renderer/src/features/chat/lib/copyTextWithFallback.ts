interface CopyTextDependencies {
  document?: Document
  navigator?: Navigator
}

function copyWithLegacyCommand(content: string, document: Document | undefined): void {
  if (!document?.body || typeof document.createElement !== 'function') {
    throw new Error('Copy is unavailable.')
  }

  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.append(textarea)

  try {
    textarea.select()
    const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false

    if (!copied) {
      throw new Error('Copy command was rejected.')
    }
  } finally {
    document.body.removeChild(textarea)
  }
}

export async function copyTextWithFallback(
  content: string,
  dependencies: CopyTextDependencies = {}
): Promise<void> {
  const navigator = dependencies.navigator ?? globalThis.navigator
  const document = dependencies.document ?? globalThis.document

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content)
      return
    } catch {
      copyWithLegacyCommand(content, document)
      return
    }
  }

  copyWithLegacyCommand(content, document)
}
