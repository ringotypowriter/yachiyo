import type {
  FolderColorTag,
  FolderCreatedEvent,
  FolderDeletedEvent,
  FolderRecord,
  FolderUpdatedEvent,
  ThreadRecord,
  ThreadUpdatedEvent
} from '../../../../shared/yachiyo/protocol.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import type { CreateId, EmitServerEvent, Timestamp } from './shared.ts'

interface FolderDomainDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
}

export class FolderDomain {
  private readonly deps: FolderDomainDeps

  constructor(deps: FolderDomainDeps) {
    this.deps = deps
  }

  createFolderForThreads(input: { threads: ThreadRecord[]; title?: string }): FolderRecord {
    // Re-read all threads from storage for fresh state
    const allThreads = input.threads
      .map((t) => this.deps.storage.getThread(t.id))
      .filter((t): t is ThreadRecord => t != null)

    if (allThreads.length === 0) {
      throw new Error('No valid threads to create a folder for.')
    }

    // If all threads are already in the SAME folder, return it
    const folderIds = new Set(allThreads.map((t) => t.folderId).filter(Boolean))
    if (folderIds.size === 1 && allThreads.every((t) => t.folderId)) {
      const existing = this.deps.storage.getFolder([...folderIds][0]!)
      if (existing) return existing
    }

    // Track old folders so we can auto-delete them if they become empty
    const previousFolderIds = new Set(
      allThreads.map((t) => t.folderId).filter((id): id is string => id != null)
    )

    const timestamp = this.deps.timestamp()
    const title = input.title ?? allThreads[0]?.title ?? 'New Folder'

    const folder: FolderRecord = {
      id: this.deps.createId(),
      title,
      colorTag: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }

    this.deps.storage.createFolder(folder)

    for (const thread of allThreads) {
      this.deps.storage.setThreadFolder({
        threadId: thread.id,
        folderId: folder.id,
        updatedAt: timestamp
      })

      const updatedThread = this.deps.storage.getThread(thread.id)
      if (updatedThread) {
        this.deps.emit<ThreadUpdatedEvent>({
          type: 'thread.updated',
          threadId: thread.id,
          thread: updatedThread
        })
      }
    }

    // Auto-delete old folders that became empty
    for (const oldFolderId of previousFolderIds) {
      this.autoDeleteIfEmpty(oldFolderId)
    }

    this.deps.emit<FolderCreatedEvent>({
      type: 'folder.created',
      folderId: folder.id,
      folder
    })

    return folder
  }

  renameFolder(input: { folderId: string; title: string }): FolderRecord {
    const folder = this.deps.storage.getFolder(input.folderId)
    if (!folder) {
      throw new Error(`Folder not found: ${input.folderId}`)
    }

    const timestamp = this.deps.timestamp()
    this.deps.storage.renameFolder({
      folderId: input.folderId,
      title: input.title,
      updatedAt: timestamp
    })

    const updated: FolderRecord = {
      ...folder,
      title: input.title,
      updatedAt: timestamp
    }

    this.deps.emit<FolderUpdatedEvent>({
      type: 'folder.updated',
      folderId: updated.id,
      folder: updated
    })

    return updated
  }

  setFolderColor(input: { folderId: string; colorTag: FolderColorTag | null }): FolderRecord {
    const folder = this.deps.storage.getFolder(input.folderId)
    if (!folder) {
      throw new Error(`Folder not found: ${input.folderId}`)
    }

    const timestamp = this.deps.timestamp()
    this.deps.storage.setFolderColor({
      folderId: input.folderId,
      colorTag: input.colorTag,
      updatedAt: timestamp
    })

    const updated: FolderRecord = {
      ...folder,
      colorTag: input.colorTag,
      updatedAt: timestamp
    }

    this.deps.emit<FolderUpdatedEvent>({
      type: 'folder.updated',
      folderId: updated.id,
      folder: updated
    })

    return updated
  }

  deleteFolder(folderId: string): void {
    const folder = this.deps.storage.getFolder(folderId)
    if (!folder) return

    const memberThreads = this.deps.storage.listThreadsInFolder(folderId)

    this.deps.storage.deleteFolder(folderId)

    // Notify renderer that these threads lost their folderId
    for (const thread of memberThreads) {
      const updated = this.deps.storage.getThread(thread.id)
      if (updated) {
        this.deps.emit<ThreadUpdatedEvent>({
          type: 'thread.updated',
          threadId: thread.id,
          thread: updated
        })
      }
    }

    this.deps.emit<FolderDeletedEvent>({
      type: 'folder.deleted',
      folderId
    })
  }

  moveThreadToFolder(input: { threadId: string; folderId: string | null }): ThreadRecord {
    const thread = this.deps.storage.getThread(input.threadId)
    if (!thread) {
      throw new Error(`Thread not found: ${input.threadId}`)
    }

    // Validate target folder exists
    if (input.folderId) {
      const folder = this.deps.storage.getFolder(input.folderId)
      if (!folder) {
        throw new Error(`Folder not found: ${input.folderId}`)
      }
    }

    const previousFolderId = thread.folderId
    if (previousFolderId === (input.folderId ?? undefined)) {
      return thread // No change needed
    }

    const timestamp = this.deps.timestamp()

    this.deps.storage.setThreadFolder({
      threadId: input.threadId,
      folderId: input.folderId,
      updatedAt: timestamp
    })

    const updatedThread = this.deps.storage.getThread(input.threadId)!

    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: input.threadId,
      thread: updatedThread
    })

    // Auto-delete the old folder if it's now empty
    if (previousFolderId && previousFolderId !== input.folderId) {
      this.autoDeleteIfEmpty(previousFolderId)
    }

    return updatedThread
  }

  autoDeleteIfEmpty(folderId: string): void {
    const folder = this.deps.storage.getFolder(folderId)
    if (!folder) return

    if (this.deps.storage.listThreadsInFolder(folderId, { includeArchived: true }).length === 0) {
      this.deleteFolder(folderId)
    }
  }

  /** Assign a thread to the same folder as a source thread, or create one. */
  ensureFolderForDerivedThread(input: {
    sourceThread: ThreadRecord
    derivedThread: ThreadRecord
  }): void {
    if (input.sourceThread.folderId) {
      // Source already in a folder — add the derived thread to the same folder
      this.moveThreadToFolder({
        threadId: input.derivedThread.id,
        folderId: input.sourceThread.folderId
      })
    } else {
      // Source not in a folder — create one for both
      this.createFolderForThreads({
        threads: [input.sourceThread, input.derivedThread],
        title: input.sourceThread.title
      })
    }
  }
}
