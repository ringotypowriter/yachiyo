import assert from 'node:assert/strict'
import test from 'node:test'

import { CORE_TOOL_NAMES } from '@yachiyo/shared/protocol'
import { Wrench } from 'lucide-react'
import { getToolCallIcon } from './toolCallIcons.ts'

test('getToolCallIcon maps every registered core tool to a specific icon', () => {
  for (const toolName of CORE_TOOL_NAMES) {
    assert.notEqual(getToolCallIcon(toolName), Wrench, toolName)
  }
})

test('getToolCallIcon uses Wrench for an imported custom tool', () => {
  assert.equal(getToolCallIcon('customImportedTool'), Wrench)
})
