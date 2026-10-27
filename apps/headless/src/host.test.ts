import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { runYachiyoCli } from '@yachiyo/cli/yachiyoCli'
import { connectHeadless, resolveHeadlessSocketPath } from '@yachiyo/cli/services/headless'
import { runChatTurn } from '@yachiyo/cli/services/chat'
import { YachiyoServer } from '@yachiyo/runtime/app/host/YachiyoServer'
import { createScriptedModelRuntime } from '@yachiyo/runtime/app/host/remote/testing/scriptedModelRuntime'
import { createInMemoryYachiyoStorage } from '@yachiyo/runtime/storage/memoryStorage'
import {
  normalizeSettingsConfig,
  stringifySettingsToml
} from '@yachiyo/runtime/settings/settingsStore'
import { runRemoteScenario } from '@yachiyo/runtime/remote/testing/remoteScenario'
import type { RemotePairingInfo } from '@yachiyo/shared/remote/command'
import { startHeadlessHost, type HeadlessHost } from './host.ts'

async function fixture(
  t: TestContext,
  remotePort?: number
): Promise<{ host: HeadlessHost; home: string; connect: typeof connectHeadless }> {
  const home = await mkdtemp(join(tmpdir(), 'yh-host-'))
  const oldHome = process.env.YACHIYO_HOME
  process.env.YACHIYO_HOME = home
  let host: HeadlessHost | undefined = undefined
  t.after(async () => {
    await host?.close()
    if (oldHome === undefined) delete process.env.YACHIYO_HOME
    else process.env.YACHIYO_HOME = oldHome
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
            apiKey: 'sk-local-test',
            modelList: { enabled: ['scripted-model'], disabled: [] }
          }
        ],
        toolModel: { mode: 'disabled' },
        sync: { syncDir: join(home, 'disabled-sync') },
        remote: {
          enabled: remotePort !== undefined,
          tunnel: 'none',
          port: remotePort,
          publicEndpoint: 'https://example.test'
        }
      })
    )
  )
  const workspace = (id: string): string => join(home, 'workspaces', id)
  host = await startHeadlessHost({
    home,
    masterKey: randomBytes(32),
    version: 'test',
    log: () => {},
    createServer: (options) =>
      new YachiyoServer({
        ...options,
        storage: createInMemoryYachiyoStorage(),
        resolveThreadWorkspacePath: workspace,
        ensureThreadWorkspace: async (id) => {
          await mkdir(workspace(id), { recursive: true })
          return workspace(id)
        },
        readSoulDocument: async () => null,
        readUserDocument: async () => null,
        createModelRuntime: () => {
          const scripted = createScriptedModelRuntime({ chunkDelayMs: 0, slowChunkDelayMs: 20 })
          return {
            async *streamReply(request) {
              for (const name of ['useBrowser', 'webSearch', 'renderUi', 'createRemotePairingQr']) {
                assert.equal(request.tools?.[name], undefined, `headless must not offer ${name}`)
              }
              yield* scripted.streamReply(request)
            }
          }
        }
      })
  })
  return { host, home, connect: () => connectHeadless(resolveHeadlessSocketPath(home)) }
}

test(
  'CLI streams replies, continues a thread and answers real tool questions without Electron',
  { timeout: 20_000 },
  async (t) => {
    const { host, home, connect } = await fixture(t)
    const connection = await connect()
    t.after(() => connection.client.close())
    let text = ''
    const onEvent: Parameters<typeof runChatTurn>[1]['onEvent'] = (event) => {
      if (event.type === 'message.delta') text += event.delta
    }
    const threadId = await runChatTurn(connection, { content: 'hello', onEvent })
    assert.equal(text, 'Scripted reply to: hello')
    text = ''
    let questions = 0
    assert.equal(
      await runChatTurn(connection, {
        threadId,
        content: 'ask: Continue?',
        onEvent,
        answerQuestion: async (question) => {
          questions++
          assert.equal(question.question, 'Continue?')
          assert.deepEqual(question.choices, ['Yes', 'No'])
          return 'Yes'
        }
      }),
      threadId
    )
    assert.equal(questions, 1)
    assert.match(text, /You answered: Yes/)
    assert.equal(
      host.server
        .getStorage()
        .listThreadMessages(threadId)
        .filter((message) => message.role === 'user').length,
      2
    )
    assert.ok(!(await readFile(join(home, 'config.toml'), 'utf8')).includes('sk-local-test'))

    let stdout = ''
    await runYachiyoCli(['chat', '--json'], {
      connectHeadless: connect,
      readStdin: async () => 'piped prompt',
      stdout: {
        write: (chunk) => {
          stdout += String(chunk)
          return true
        }
      },
      stderr: { write: () => true }
    })
    const events = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(events[0].type, 'chat.accepted')
    assert.ok(events.some((event) => event.type === 'run.completed'))
    assert.equal(
      events
        .filter((event) => event.type === 'message.delta')
        .map((event) => event.delta)
        .join(''),
      'Scripted reply to: piped prompt'
    )
  }
)

test(
  'CLI cancels an unattended question and Ctrl-C cancels an active run',
  { timeout: 20_000 },
  async (t) => {
    const { host, connect } = await fixture(t)
    const connection = await connect()
    t.after(() => connection.client.close())
    let runId = ''
    const cancelled = new Map<string, () => void>()
    host.server.subscribe((event) => {
      if (event.type === 'run.cancelled') cancelled.get(event.runId)?.()
    })
    let ended = Promise.withResolvers<void>()
    await assert.rejects(
      runChatTurn(connection, {
        content: 'ask: Confirm?',
        onEvent: () => {},
        onAccepted: (accepted) => {
          runId = accepted.runId
          cancelled.set(runId, ended.resolve)
        }
      }),
      /needs an answer/
    )
    await ended.promise
    assert.equal(host.server.getStorage().getRun(runId)?.status, 'cancelled')

    const abort = new AbortController()
    ended = Promise.withResolvers<void>()
    await assert.rejects(
      runChatTurn(connection, {
        content: 'slow: cancel this',
        signal: abort.signal,
        onAccepted: (accepted) => {
          runId = accepted.runId
          cancelled.set(runId, ended.resolve)
        },
        onEvent: (event) => {
          if (event.type === 'message.delta') abort.abort()
        }
      }),
      /cancelled/
    )
    await ended.promise
    assert.equal(host.server.getStorage().getRun(runId)?.status, 'cancelled')
  }
)

test(
  'stopping the host disconnects a waiting CLI and closes its active run',
  { timeout: 20_000 },
  async (t) => {
    const { host, connect } = await fixture(t)
    const connection = await connect()
    const streaming = Promise.withResolvers<void>()
    const result = runChatTurn(connection, {
      content: 'slow: wait',
      onEvent: (event) => {
        if (event.type === 'message.delta') streaming.resolve()
      }
    })
    const rejected = assert.rejects(result, /disconnected|closed/)
    await streaming.promise
    await host.close()
    await rejected
  }
)

test(
  'headless Remote pairs, chats, answers, reconnects and replays through the shared protocol',
  { timeout: 25_000 },
  async (t) => {
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const { connect } = await fixture(t, port)
    const connection = await connect()
    t.after(() => connection.client.close())
    const { url } = (await connection.client.call('pairRemote', [])) as { url: string }
    await runRemoteScenario({ pairingUrl: url, endpoint: `ws://127.0.0.1:${port}/remote/v1` })
    const pairings = (await connection.client.call('remoteCommand', [
      { action: 'pairings-list' }
    ])) as RemotePairingInfo[]
    assert.equal(pairings.length, 1)
    assert.deepEqual(
      await connection.client.call('remoteCommand', [
        { action: 'pairings-revoke', pairingId: pairings[0].pairingId }
      ]),
      { revoked: true }
    )
    assert.deepEqual(
      await connection.client.call('remoteCommand', [{ action: 'pairings-list' }]),
      []
    )
  }
)
