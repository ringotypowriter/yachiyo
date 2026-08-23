export interface DiffFileOpenRequest {
  path: string
  appSelection: string
  appKind: 'editor'
}

export function buildDiffFileOpenRequest(input: {
  workspacePath: string
  relativePath: string
  editorApp?: string
}): DiffFileOpenRequest | null {
  if (!input.editorApp) return null

  const path = input.workspacePath.endsWith('/')
    ? `${input.workspacePath}${input.relativePath}`
    : `${input.workspacePath}/${input.relativePath}`

  return {
    path,
    appSelection: input.editorApp,
    appKind: 'editor'
  }
}
