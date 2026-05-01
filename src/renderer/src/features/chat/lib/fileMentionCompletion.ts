export interface FileMentionCompletionCandidate {
  path: string
  includeIgnored?: boolean
  kind?: 'jotdown'
}

export interface FileMentionCompletionCommand {
  key: string
  label: string
  description: string
  type: 'file' | 'jotdown'
}

export function paginateFileMentionMatches(input: {
  matches: FileMentionCompletionCandidate[]
  visibleLimit: number
}): { matches: FileMentionCompletionCandidate[]; hasMore: boolean } {
  const specialMatches = input.matches.filter((match) => match.kind === 'jotdown')
  const fileMatches = input.matches.filter((match) => match.kind !== 'jotdown')
  const fileLimit = Math.max(0, input.visibleLimit - specialMatches.length)

  return {
    matches: [...specialMatches, ...fileMatches.slice(0, fileLimit)],
    hasMore: fileMatches.length > fileLimit
  }
}

export function buildFileMentionCompletionCommands(input: {
  matches: FileMentionCompletionCandidate[]
}): FileMentionCompletionCommand[] {
  return input.matches.map((match) => ({
    key: `file:${match.includeIgnored ? '!' : ''}${match.path}`,
    label: `${match.includeIgnored ? '!' : ''}${match.path}`,
    description:
      match.kind === 'jotdown'
        ? 'Latest jot down'
        : match.includeIgnored
          ? 'Ignored workspace path'
          : 'Workspace path',
    type: match.kind === 'jotdown' ? 'jotdown' : 'file'
  }))
}
