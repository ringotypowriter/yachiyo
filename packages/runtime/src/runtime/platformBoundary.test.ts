import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const RUNTIME_SRC = resolve(import.meta.dirname, '..')

const SHELL_CONSUMERS = [
  'services/processBroker/nativeProcessBroker.ts',
  'runtime/acp/acpLauncher.ts',
  'tools/agentTools/testSubagentProfile.ts',
  'channels/group/groupProbeClaudeCode.ts'
]

const BASH_PROCESS_BROKER_CLIENTS = [
  'tools/agentTools/bashTool.ts',
  'app/domain/background/backgroundBashManager.ts'
]

const PROCESS_TREE_CONSUMERS = [
  'services/processBroker/nativeProcessBroker.ts',
  'runtime/acp/acpProcessPool.ts',
  'runtime/acp/acpSessionClient.ts',
  'runtime/acp/acpChatRuntime.ts',
  'tools/agentTools/testSubagentProfile.ts',
  'channels/group/groupProbeClaudeCode.ts',
  'services/search/searchService.ts'
]

test('process broker, ACP, and profile paths consume the shared ShellRuntime', async () => {
  for (const relativePath of SHELL_CONSUMERS) {
    const source = await readFile(resolve(RUNTIME_SRC, relativePath), 'utf8')
    assert.match(source, /runtime\/shell\/shellRuntime|\.\/shellRuntime|\.\.\/shell\/shellRuntime/u)
    assert.doesNotMatch(source, /['"]\/bin\/zsh['"]|['"]\/bin\/bash['"]/u)
  }
})

test('Bash execution paths delegate process ownership to ProcessBroker', async () => {
  for (const relativePath of BASH_PROCESS_BROKER_CLIENTS) {
    const source = await readFile(resolve(RUNTIME_SRC, relativePath), 'utf8')
    assert.match(source, /processBroker/u)
    assert.doesNotMatch(source, /node:child_process|runtime\/shell\/shellRuntime|processTree/u)
  }
})

test('runtime process owners consume ProcessTree without negative PIDs or Unix signals', async () => {
  for (const relativePath of PROCESS_TREE_CONSUMERS) {
    const source = await readFile(resolve(RUNTIME_SRC, relativePath), 'utf8')
    assert.match(source, /processes\/processTree|\.\/processTree/u)
    assert.doesNotMatch(source, /process\.kill\s*\(\s*-/u)
    assert.doesNotMatch(source, /child\.kill\s*\(\s*['"]SIG(?:TERM|KILL)['"]/u)
  }
})

test('ACP commands are never assembled with whitespace join', async () => {
  for (const relativePath of [
    'runtime/acp/acpLauncher.ts',
    'tools/agentTools/testSubagentProfile.ts'
  ]) {
    const source = await readFile(resolve(RUNTIME_SRC, relativePath), 'utf8')
    assert.doesNotMatch(source, /\[profile\.command,\s*\.\.\.profile\.args\]\.join\(['"] ['"]\)/u)
  }
})

test('sync platform selection stays explicit through readiness and execution', async () => {
  const readinessSource = await readFile(resolve(RUNTIME_SRC, 'app/host/syncReadiness.ts'), 'utf8')
  const serverSource = await readFile(resolve(RUNTIME_SRC, 'app/host/YachiyoServer.ts'), 'utf8')

  assert.match(
    readinessSource,
    /export interface SyncReadinessOptions extends RecommendedSyncDirOptions/u
  )
  assert.doesNotMatch(readinessSource, /process\.platform/u)
  assert.doesNotMatch(serverSource, /resolveRecommendedICloudSyncDir/u)
  assert.match(
    serverSource,
    /private async exportThenImport\(\s*binary: string,\s*home: string,\s*syncDir: string,\s*recommendedSyncDir: string\s*\)/su
  )
})

test('pure browser and skill path helpers do not read the host platform', async () => {
  const browserSource = await readFile(
    resolve(RUNTIME_SRC, 'services/webSearch/browserSearchSession.ts'),
    'utf8'
  )
  const skillSource = await readFile(
    resolve(RUNTIME_SRC, 'services/skills/skillDiscovery.ts'),
    'utf8'
  )

  assert.doesNotMatch(browserSource, /input\.platform\s*\?\?\s*process\.platform/u)
  assert.doesNotMatch(skillSource, /options\.caseInsensitive\s*\?\?\s*process\.platform/u)
})
