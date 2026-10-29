import { APP_RPC_METHODS as methods } from '@yachiyo/shared/appServer/methods'
import type { AppEventEnvelope, AppEventSubscription } from '@yachiyo/shared/appServer/protocol'
import type {
  BootstrapPayload,
  ChatAccepted,
  ThreadRecord,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { YachiyoServer } from '../app/host/YachiyoServer.ts'
import { createProviderCredentialVault } from '../settings/providerCredentialVault.ts'
import { normalizeSettingsConfig, stringifySettingsToml } from '../settings/settingsStore.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import { connectAppServer } from './connect.ts'
import { readAppServerAddress } from './discovery.ts'
import { startAppServer } from './host.ts'

test(
  'desktop business RPC survives a disconnected shell and a second client bootstrap',
  { timeout: 15_000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'y-app-host-'))
    const previousHome = process.env.YACHIYO_HOME
    process.env.YACHIYO_HOME = home
    t.after(async () => {
      if (previousHome === undefined) delete process.env.YACHIYO_HOME
      else process.env.YACHIYO_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    })
    await writeFile(
      join(home, 'config.toml'),
      stringifySettingsToml(
        normalizeSettingsConfig({
          providers: [
            {
              name: 'scripted',
              type: 'openai',
              apiKey: 'test-only',
              modelList: { enabled: ['model'], disabled: [] }
            }
          ],
          toolModel: { mode: 'disabled' }
        })
      )
    )
    const release = Promise.withResolvers<void>()
    const streamed = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    const restarted = Promise.withResolvers<void>()
    const server = await startAppServer({
      home,
      version: 'test',
      liveServices: false,
      commandSocket: false,
      developmentMode: true,
      onShutdown: restarted.resolve,
      log: () => {},
      vault: createProviderCredentialVault({
        vaultPath: join(home, 'provider-credentials.enc'),
        encryptionKey: randomBytes(32)
      }),
      createServer: (options) =>
        new YachiyoServer({
          ...options,
          storage: createInMemoryYachiyoStorage(),
          readSoulDocument: async () => null,
          readUserDocument: async () => null,
          ensureThreadWorkspace: async (id) => {
            const path = join(home, 'workspaces', id)
            await mkdir(path, { recursive: true })
            return path
          },
          resolveThreadWorkspacePath: (id) => join(home, 'workspaces', id),
          createModelRuntime: () => ({
            async *streamReply(request) {
              if (request.purpose && request.purpose !== 'chat') {
                yield 'title'
                return
              }
              yield 'Before disconnect. '
              await release.promise
              yield 'After reconnect.'
            }
          })
        })
    })
    t.after(async () => {
      release.resolve()
      await server.close()
    })
    assert.deepEqual(await readAppServerAddress(home), server.address)
    await assert.rejects(access(join(home, 'remote')), { code: 'ENOENT' })
    await assert.rejects(
      startAppServer({
        home,
        version: 'duplicate',
        liveServices: false,
        commandSocket: false,
        log: () => {},
        vault: createProviderCredentialVault({
          vaultPath: join(home, 'provider-credentials.enc'),
          encryptionKey: randomBytes(32)
        }),
        createServer: () => {
          assert.fail('A second app server must not open the database')
        }
      }),
      { code: 'EADDRINUSE' }
    )
    const unsubscribe = server.server.subscribe((event) => {
      if (event.type === 'message.delta') streamed.resolve()
      if (event.type === 'run.completed') completed.resolve()
      if (event.type === 'run.failed') streamed.reject(new Error(JSON.stringify(event)))
    })
    t.after(unsubscribe)
    const shell = await connectAppServer(server.address, {
      'activityTracker.finalizeAndConsume': () => null
    })
    const client = await connectAppServer(server.address)
    t.after(() => client.client.close())
    await assert.rejects(client.client.call(methods.remoteStatus, []), /encrypted credentials/)
    const subscription = (await client.client.call('app.events', [])) as AppEventSubscription
    let cursor = subscription.cursor
    client.client.subscribe((event) => {
      cursor = (event as AppEventEnvelope).cursor
    })
    const thread = (await client.client.call(methods.createThread, [])) as ThreadRecord
    const accepted = (await client.client.call(methods.sendChat, [
      { threadId: thread.id, content: 'hello' }
    ])) as ChatAccepted
    assert.equal(accepted.thread.id, thread.id)
    await streamed.promise
    client.client.close()
    shell.client.close()
    const second = await connectAppServer(server.address)
    t.after(() => second.client.close())
    const snapshot = (await second.client.call(methods.bootstrap, [])) as BootstrapPayload
    assert.equal(snapshot.latestRunsByThread[thread.id].status, 'running')
    assert.equal(
      snapshot.messagesByThread[thread.id]?.find((message) => message.role === 'assistant')
        ?.content,
      'Before disconnect. '
    )
    release.resolve()
    await completed.promise
    const replay = (await second.client.call('app.events', [cursor])) as AppEventSubscription
    assert.equal(replay.reset, false)
    assert.equal(
      replay.events.some(({ event }) => (event as YachiyoServerEvent).type === 'run.completed'),
      true
    )
    const data = (await second.client.call(methods.loadThreadData, [{ threadId: thread.id }])) as {
      messages: { role: string; content: string }[]
    }
    assert.equal(
      data.messages.find((message) => message.role === 'assistant')?.content,
      'Before disconnect. After reconnect.'
    )
    await assert.rejects(second.client.call('getStorage', []), /Unknown RPC method/)
    const jotdown = (await second.client.call(methods.jotdownCreate, [])) as { id: string }
    const saved = (await second.client.call(methods.jotdownSave, [
      { id: jotdown.id, content: 'Persistent note' }
    ])) as { id: string }
    assert.equal(saved.id, jotdown.id)
    const loaded = (await second.client.call(methods.jotdownLoad, [{ id: jotdown.id }])) as {
      content: string
    }
    assert.equal(loaded.content, 'Persistent note')
    const config = await server.server.getConfig()
    const savedConfig = (await second.client.call(methods.saveConfig, [
      { ...config, general: { ...config.general, demoMode: true } }
    ])) as typeof config
    assert.equal(savedConfig.general?.demoMode, true)
    await restarted.promise
    await server.close()
    assert.equal(await readAppServerAddress(home), null)
  }
)
