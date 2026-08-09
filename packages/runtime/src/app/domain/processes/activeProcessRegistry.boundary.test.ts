import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const spawnedProcessOwners = [
  'app/domain/background/backgroundBashManager.ts',
  'channels/group/groupProbeClaudeCode.ts',
  'runtime/acp/acpLauncher.ts',
  'services/search/searchService.ts',
  'tools/agentTools/bashTool.ts',
  'tools/agentTools/testSubagentProfile.ts'
]

test('runtime spawn owners register children for synchronous app-exit cleanup', () => {
  for (const relativePath of spawnedProcessOwners) {
    const source = readFileSync(resolve(runtimeRoot, relativePath), 'utf8')
    assert.match(source, /registerActiveChildProcess\((?:child|proc)\)/, relativePath)
  }
})
