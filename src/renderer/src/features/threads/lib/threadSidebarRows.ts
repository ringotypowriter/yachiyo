import type { FolderRecord, Thread, ToolCall } from '../../../app/types.ts'
import { stripMarkdown } from '../../../../../shared/yachiyo/messageContent.ts'

export type FolderChild =
  | { kind: 'thread'; thread: Thread }
  | { kind: 'folder-date-header'; label: string }

export type SidebarItem =
  | { kind: 'starred-header' }
  | { kind: 'thread'; thread: Thread }
  | { kind: 'folder'; folder: FolderRecord; threads: Thread[]; children: FolderChild[] }
  | { kind: 'date-header'; label: string }

export type SidebarRow =
  | { kind: 'starred-header'; key: string }
  | { kind: 'thread'; key: string; thread: Thread }
  | { kind: 'folder'; key: string; folder: FolderRecord; threads: Thread[] }
  | { kind: 'folder-date-header'; key: string; folder: FolderRecord; label: string }
  | { kind: 'folder-thread'; key: string; folder: FolderRecord; thread: Thread }
  | { kind: 'date-header'; key: string; label: string }

export type SidebarFolderDropRow = Extract<
  SidebarRow,
  { kind: 'folder' | 'folder-date-header' | 'folder-thread' }
>

export type ThreadSidebarPreviewState = 'normal' | 'thinking' | 'working'

export interface ThreadSidebarPreview {
  state: ThreadSidebarPreviewState
  text: string
}

const THINKING_SIDEBAR_PREVIEWS: readonly [string, ...string[]] = [
  'Thinking...',
  'Brewing...',
  'Cerebrating...',
  'Cogitating...',
  'Considering...',
  'Contemplating...',
  'Deciphering...',
  'Deliberating...',
  'Elucidating...',
  'Envisioning...',
  'Ideating...',
  'Imagining...',
  'Incubating...',
  'Inferring...',
  'Mulling...',
  'Musing...',
  'Noodling...',
  'Perusing...',
  'Philosophising...',
  'Pondering...',
  'Puzzling...',
  'Ruminating...'
]

const WORKING_SIDEBAR_PREVIEWS: readonly [string, ...string[]] = [
  'Accomplishing...',
  'Actualizing...',
  'Baking...',
  'Beaming...',
  'Billowing...',
  'Boogieing...',
  'Booping...',
  'Caramelizing...',
  'Cascading...',
  'Channeling...',
  'Choreographing...',
  'Churning...',
  'Coalescing...',
  'Combobulating...',
  'Composing...',
  'Concocting...',
  'Cooking...',
  'Crafting...',
  'Creating...',
  'Crystallizing...',
  'Cultivating...',
  'Doodling...',
  'Drizzling...',
  'Ebbing...',
  'Embellishing...',
  'Enchanting...',
  'Fermenting...',
  'Flowing...',
  'Fluttering...',
  'Forming...',
  'Frosting...',
  'Garnishing...',
  'Germinating...',
  'Grooving...',
  'Gusting...',
  'Harmonizing...',
  'Hatching...',
  'Improvising...',
  'Infusing...',
  'Kneading...',
  'Leavening...',
  'Levitating...',
  'Manifesting...',
  'Marinating...',
  'Metamorphosing...',
  'Misting...',
  'Orbiting...',
  'Orchestrating...',
  'Percolating...',
  'Polishing...',
  'Prestidigitating...',
  'Proofing...',
  'Propagating...',
  'Recombobulating...',
  'Seasoning...',
  'Shaping...',
  'Shimmying...',
  'Simmering...',
  'Sketching...',
  'Smooshing...',
  'Spinning...',
  'Sprouting...',
  'Stewing...',
  'Swirling...',
  'Tempering...',
  'Tinkering...',
  'Transfiguring...',
  'Transmuting...',
  'Twisting...',
  'Undulating...',
  'Unfurling...',
  'Unravelling...',
  'Vibing...',
  'Wandering...',
  'Warping...',
  'Whirlpooling...',
  'Whirring...',
  'Whisking...',
  'Working...',
  'Wrangling...',
  'Zesting...',
  'Zigzagging...'
]

export function buildSidebarItems(
  threads: Thread[],
  folders: FolderRecord[],
  now = new Date()
): SidebarItem[] {
  const folderMap = new Map<string, FolderRecord>()
  for (const f of folders) folderMap.set(f.id, f)

  const starredNoFolder: Thread[] = []
  const folderThreads = new Map<string, Thread[]>()
  const looseThreads: Thread[] = []

  for (const t of threads) {
    if (t.folderId && folderMap.has(t.folderId)) {
      const list = folderThreads.get(t.folderId) ?? []
      list.push(t)
      folderThreads.set(t.folderId, list)
    } else if (t.starredAt) {
      starredNoFolder.push(t)
    } else {
      looseThreads.push(t)
    }
  }

  for (const [fid, fThreads] of folderThreads) {
    fThreads.sort((a, b) => {
      if (a.starredAt && !b.starredAt) return -1
      if (!a.starredAt && b.starredAt) return 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    folderThreads.set(fid, fThreads)
  }

  const folderItems: Array<{
    folder: FolderRecord
    threads: Thread[]
    effectiveUpdatedAt: string
  }> = []
  for (const [fid, fThreads] of folderThreads) {
    const folder = folderMap.get(fid)!
    const maxUpdated = fThreads.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), '')
    folderItems.push({ folder, threads: fThreads, effectiveUpdatedAt: maxUpdated })
  }
  folderItems.sort((a, b) => b.effectiveUpdatedAt.localeCompare(a.effectiveUpdatedAt))

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const result: SidebarItem[] = []

  if (starredNoFolder.length > 0) {
    result.push({ kind: 'starred-header' })
    for (const t of starredNoFolder) {
      result.push({ kind: 'thread', thread: t })
    }
  }

  for (const fi of folderItems) {
    const children: FolderChild[] = []
    let folderLastLabel = ''
    for (const t of fi.threads) {
      const label = formatSidebarDateLabel(t.updatedAt, today)
      if (label !== folderLastLabel) {
        children.push({ kind: 'folder-date-header', label })
        folderLastLabel = label
      }
      children.push({ kind: 'thread', thread: t })
    }
    result.push({ kind: 'folder', folder: fi.folder, threads: fi.threads, children })
  }

  let lastLabel = ''
  for (const t of looseThreads) {
    const label = formatSidebarDateLabel(t.updatedAt, today)

    if (label !== lastLabel) {
      result.push({ kind: 'date-header', label })
      lastLabel = label
    }
    result.push({ kind: 'thread', thread: t })
  }

  return result
}

export function buildSidebarRows(
  items: SidebarItem[],
  collapsedFolderIds: Set<string>
): SidebarRow[] {
  const rows: SidebarRow[] = []

  for (const item of items) {
    if (item.kind === 'starred-header') {
      rows.push({ kind: 'starred-header', key: 'starred' })
      continue
    }

    if (item.kind === 'date-header') {
      rows.push({ kind: 'date-header', key: `date:${item.label}`, label: item.label })
      continue
    }

    if (item.kind === 'thread') {
      rows.push({ kind: 'thread', key: `thread:${item.thread.id}`, thread: item.thread })
      continue
    }

    rows.push({
      kind: 'folder',
      key: `folder:${item.folder.id}`,
      folder: item.folder,
      threads: item.threads
    })

    if (collapsedFolderIds.has(item.folder.id)) continue

    for (const child of item.children) {
      if (child.kind === 'folder-date-header') {
        rows.push({
          kind: 'folder-date-header',
          key: `folder-date:${item.folder.id}:${child.label}`,
          folder: item.folder,
          label: child.label
        })
        continue
      }

      rows.push({
        kind: 'folder-thread',
        key: `folder-thread:${item.folder.id}:${child.thread.id}`,
        folder: item.folder,
        thread: child.thread
      })
    }
  }

  return rows
}

export function estimateSidebarRowSize(row: SidebarRow, showPreview: boolean): number {
  switch (row.kind) {
    case 'starred-header':
    case 'date-header':
      return 30
    case 'folder-date-header':
      return 22
    case 'folder':
      return 38
    case 'thread':
    case 'folder-thread':
      return showPreview ? 62 : 38
  }
}

export function resolveSidebarFolderDropId(row: SidebarFolderDropRow): string {
  if (row.kind === 'folder') return `folder-${row.folder.id}`
  return `folder-${row.folder.id}-row-${row.key}`
}

export function resolveThreadSidebarPreview({
  activeRunId,
  hasBackgroundWork,
  isRunActive,
  thread,
  toolCalls
}: {
  activeRunId: string | null
  hasBackgroundWork: boolean
  isRunActive: boolean
  thread: Pick<Thread, 'id' | 'preview'>
  toolCalls: ToolCall[]
}): ThreadSidebarPreview {
  if (hasBackgroundWork) {
    return {
      state: 'working',
      text: pickSidebarPlaceholder(`background:${thread.id}`, WORKING_SIDEBAR_PREVIEWS)
    }
  }

  if (isRunActive) {
    const hasCurrentRunToolCall =
      activeRunId !== null && toolCalls.some((toolCall) => toolCall.runId === activeRunId)
    const state = hasCurrentRunToolCall ? 'working' : 'thinking'
    const placeholderSeed = activeRunId
      ? `run:${activeRunId}:${state}`
      : `thread:${thread.id}:${state}`

    return {
      state,
      text: pickSidebarPlaceholder(
        placeholderSeed,
        hasCurrentRunToolCall ? WORKING_SIDEBAR_PREVIEWS : THINKING_SIDEBAR_PREVIEWS
      )
    }
  }

  const preview = thread.preview?.trim()
  return {
    state: 'normal',
    text: preview ? stripMarkdown(preview) : 'No messages yet'
  }
}

function formatSidebarDateLabel(updatedAt: string, today: Date): string {
  const date = new Date(updatedAt)
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.floor((today.getTime() - day.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function pickSidebarPlaceholder(threadId: string, labels: readonly [string, ...string[]]): string {
  let hash = 0
  for (let index = 0; index < threadId.length; index += 1) {
    hash = (hash * 31 + threadId.charCodeAt(index)) >>> 0
  }
  return labels[hash % labels.length]
}
