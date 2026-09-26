import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowserPreview } from './openBrowserPreview.ts'
import type { BrowserAutomationSessionRecord } from '@yachiyo/shared/protocol'

function setup(): {
  backend: Parameters<typeof openBrowserPreview>[0]
  sessions: BrowserAutomationSessionRecord[]
  opens: string[]
} {
  const sessions: BrowserAutomationSessionRecord[] = []
  const opens: string[] = []
  return {
    sessions,
    opens,
    backend: {
      listSessions: ({ threadId }) => sessions.filter((session) => session.threadId === threadId),
      openPreview: async ({ threadId, session, url }) => {
        opens.push(url!)
        sessions.push({
          threadId,
          session,
          url: url!,
          viewport: { width: 1000, height: 800 },
          updatedAt: ''
        })
        return sessions.at(-1)!
      }
    }
  }
}

test('explicit web preview reuses the same conversation resource without navigating it again', async () => {
  const { backend, sessions, opens } = setup()
  const first = await openBrowserPreview(backend, {
    threadId: 'a',
    url: 'https://example.com/page'
  })
  sessions[0].url = 'https://example.com/reading'
  const again = await openBrowserPreview(backend, {
    threadId: 'a',
    url: 'https://example.com/page'
  })
  assert.equal(again.session, first.session)
  assert.equal(again.url, 'https://example.com/reading')
  assert.equal(opens.length, 1)
  await openBrowserPreview(backend, { threadId: 'b', url: 'https://example.com/page' })
  assert.equal(opens.length, 2)
})

test('web preview rejects non-web schemes before opening any native view', async () => {
  const { backend, opens } = setup()
  await assert.rejects(
    openBrowserPreview(backend, { threadId: 'a', url: 'file:///etc/passwd' }),
    /HTTP/
  )
  await assert.rejects(
    openBrowserPreview(backend, { threadId: 'a', url: 'javascript:alert(1)' }),
    /HTTP/
  )
  await assert.rejects(
    openBrowserPreview(backend, { threadId: '', url: 'https://example.com' }),
    /conversation/
  )
  assert.equal(opens.length, 0)
})
