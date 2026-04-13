import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ThreadRecord, YachiyoServerEvent } from '../../../../shared/yachiyo/protocol.ts'
import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { FolderDomain } from './folderDomain.ts'

function createTestDeps(): {
  deps: ConstructorParameters<typeof FolderDomain>[0]
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
  events: YachiyoServerEvent[]
} {
  let idCounter = 0
  const events: YachiyoServerEvent[] = []
  const storage = createInMemoryYachiyoStorage()

  const deps = {
    storage,
    createId: () => `id-${++idCounter}`,
    timestamp: () => new Date(2026, 0, 1, 12, 0, idCounter).toISOString(),
    emit: <T extends YachiyoServerEvent>(event: Omit<T, 'eventId' | 'timestamp'>) => {
      events.push({
        ...event,
        eventId: `evt-${++idCounter}`,
        timestamp: new Date().toISOString()
      } as T)
    }
  }

  return { deps, storage, events }
}

function createThread(
  storage: ReturnType<typeof createInMemoryYachiyoStorage>,
  overrides: Partial<ThreadRecord> & { id: string }
): ThreadRecord {
  const thread: ThreadRecord = {
    title: 'Test Thread',
    updatedAt: new Date().toISOString(),
    ...overrides
  }
  storage.createThread({ thread, createdAt: new Date().toISOString() })
  return storage.getThread(thread.id)!
}

describe('FolderDomain', () => {
  test('createFolderForThreads creates a folder and assigns threads', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1', title: 'Thread One' })
    const t2 = createThread(storage, { id: 't2', title: 'Thread Two' })

    const folder = domain.createFolderForThreads({ threads: [t1, t2] })

    assert.ok(folder.id)
    assert.equal(folder.title, 'Thread One')

    const updatedT1 = storage.getThread('t1')!
    const updatedT2 = storage.getThread('t2')!
    assert.equal(updatedT1.folderId, folder.id)
    assert.equal(updatedT2.folderId, folder.id)
  })

  test('createFolderForThreads uses custom title when provided', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1' })
    const folder = domain.createFolderForThreads({ threads: [t1], title: 'Custom Title' })

    assert.equal(folder.title, 'Custom Title')
  })

  test('renameFolder updates the folder title', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1' })
    const folder = domain.createFolderForThreads({ threads: [t1] })

    const renamed = domain.renameFolder({ folderId: folder.id, title: 'New Name' })

    assert.equal(renamed.title, 'New Name')
    assert.equal(storage.getFolder(folder.id)!.title, 'New Name')
  })

  test('renameFolder throws for non-existent folder', () => {
    const { deps } = createTestDeps()
    const domain = new FolderDomain(deps)

    assert.throws(() => domain.renameFolder({ folderId: 'nope', title: 'x' }), /not found/)
  })

  test('deleteFolder removes folder and unsets folderId on member threads', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1' })
    const t2 = createThread(storage, { id: 't2' })
    const folder = domain.createFolderForThreads({ threads: [t1, t2] })

    domain.deleteFolder(folder.id)

    assert.equal(storage.getFolder(folder.id), undefined)
    assert.equal(storage.getThread('t1')!.folderId, undefined)
    assert.equal(storage.getThread('t2')!.folderId, undefined)
  })

  test('moveThreadToFolder moves thread to a different folder', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1' })
    const t2 = createThread(storage, { id: 't2' })
    const t3 = createThread(storage, { id: 't3' })

    const folder1 = domain.createFolderForThreads({ threads: [t1, t2] })
    const folder2 = domain.createFolderForThreads({ threads: [t3] })

    domain.moveThreadToFolder({ threadId: 't1', folderId: folder2.id })

    assert.equal(storage.getThread('t1')!.folderId, folder2.id)
    assert.equal(storage.getThread('t2')!.folderId, folder1.id)
  })

  test('moveThreadToFolder with null removes thread from folder', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1' })
    const t2 = createThread(storage, { id: 't2' })
    const folder = domain.createFolderForThreads({ threads: [t1, t2] })

    domain.moveThreadToFolder({ threadId: 't1', folderId: null })

    assert.equal(storage.getThread('t1')!.folderId, undefined)
    // folder still exists since t2 is still in it
    assert.ok(storage.getFolder(folder.id))
  })

  test('autoDeleteIfEmpty deletes folder when last thread is removed', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1' })
    const folder = domain.createFolderForThreads({ threads: [t1] })

    domain.moveThreadToFolder({ threadId: 't1', folderId: null })

    // folder should be auto-deleted since it's now empty
    assert.equal(storage.getFolder(folder.id), undefined)
  })

  test('ensureFolderForDerivedThread creates folder when source has no folder', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const source = createThread(storage, { id: 'source', title: 'Original' })
    const derived = createThread(storage, { id: 'derived' })

    domain.ensureFolderForDerivedThread({ sourceThread: source, derivedThread: derived })

    const updatedSource = storage.getThread('source')!
    const updatedDerived = storage.getThread('derived')!

    assert.ok(updatedSource.folderId)
    assert.equal(updatedSource.folderId, updatedDerived.folderId)

    const folder = storage.getFolder(updatedSource.folderId!)!
    assert.equal(folder.title, 'Original')
  })

  test('ensureFolderForDerivedThread adds to existing folder', () => {
    const { deps, storage } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1', title: 'First' })
    const folder = domain.createFolderForThreads({ threads: [t1] })

    // Re-read the thread to get folderId
    const source = storage.getThread('t1')!
    const derived = createThread(storage, { id: 'derived' })

    domain.ensureFolderForDerivedThread({ sourceThread: source, derivedThread: derived })

    assert.equal(storage.getThread('derived')!.folderId, folder.id)
  })

  test('emits correct events on folder creation', () => {
    const { deps, storage, events } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1' })
    domain.createFolderForThreads({ threads: [t1] })

    const folderCreated = events.find((e) => e.type === 'folder.created')
    assert.ok(folderCreated)

    const threadUpdated = events.find((e) => e.type === 'thread.updated')
    assert.ok(threadUpdated)
  })

  test('emits folder.deleted event on deletion', () => {
    const { deps, storage, events } = createTestDeps()
    const domain = new FolderDomain(deps)

    const t1 = createThread(storage, { id: 't1' })
    const folder = domain.createFolderForThreads({ threads: [t1] })

    events.length = 0
    domain.deleteFolder(folder.id)

    const deleted = events.find((e) => e.type === 'folder.deleted')
    assert.ok(deleted)
  })
})
