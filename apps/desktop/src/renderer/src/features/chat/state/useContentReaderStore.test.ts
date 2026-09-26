import assert from 'node:assert/strict'
import test from 'node:test'
import { useContentReaderStore } from './useContentReaderStore.ts'

test('discard releases global LRU payloads, retains reading descriptors and remounts only selected tabs', async (t) => {
  reset()
  let now = 0
  t.mock.method(Date, 'now', () => now++)
  const store = useContentReaderStore.getState()
  store.open({ kind: 'file', threadId: 'a', path: '/first.pdf' })
  const firstId = useContentReaderStore.getState().conversations.a.activeId
  store.saveReading('a', firstId, { pdfPage: 8, zoom: 1.5, scrollTop: 100 })
  store.open({ kind: 'file', threadId: 'b', path: '/second.txt' })
  store.open({ kind: 'file', threadId: 'c', path: '/third.txt' })
  store.open({ kind: 'file', threadId: 'd', path: '/fourth.txt' })
  store.open({ kind: 'file', threadId: 'e', path: '/current.txt' })
  await store.discardIdle(100, async () => ({ released: true }))
  const first = useContentReaderStore.getState().conversations.a.tabs[0]
  assert.equal(first.hot, false)
  assert.deepEqual(first.reading, { pdfPage: 8, zoom: 1.5, scrollTop: 100 })
  assert.equal(useContentReaderStore.getState().conversations.e.tabs[0].hot, true)
  store.select('a', firstId)
  assert.equal(useContentReaderStore.getState().conversations.a.tabs[0].hot, true)
  assert.deepEqual(useContentReaderStore.getState().conversations.a.tabs[0].reading, first.reading)
})

test('protected browser exceptions remain hot while cold background opens never mount', async (t) => {
  reset()
  t.mock.method(Date, 'now', () => 0)
  const store = useContentReaderStore.getState()
  store.open({ kind: 'web', threadId: 'a', session: 'agent', url: 'https://example.com' })
  store.select('a', 'chat')
  store.open({ kind: 'file', threadId: 'b', path: '/background.txt' }, { activate: false })
  await store.discardIdle(300000, async () => ({ released: false }))
  assert.equal(useContentReaderStore.getState().conversations.a.tabs[0].hot, true)
  assert.equal(useContentReaderStore.getState().conversations.b.tabs[0].hot, false)
})

const file = { kind: 'file' as const, threadId: 'a', path: '/work/report.txt' }
test('background idle clock starts when reading stops, not when a long-lived visible tab opened', async (t) => {
  reset()
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const store = useContentReaderStore.getState()
  store.open(file)
  now = 1200000
  store.select('a', 'chat')
  await store.discardIdle(now, async () => ({ released: true }))
  assert.equal(useContentReaderStore.getState().conversations.a.tabs[0].hot, true)
  await store.discardIdle(now + 300000, async () => ({ released: true }))
  assert.equal(useContentReaderStore.getState().conversations.a.tabs[0].hot, false)
})
function reset(): void {
  useContentReaderStore.setState(useContentReaderStore.getInitialState(), true)
}

test('reloadable images keep only their path source, and closing pathless images releases reference ownership', () => {
  reset()
  const store = useContentReaderStore.getState()
  store.open({
    kind: 'image',
    threadId: 'a',
    path: '/image.png',
    src: 'data:image/png;base64,large'
  })
  const pathTarget = useContentReaderStore.getState().target
  assert.equal(
    pathTarget?.kind === 'image' && pathTarget.src,
    'yachiyo-asset://local/?p=%2Fimage.png'
  )
  store.open({ kind: 'image', threadId: 'a', src: 'data:image/png;base64,pathless' })
  const id = useContentReaderStore.getState().conversations.a.activeId
  store.ask('a', id)
  store.closeTab('a', id)
  assert.equal(useContentReaderStore.getState().references.a, undefined)
})

test('tabs reuse resource and view kind while preserving conversation scope', () => {
  reset()
  const store = useContentReaderStore.getState()
  store.open(file)
  store.open(file)
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 1)
  store.open({ kind: 'diff', threadId: 'a', runId: 'run', workspacePath: '/work' })
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 2)
  store.open({ ...file, threadId: 'b' })
  assert.equal(useContentReaderStore.getState().conversations.b.tabs.length, 1)
  store.select('a', 'chat')
  assert.equal(
    useContentReaderStore.getState().conversations.b.activeId,
    useContentReaderStore.getState().conversations.b.tabs[0].id
  )
  assert.equal(useContentReaderStore.getState().target, null)
})

test('background opens do not steal active tab and close returns to most recently selected tab', () => {
  reset()
  const store = useContentReaderStore.getState()
  store.open(file)
  const first = useContentReaderStore.getState().conversations.a.activeId
  store.open({ ...file, path: '/work/other.txt' }, { activate: false })
  assert.equal(useContentReaderStore.getState().conversations.a.activeId, first)
  store.select('a', 'chat')
  store.open({ ...file, path: '/work/third.txt' })
  store.close()
  assert.equal(useContentReaderStore.getState().conversations.a.activeId, 'chat')
  store.closeTab('a', 'chat')
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 2)
})

test('File Changes retains selected file when reopened and remains one tab per run', () => {
  reset()
  const store = useContentReaderStore.getState()
  const diff = { kind: 'diff' as const, threadId: 'a', runId: 'run', workspacePath: '/work' }
  store.open(diff)
  store.selectDiffFile('run', 'first.ts')
  store.select('a', 'chat')
  store.open(diff)
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 1)
  const target = useContentReaderStore.getState().target
  assert.equal(target?.kind === 'diff' && target.relativePath, 'first.ts')
})

test('delayed web preview never activates after switching conversations', async () => {
  reset()
  const store = useContentReaderStore.getState()
  store.setThread('a')
  let finish!: (value: { session: string; url: string }) => void
  const pending = store.openWeb(
    'a',
    'https://example.com',
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  store.open({ ...file, threadId: 'b' })
  finish({ session: 'preview', url: 'https://example.com' })
  await pending
  assert.equal(useContentReaderStore.getState().threadId, 'b')
  assert.equal(useContentReaderStore.getState().target?.threadId, 'b')
  assert.equal(useContentReaderStore.getState().conversations.a.activeId, 'chat')
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 1)
})

test('switching conversations restores each active tab without closing other resources', () => {
  reset()
  const store = useContentReaderStore.getState()
  store.open(file)
  store.open({ ...file, threadId: 'b', path: '/work/b.txt' })
  store.setThread('a')
  assert.deepEqual(useContentReaderStore.getState().target, file)
  store.select('a', 'chat')
  store.setThread('b')
  assert.equal(useContentReaderStore.getState().target?.threadId, 'b')
  store.setThread('a')
  assert.equal(useContentReaderStore.getState().target, null)
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 1)
})

test('delayed native allocations remain in the global hot budget without activating their conversation', async (t) => {
  reset()
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const store = useContentReaderStore.getState()
  store.setThread('a')
  let finish!: () => void
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  const load = async ({ url }: { url: string }): Promise<{ session: string; url: string }> => {
    await ready
    return { session: url, url }
  }
  const opens = [
    store.openWeb('a', 'https://example.com/1', load),
    store.openWeb('a', 'https://example.com/2', load),
    store.openWeb('a', 'https://example.com/3', load),
    store.openWeb('a', 'https://example.com/4', load)
  ]
  store.open({ ...file, threadId: 'b' })
  finish()
  await Promise.all(opens)
  assert.equal(
    useContentReaderStore.getState().conversations.a.tabs.filter((tab) => tab.hot).length,
    4
  )
  assert.equal(useContentReaderStore.getState().threadId, 'b')
  const released: string[] = []
  const release = async (target: { session: string }): Promise<{ released: boolean }> => {
    released.push(target.session)
    return { released: true }
  }
  await store.discardIdle(now, release)
  assert.equal(released.length, 1)
  now = 300000
  await store.discardIdle(now, release)
  assert.equal(released.length, 4)
  assert.equal(
    useContentReaderStore.getState().conversations.a.tabs.filter((tab) => tab.hot).length,
    0
  )
  assert.equal(useContentReaderStore.getState().target?.threadId, 'b')
  assert.equal(useContentReaderStore.getState().conversations.b.tabs[0].hot, true)
})

test('Ask Yachiyo returns to Chat with a conversation-scoped reference without closing the preview', () => {
  reset()
  const store = useContentReaderStore.getState()
  store.open(file)
  store.ask('a', useContentReaderStore.getState().conversations.a.activeId)
  assert.equal(useContentReaderStore.getState().conversations.a.activeId, 'chat')
  assert.deepEqual(useContentReaderStore.getState().references.a, file)
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 1)
  store.setThread('b')
  store.clearReference()
  assert.deepEqual(useContentReaderStore.getState().references.a, file)
  store.setThread('a')
  store.clearReference()
  assert.equal(useContentReaderStore.getState().references.a, undefined)
})

test('native navigation updates web title, external URL and Ask reference without changing tab identity', async () => {
  reset()
  const store = useContentReaderStore.getState()
  store.open({
    kind: 'web',
    threadId: 'a',
    session: 'stable-session',
    url: 'https://example.com/a',
    title: 'Page A'
  })
  const id = useContentReaderStore.getState().conversations.a.activeId
  const current = await store.refreshWeb('a', 'stable-session', async () => [
    { threadId: 'a', session: 'stable-session', url: 'https://example.com/b', title: 'Page B' }
  ])
  assert.equal(current?.url, 'https://example.com/b')
  assert.equal(current?.title, 'Page B')
  assert.equal(useContentReaderStore.getState().conversations.a.activeId, id)
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 1)
  store.ask('a', id)
  const reference = useContentReaderStore.getState().references.a
  assert.equal(reference.kind === 'web' && reference.url, 'https://example.com/b')
})

test('late native metadata does not recreate closed previews or activate another conversation', async () => {
  reset()
  const store = useContentReaderStore.getState()
  store.open({ kind: 'web', threadId: 'a', session: 's', url: 'https://example.com/a' })
  let finish!: (pages: { threadId: string; session: string; url: string }[]) => void
  const pending = store.refreshWeb(
    'a',
    's',
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  store.close()
  store.open({ ...file, threadId: 'b' })
  finish([{ threadId: 'a', session: 's', url: 'https://example.com/b' }])
  assert.equal(await pending, null)
  assert.equal(useContentReaderStore.getState().conversations.a.tabs.length, 0)
  assert.equal(useContentReaderStore.getState().target?.threadId, 'b')
})
