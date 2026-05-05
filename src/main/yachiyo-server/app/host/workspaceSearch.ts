import { resolve } from 'node:path'

import type {
  FileMentionCandidate,
  SearchWorkspaceFilesInput,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import type { JotdownStore } from '../../services/jotdownStore.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import { searchWorkspaceFileMentionCandidates } from '../../runtime/fileMentions.ts'

export async function searchYachiyoWorkspaceFiles(input: {
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  jotdownStore: JotdownStore | null
  requireThread: (threadId: string) => ThreadRecord
  searchInput: SearchWorkspaceFilesInput
  searchService: SearchService
}): Promise<FileMentionCandidate[]> {
  const query = input.searchInput.query.trim()

  let workspacePath = input.searchInput.workspacePath?.trim() ?? ''
  if (!workspacePath && input.searchInput.threadId) {
    const thread = input.requireThread(input.searchInput.threadId)
    workspacePath = thread.workspacePath?.trim() ?? ''
    if (!workspacePath) {
      workspacePath = await input.ensureThreadWorkspace(thread.id)
    }
  }

  const candidates: FileMentionCandidate[] = []

  if (workspacePath) {
    const directPaths = await searchWorkspaceFileMentionCandidates({
      query,
      includeIgnored: input.searchInput.includeIgnored,
      workspacePath: resolve(workspacePath),
      searchService: input.searchService,
      limit: input.searchInput.limit
    })

    if (directPaths.length > 0 || input.searchInput.includeIgnored) {
      candidates.push(
        ...directPaths.map((path) => ({
          path,
          ...(input.searchInput.includeIgnored ? { includeIgnored: true as const } : {})
        }))
      )
    } else {
      const ignoredPaths = await searchWorkspaceFileMentionCandidates({
        query,
        includeIgnored: true,
        workspacePath: resolve(workspacePath),
        searchService: input.searchService,
        limit: input.searchInput.limit
      })

      candidates.push(
        ...ignoredPaths
          .filter((path) => path !== query)
          .map((path) => ({ path, includeIgnored: true as const }))
      )
    }
  }

  if (
    input.jotdownStore &&
    query.toLowerCase().startsWith('jot') &&
    !candidates.some((c) => c.path.toLowerCase() === 'jotdown')
  ) {
    const latest = await input.jotdownStore.getLatest()
    if (latest) {
      candidates.push({ path: 'JotDown', kind: 'jotdown' })
    }
  }

  return candidates
}
