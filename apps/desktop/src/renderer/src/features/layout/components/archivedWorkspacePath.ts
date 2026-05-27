interface WorkspaceRun {
  workspacePath?: string | null
}

export function resolveArchivedWorkspacePath(
  threadWorkspacePath: string | null | undefined,
  runs: readonly WorkspaceRun[]
): string | undefined {
  const threadPath = threadWorkspacePath?.trim()
  if (threadPath) return threadPath

  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const runPath = runs[i]?.workspacePath?.trim()
    if (runPath) return runPath
  }

  return undefined
}
