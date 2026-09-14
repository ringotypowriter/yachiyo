import assert from 'node:assert/strict'
import test from 'node:test'
import { PLAN_DOCUMENT_MARKER } from '@yachiyo/shared/planMode'
import type { Message, ToolCall, RunRecord } from '../../../../app/types.ts'
import type { MessageGroup } from '../timeline/messageThreadPresentation.ts'
import { buildResponseShareSnapshot } from './responseShareModel.ts'

const time = (second: number): string => `2026-05-01T00:00:${String(second).padStart(2, '0')}.000Z`
const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  threadId: 'thread',
  role: 'assistant',
  parentMessageId: 'question',
  content: id,
  status: 'completed',
  createdAt: time(1),
  ...extra
})
const tool = (id: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  id,
  threadId: 'thread',
  requestMessageId: 'question',
  toolName: 'read',
  inputSummary: id,
  status: 'completed',
  startedAt: time(2),
  ...extra
})
const run = (id: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  threadId: 'thread',
  requestMessageId: 'question',
  status: 'completed',
  createdAt: time(0),
  ...extra
})
const group = (assistants: Message[], extra: Partial<MessageGroup> = {}): MessageGroup => ({
  userMessage: message('question', {
    role: 'user',
    content: 'Visible question'
  }),
  assistantBranches: assistants.slice(0, 1).map((message) => ({ message, isActive: true })),
  activeAssistantMessages: assistants,
  activeBranchIndex: assistants.length ? 0 : -1,
  hiddenRequestMessageIds: [],
  userSteerMessages: [],
  hideActiveBranchWhilePreparing: false,
  showPreparing: false,
  ...extra
})
const trace = (...ids: string[]): unknown[] => [
  {
    role: 'assistant',
    content: ids.map((id) =>
      id === 'text'
        ? { type: 'text', text: 'recorded' }
        : { type: 'tool-call', toolCallId: id, input: { recorded: id } }
    )
  }
]

test('captures complete selected continuation in trace order without sibling failed tools', () => {
  const first = message('first', {
    textBlocks: [{ id: 'one', content: 'First', createdAt: time(1) }],
    responseMessages: trace('text', 'selected')
  })
  const last = message('last', {
    createdAt: time(5),
    content: 'Last',
    parentMessageId: 'hidden'
  })
  const sibling = message('sibling', {
    status: 'failed',
    responseMessages: trace('sibling-tool')
  })
  const snapshot = buildResponseShareSnapshot({
    group: group([first, last], { hiddenRequestMessageIds: ['hidden'] }),
    messages: [first, last, sibling],
    runs: [],
    toolCalls: [
      tool('selected', { assistantMessageId: 'sibling', startedAt: time(0) }),
      tool('sibling-tool', { assistantMessageId: 'first' }),
      tool('ambiguous'),
      tool('bound', { assistantMessageId: 'last', startedAt: time(6) })
    ]
  })!
  assert.deepEqual(
    snapshot.blocks.map((block) => block.id),
    ['one', 'selected', 'last', 'bound']
  )
  assert.equal(snapshot.question?.content, 'Visible question')
})

test('honors explicit empty visible reply, excludes reasoning and strips plan markers', () => {
  const hidden = message('raw', {
    content: 'secret raw',
    visibleReply: '',
    reasoning: 'secret thoughts'
  })
  const plan = message('plan', {
    content: `${PLAN_DOCUMENT_MARKER}\nVisible plan`,
    createdAt: time(3)
  })
  const snapshot = buildResponseShareSnapshot({
    group: group([hidden, plan]),
    messages: [hidden, plan],
    runs: [],
    toolCalls: []
  })!
  assert.deepEqual(snapshot.blocks, [{ kind: 'text', id: 'plan', content: 'Visible plan' }])
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/)
  assert.equal(
    buildResponseShareSnapshot({
      rootMessage: hidden,
      messages: [hidden],
      runs: [],
      toolCalls: []
    }),
    null
  )
})

test('includes visible followups in sequence and never hidden request content', () => {
  const first = message('first')
  const last = message('last', {
    createdAt: time(5),
    parentMessageId: 'steer'
  })
  const snapshot = buildResponseShareSnapshot({
    group: group([first, last], {
      userSteerMessages: [
        message('steer', { role: 'user', createdAt: time(3) }),
        message('hidden', {
          role: 'user',
          hidden: true,
          content: 'private',
          createdAt: time(4)
        })
      ]
    }),
    messages: [first, last],
    runs: [],
    toolCalls: []
  })!
  assert.deepEqual(
    snapshot.blocks.map((block) => [block.kind, block.id]),
    [
      ['text', 'first'],
      ['user', 'steer'],
      ['text', 'last']
    ]
  )
  assert.doesNotMatch(JSON.stringify(snapshot), /private/)
})

test('legacy unbound tools require a provable selected run, not merely a matching request', () => {
  const selected = message('selected')
  const sibling = message('sibling', { status: 'stopped' })
  const tools = [tool('legacy', { runId: 'run' }), tool('unbound')]
  const input = {
    group: group([selected]),
    messages: [selected],
    runs: [run('run')],
    toolCalls: tools
  }
  assert.deepEqual(
    buildResponseShareSnapshot(input)!.blocks.map((block) => block.id),
    ['selected', 'legacy']
  )
  assert.deepEqual(
    buildResponseShareSnapshot({
      ...input,
      messages: [selected, sibling]
    })!.blocks.map((block) => block.id),
    ['selected']
  )
  assert.deepEqual(
    buildResponseShareSnapshot({
      ...input,
      runs: [run('run'), run('retry')]
    })!.blocks.map((block) => block.id),
    ['selected']
  )
})

test('ended failed and stopped responses remain shareable while unrelated runs are active', () => {
  const failed = message('failed', { status: 'failed' })
  const input = {
    group: group([failed]),
    messages: [failed],
    toolCalls: [],
    runs: [run('other', { requestMessageId: 'elsewhere', status: 'running' })]
  }
  assert.equal(buildResponseShareSnapshot(input)?.status, 'failed')
  const stopped = message('stopped', { status: 'stopped' })
  assert.equal(
    buildResponseShareSnapshot({
      ...input,
      group: group([stopped]),
      messages: [stopped]
    })?.status,
    'stopped'
  )
  assert.equal(
    buildResponseShareSnapshot({
      ...input,
      group: group([message('streaming', { status: 'streaming' })])
    }),
    null
  )
})

test('tool-only ended legacy run has a snapshot retaining cancellation and tool truth', () => {
  const runningTool = tool('interrupted', { runId: 'run', status: 'running' })
  const input = {
    group: group([]),
    messages: [],
    toolCalls: [runningTool],
    runs: [run('run', { status: 'cancelled' })]
  }
  const snapshot = buildResponseShareSnapshot(input)!
  assert.equal(snapshot.status, 'stopped')
  assert.equal(snapshot.blocks[0]?.kind === 'tool' && snapshot.blocks[0].toolCall.status, 'running')
  assert.equal(
    buildResponseShareSnapshot({
      ...input,
      runs: [run('run', { status: 'running' })]
    }),
    null
  )
})

test('snapshot is detached and deeply frozen, including recorded raw tool data', () => {
  const selected = message('selected', { responseMessages: trace('call') })
  const original = tool('call', {
    assistantMessageId: 'selected',
    rawInput: { mutable: true }
  })
  const snapshot = buildResponseShareSnapshot({
    rootMessage: selected,
    messages: [selected],
    toolCalls: [original],
    runs: [],
    workspacePath: '/workspace'
  })!
  original.inputSummary = 'changed'
  selected.content = 'changed'
  const block = snapshot.blocks.find((block) => block.kind === 'tool')!
  assert.equal(block.kind === 'tool' && block.toolCall.inputSummary, 'call')
  assert.ok(Object.isFrozen(snapshot.blocks))
  assert.ok(block.kind === 'tool' && Object.isFrozen(block.toolCall.rawInput))
  assert.equal(snapshot.workspacePath, '/workspace')
})

test('rejects stale full-path supplements when selected response belongs to a sibling', () => {
  const selected = message('selected')
  const old = message('old', { parentMessageId: 'old-steer' })
  const steer = message('old-steer', { role: 'user' })
  const snapshot = buildResponseShareSnapshot({
    group: group([selected], {
      userSteerMessages: [steer],
      hiddenRequestMessageIds: ['old-hidden']
    }),
    messages: [selected, old, steer],
    toolCalls: [tool('old-tool', { requestMessageId: 'old-steer', runId: 'old-run' })],
    runs: [run('old-run', { requestMessageId: 'old-steer' })]
  })!
  assert.deepEqual(
    snapshot.blocks.map((block) => block.id),
    ['selected']
  )
})

test('hidden roots cannot expose tools and root selected run activity disables sharing', () => {
  const root = message('root', {
    parentMessageId: undefined,
    responseMessages: trace('call')
  })
  const input = {
    rootMessage: root,
    messages: [root],
    toolCalls: [tool('call', { runId: 'run' })],
    runs: [run('run', { status: 'running' })]
  }
  assert.equal(buildResponseShareSnapshot(input), null)
  assert.equal(
    buildResponseShareSnapshot({
      ...input,
      rootMessage: { ...root, hidden: true },
      runs: []
    }),
    null
  )
})

test('same-request active sibling does not disable an ended selected response', () => {
  const selected = message('selected')
  const sibling = message('sibling', { status: 'streaming' })
  assert.ok(
    buildResponseShareSnapshot({
      group: group([selected]),
      messages: [selected, sibling],
      activeRequestMessageId: 'question',
      runs: [run('retry', { status: 'running' })],
      toolCalls: []
    })
  )
})

test('visible question and followup attachment names are captured without paths or payloads', () => {
  const selected = message('selected', { parentMessageId: 'steer' })
  const attachment = {
    filename: '[report](private).pdf',
    mediaType: 'application/pdf',
    workspacePath: '/private/report.pdf'
  }
  const steer = message('steer', { role: 'user', attachments: [attachment] })
  const hidden = message('hidden', {
    role: 'user',
    hidden: true,
    attachments: [{ ...attachment, filename: 'hidden-secret.pdf' }]
  })
  const question = message('question', {
    role: 'user',
    images: [
      {
        filename: 'diagram.png',
        mediaType: 'image/png',
        dataUrl: 'data:private',
        workspacePath: '/private/image.png'
      }
    ],
    attachments: [attachment]
  })
  const snapshot = buildResponseShareSnapshot({
    group: group([selected], { userMessage: question, userSteerMessages: [steer, hidden] }),
    messages: [selected, steer, hidden],
    runs: [],
    toolCalls: []
  })!
  assert.deepEqual(snapshot.question?.attachmentNames, ['diagram.png', '[report](private).pdf'])
  const followup = snapshot.blocks.find((block) => block.kind === 'user')!
  assert.deepEqual(followup.kind === 'user' && followup.attachmentNames, ['[report](private).pdf'])
  assert.ok(Object.isFrozen(snapshot.question?.attachmentNames))
  assert.doesNotMatch(JSON.stringify(snapshot), /\/private\/|data:private|hidden-secret/)
})
