import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MessageRecord } from '@yachiyo/shared/protocol'
import { summarizeMessagePreview } from '@yachiyo/shared/messageContent'
import { withThreadCapabilities } from '@yachiyo/shared/protocol'

import { createDemoYachiyoStorage } from '../../../../demo/demoMode.ts'
import { createInMemoryYachiyoStorage } from '../../../../storage/memoryStorage.ts'
import type { YachiyoStorage } from '../../../../storage/storage.ts'
import { YachiyoServer } from '../../YachiyoServer.ts'
import { createScriptedModelRuntime } from './scriptedModelRuntime.ts'

export interface FakeDesktopServer {
  server: YachiyoServer
  root: string
  dispose(): Promise<void>
}

export interface FakeDesktopServerOptions {
  /** Extra `config.toml` content appended after the defaults. */
  configToml?: string
  chunkDelayMs?: number
  slowChunkDelayMs?: number
  /** Seed the demo threads used by screenshots and the fake-desktop harness. */
  demo?: boolean
}

const LONG_HISTORY_THREAD_ID = 'demo-thread-long-history'
const LONG_HISTORY_MESSAGE_COUNT = 160

/** Several `threads.load` pages of history, older than every other demo thread. */
function seedLongHistoryThread(storage: YachiyoStorage): void {
  const startedAt = Date.parse('2026-03-01T09:00:00.000Z')
  const messages: MessageRecord[] = []
  for (let index = 1; index <= LONG_HISTORY_MESSAGE_COUNT; index += 1) {
    const isUser = index % 2 === 1
    messages.push({
      id: `demo-msg-long-${index}`,
      threadId: LONG_HISTORY_THREAD_ID,
      ...(index > 1 ? { parentMessageId: `demo-msg-long-${index - 1}` } : {}),
      role: isUser ? 'user' : 'assistant',
      content: isUser
        ? `History question ${index}`
        : `History answer ${index}\n\nThis reply fills a few lines so that one page of history is taller than the screen and paging has to keep the reading position.${
            // The newest reply ends in a code block wider than a phone, for horizontal scrolling.
            index === LONG_HISTORY_MESSAGE_COUNT
              ? '\n\n```ts\nconst widerThanThePhone = [' +
                Array.from({ length: 24 }, (_, column) => `'column-${column}'`).join(', ') +
                ']\n```'
              : ''
          }`,
      status: 'completed',
      createdAt: new Date(startedAt + index * 60_000).toISOString(),
      ...(isUser ? {} : { providerName: 'scripted', modelId: 'scripted-model' })
    })
  }
  const last = messages.at(-1)!
  storage.createThread({
    thread: withThreadCapabilities({
      id: LONG_HISTORY_THREAD_ID,
      title: 'Long history',
      preview: summarizeMessagePreview(last),
      updatedAt: last.createdAt,
      headMessageId: last.id
    }),
    createdAt: new Date(startedAt).toISOString(),
    messages
  })
}

/**
 * A YachiyoServer on in-memory storage with the scripted model, rooted in a temp directory so
 * nothing touches the real `~/.yachiyo`. Shared by remote tests and the fake-desktop harness.
 */
export async function createFakeDesktopServer(
  options: FakeDesktopServerOptions = {}
): Promise<FakeDesktopServer> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-remote-fake-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(
    settingsPath,
    [
      '[toolModel]',
      'mode = "disabled"',
      '',
      '[[providers]]',
      'name = "scripted"',
      'type = "openai"',
      'apiKey = "sk-scripted-local"',
      'baseUrl = "http://127.0.0.1:9/v1"',
      '',
      '[providers.modelList]',
      'enabled = ["scripted-model"]',
      'disabled = []',
      '',
      options.configToml ?? ''
    ].join('\n'),
    'utf8'
  )
  const workspacePathForThread = (threadId: string): string => join(root, 'workspaces', threadId)

  const storage = options.demo ? createDemoYachiyoStorage() : createInMemoryYachiyoStorage()
  if (options.demo) seedLongHistoryThread(storage)

  const server = new YachiyoServer({
    storage,
    settingsPath,
    resolveThreadWorkspacePath: workspacePathForThread,
    ensureThreadWorkspace: async (threadId) => {
      const workspacePath = workspacePathForThread(threadId)
      await mkdir(workspacePath, { recursive: true })
      return workspacePath
    },
    cloneThreadWorkspace: async (_sourceThreadId, targetThreadId) => {
      const workspacePath = workspacePathForThread(targetThreadId)
      await mkdir(workspacePath, { recursive: true })
      return workspacePath
    },
    deleteThreadWorkspace: async (threadId) => {
      await rm(workspacePathForThread(threadId), { recursive: true, force: true })
    },
    createModelRuntime: () =>
      createScriptedModelRuntime({
        chunkDelayMs: options.chunkDelayMs,
        slowChunkDelayMs: options.slowChunkDelayMs
      }),
    readSoulDocument: async () => null,
    readUserDocument: async () => null,
    saveUserDocument: async () => null
  })

  return {
    server,
    root,
    async dispose() {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}
