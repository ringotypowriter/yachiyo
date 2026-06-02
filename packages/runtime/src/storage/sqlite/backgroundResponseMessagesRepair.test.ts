import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBackgroundResponseMessagesRepairQueue } from './backgroundResponseMessagesRepair.ts'

const RESPONSE_MESSAGES = '[{"type":"response.output_text.delta"}]'

const WORKING_FAKE_BETTER_SQLITE3_MODULE = `
const { writeFileSync } = require('node:fs')

module.exports = class FakeDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath
  }

  pragma() {}

  prepare(sql) {
    if (sql !== 'UPDATE messages SET response_messages = ? WHERE id = ?') {
      throw new Error('Unexpected SQL: ' + sql)
    }

    return {
      run: (responseMessages, messageId) => {
        writeFileSync(this.dbPath, JSON.stringify({ messageId, responseMessages }))
      }
    }
  }
}
`

const FAILING_FAKE_BETTER_SQLITE3_MODULE = `
module.exports = class FakeDatabase {
  pragma() {}

  prepare() {
    throw new Error('fake responseMessages repair failure')
  }
}
`

function serializeWarningArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? arg.message

  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

async function waitForUnhandledRejectionWindow(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('background responseMessages repair worker resolves better-sqlite3 from the app module path', async () => {
  const originalCwd = process.cwd()
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-response-repair-cwd-'))
  const dbPath = join(root, 'persisted-response-message.json')
  const fakeModulePath = join(root, 'fake-better-sqlite3.cjs')
  let queue: ReturnType<typeof createBackgroundResponseMessagesRepairQueue> | undefined

  try {
    await writeFile(fakeModulePath, WORKING_FAKE_BETTER_SQLITE3_MODULE)
    process.chdir(root)

    queue = createBackgroundResponseMessagesRepairQueue(dbPath, {
      betterSqlite3ModulePath: fakeModulePath
    })
    queue.schedule({
      messageId: 'msg-1',
      responseMessages: RESPONSE_MESSAGES
    })
    await queue.flush()

    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as {
      messageId: string
      responseMessages: string
    }
    assert.deepEqual(persisted, {
      messageId: 'msg-1',
      responseMessages: RESPONSE_MESSAGES
    })
  } finally {
    queue?.close()
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('background responseMessages repair worker failures do not emit unhandled rejections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-response-repair-failure-'))
  const dbPath = join(root, 'storage.sqlite')
  const fakeModulePath = join(root, 'fake-better-sqlite3.cjs')
  const unhandledRejections: unknown[] = []
  const warnCalls: Parameters<typeof console.warn>[] = []
  const originalWarn = console.warn
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason)
  }
  let queue: ReturnType<typeof createBackgroundResponseMessagesRepairQueue> | undefined

  try {
    await writeFile(fakeModulePath, FAILING_FAKE_BETTER_SQLITE3_MODULE)
    console.warn = (...args: Parameters<typeof console.warn>) => {
      warnCalls.push(args)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    queue = createBackgroundResponseMessagesRepairQueue(dbPath, {
      betterSqlite3ModulePath: fakeModulePath
    })
    queue.schedule({
      messageId: 'msg-1',
      responseMessages: RESPONSE_MESSAGES
    })
    await queue.flush()
    await waitForUnhandledRejectionWindow()
  } finally {
    queue?.close()
    process.off('unhandledRejection', onUnhandledRejection)
    console.warn = originalWarn
    await rm(root, { recursive: true, force: true })
  }

  assert.ok(warnCalls.length > 0, 'worker failure should be reported through the queue warning')
  assert.deepEqual(unhandledRejections.map(serializeWarningArg), [])
})
