import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDemoYachiyoStorage } from '../../../../demo/demoMode.ts'
import { createInMemoryYachiyoStorage } from '../../../../storage/memoryStorage.ts'
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

  const server = new YachiyoServer({
    storage: options.demo ? createDemoYachiyoStorage() : createInMemoryYachiyoStorage(),
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
