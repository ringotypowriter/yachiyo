import { resolveYachiyoSocketPath } from '../../../config/paths.ts'
import {
  searchMessages as defaultSearchMessages,
  listRecentThreads as defaultListRecentThreads,
  dumpThread as defaultDumpThread
} from '../../threadSearch.ts'
import { namespaceHelp } from '../core/help.ts'
import { parseLimitFlag } from '../core/parsers.ts'
import { outputJson } from '../core/output.ts'
import {
  formatSearchResultsText,
  formatThreadDumpText,
  formatThreadListText
} from '../formatting/thread.ts'
import { defaultSendMarkThreadReviewed } from '../services/socket.ts'
import type { RunYachiyoCliOptions } from '../core/types.ts'

export function handleThreadCommand(
  positionals: string[],
  flags: Map<string, string>,
  dbPath: string,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): void {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('thread')}\n`)
    return
  }

  const action = positionals[0]
  const useJson = flags.get('--json') === 'true'
  const includePrivate = flags.has('--include-private')

  if (action === 'search') {
    const query = positionals[1]
    if (!query?.trim()) {
      throw new Error('Query is required: thread search <query>')
    }
    const limit = parseLimitFlag(flags, 5)
    const search = options.searchMessages ?? defaultSearchMessages
    const hits = search(dbPath, query, limit, includePrivate)

    if (useJson) {
      outputJson(stdout, hits)
    } else {
      stdout.write(`${formatSearchResultsText(hits)}\n`)
    }
    return
  }

  if (action === 'list') {
    const limit = parseLimitFlag(flags, 10)
    const list = options.listRecentThreads ?? defaultListRecentThreads
    const threads = list(dbPath, limit, includePrivate)

    if (useJson) {
      outputJson(stdout, threads)
    } else {
      stdout.write(`${formatThreadListText(threads)}\n`)
    }
    return
  }

  if (action === 'show') {
    const threadId = positionals[1]
    if (!threadId?.trim()) {
      throw new Error('Thread id is required: thread show <id>')
    }
    const dumpFn = options.dumpThread ?? defaultDumpThread
    const dump = dumpFn(dbPath, threadId, includePrivate)

    if (!dump) {
      throw new Error(`Thread not found: ${threadId}`)
    }

    if (useJson) {
      outputJson(stdout, dump)
    } else {
      stdout.write(`${formatThreadDumpText(dump)}\n`)
    }

    // Best-effort: notify running app to mark thread as reviewed via UDS
    const sendReviewed = options.sendMarkThreadReviewed ?? defaultSendMarkThreadReviewed
    const socketPath = resolveYachiyoSocketPath()
    sendReviewed(socketPath, { type: 'mark-thread-reviewed', threadId }).catch(() => {})

    return
  }

  throw new Error(`Unknown thread action: ${action ?? '(none)'}. Expected: search, list, show`)
}
