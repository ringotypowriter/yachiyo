type ReaderScope = { threadId: string; workspacePath?: string | null }
export type ReaderTarget = ReaderScope &
  (
    | { kind: 'image'; src: string; alt?: string; path?: string }
    | { kind: 'file'; path: string }
    | { kind: 'diff'; runId: string; workspacePath: string; relativePath?: string }
  )

export function readerReference(
  target: ReaderTarget | null,
  threadId: string | null
): string | null {
  if (!target || target.threadId !== threadId) return null
  if (target.kind === 'diff') {
    return `[Reviewing file changes: run ${JSON.stringify(target.runId)}, workspace ${JSON.stringify(target.workspacePath)}${target.relativePath ? `, file ${JSON.stringify(target.relativePath)}` : ''}]`
  }
  const path =
    target.path ?? (target.kind === 'image' && /^https?:\/\//.test(target.src) ? target.src : null)
  return path ? `[Viewing file: ${JSON.stringify(path)}]` : null
}

export function appendReaderReference(content: string, reference: string | null): string {
  return reference && !content.includes(reference) ? `${content}\n\n${reference}` : content
}
