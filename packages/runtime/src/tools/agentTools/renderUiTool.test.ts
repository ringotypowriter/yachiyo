import assert from 'node:assert/strict'
import test from 'node:test'
import type { Tool } from 'ai'
import { createTool, renderUiInputSchema, runRenderUiTool } from './renderUiTool.ts'
import {
  createAgentToolSet,
  normalizeToolResult,
  resolveAvailableToolNamesFromToolSet,
  summarizeToolInput
} from '../agentTools.ts'
import { resolveRunModeEnabledTools } from '@yachiyo/shared/toolModes'
import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { parseToolCallDetails, serializeToolCallDetails } from '../../storage/storage.ts'

const input = { title: 'Calculator', css: '', html: '<button>Calculate</button>', js: '' }

test('renderUi preserves complete source in details and returns only a concise model receipt', async () => {
  const output = runRenderUiTool(input)
  assert.deepEqual(output.details, { kind: 'renderUi', ...input })
  assert.equal(normalizeToolResult('renderUi', output).status, 'completed')
  const modelOutput = await createTool().toModelOutput!({ output, toolCallId: 'ui', input })
  assert.equal(modelOutput.type, 'text')
  assert.ok(!JSON.stringify(modelOutput).includes(input.html))
  assert.equal(summarizeToolInput('renderUi', input), 'Calculator')
})

test('renderUi rejects blank HTML, excessive title and combined UTF-8 source size', () => {
  assert.equal(renderUiInputSchema.safeParse({ ...input, html: '  ' }).success, false)
  assert.equal(renderUiInputSchema.safeParse({ ...input, title: 'x'.repeat(161) }).success, false)
  assert.equal(
    renderUiInputSchema.safeParse({ ...input, html: 'a'.repeat(256 * 1024) }).success,
    true
  )
  assert.equal(
    renderUiInputSchema.safeParse({ ...input, html: 'a'.repeat(256 * 1024), css: 'x' }).success,
    false
  )
  assert.equal(renderUiInputSchema.safeParse({ ...input, html: '界'.repeat(90000) }).success, false)
  assert.throws(() => runRenderUiTool({ ...input, html: '' }))
})

test('renderUi is default-enabled in Auto and Code, unavailable in read-only modes', () => {
  assert.ok(resolveRunModeEnabledTools('auto').includes('renderUi'))
  assert.ok(resolveRunModeEnabledTools('code').includes('renderUi'))
  for (const mode of ['explore', 'plan', 'chat'] as const) {
    assert.ok(!resolveRunModeEnabledTools(mode).includes('renderUi'))
  }
  const tools = createAgentToolSet({
    workspacePath: '/tmp',
    enabledTools: ['renderUi'],
    runMode: 'custom'
  })!
  assert.ok(resolveAvailableToolNamesFromToolSet(tools).includes('renderUi'))
})

test('disabled renderUi retains its schema but cannot return executable details', async () => {
  const tools = createAgentToolSet({ workspacePath: '/tmp', enabledTools: ['read'] })!
  assert.ok(tools.renderUi)
  assert.ok(!resolveAvailableToolNamesFromToolSet(tools).includes('renderUi'))
  const disabled = tools.renderUi as Tool<typeof input, unknown>
  const output = await disabled.execute!(input, {
    toolCallId: 'disabled',
    messages: [],
    context: undefined
  })
  assert.equal(normalizeToolResult('renderUi', output).status, 'failed')
  assert.deepEqual((output as { details: unknown }).details, {})
})

test('read-only modes cannot execute renderUi even with an inconsistent enabled tool list', async () => {
  for (const runMode of ['explore', 'plan', 'chat'] as const) {
    const tools = createAgentToolSet({
      workspacePath: '/tmp',
      enabledTools: ['renderUi'],
      runMode
    })!
    assert.ok(!resolveAvailableToolNamesFromToolSet(tools).includes('renderUi'))
    const disabled = tools.renderUi as Tool<typeof input, unknown>
    const output = await disabled.execute!(input, {
      toolCallId: 'readonly',
      messages: [],
      context: undefined
    })
    assert.equal(normalizeToolResult('renderUi', output).status, 'failed')
  }
})

test('history retains full UI source without raw input/output or a separate artifact model', () => {
  const output = runRenderUiTool({
    ...input,
    html: `<p>${'界'.repeat(10000)}</p>`,
    js: 'document.querySelector("p").onclick=()=>{}'
  })
  const details = parseToolCallDetails(serializeToolCallDetails(output.details))
  const storage = createInMemoryYachiyoStorage()
  storage.createToolCall({
    id: 'history-ui',
    threadId: 'history',
    toolName: 'renderUi',
    status: 'completed',
    inputSummary: input.title,
    startedAt: '2026-10-05T10:00:00Z',
    details
  })
  assert.deepEqual(storage.listThreadToolCalls('history')[0]?.details, output.details)
  assert.equal(storage.listThreadToolCalls('history')[0]?.rawInput, undefined)
})
