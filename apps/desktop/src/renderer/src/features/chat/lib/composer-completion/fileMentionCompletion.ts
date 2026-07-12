import { t } from '@yachiyo/i18n/index'

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

export function buildFileMentionRequestKey(input: {
  threadId: string | null
  workspacePath: string | null
  queryKey: string | null
}): string | null {
  if (input.queryKey === null) return null
  const scopeKey = input.threadId
    ? `thread:${input.threadId}:${input.workspacePath ?? ''}`
    : `workspace:${input.workspacePath ?? ''}`
  return `${scopeKey}\n${input.queryKey}`
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
        ? t('chat.slashCommands.latestJotDown')
        : match.includeIgnored
          ? t('chat.slashCommands.ignoredWorkspacePath')
          : t('chat.slashCommands.workspacePath'),
    type: match.kind === 'jotdown' ? 'jotdown' : 'file'
  }))
}
