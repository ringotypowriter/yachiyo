import assert from 'node:assert/strict'
import test from 'node:test'

import { extractBashTargetFiles } from './bashTargetExtractor.ts'

test('extractBashTargetFiles', async (t) => {
  const cwd = '/home/user/project'

  await t.test('extracts sed -i targets', () => {
    const targets = extractBashTargetFiles("sed -i 's/old/new/' file.txt", cwd)
    assert.ok(targets.some((t) => t.endsWith('/file.txt')))
  })

  await t.test('extracts redirect targets', () => {
    const targets = extractBashTargetFiles("echo 'hello' > output.txt", cwd)
    assert.ok(targets.some((t) => t.endsWith('/output.txt')))
  })

  await t.test('extracts tee targets', () => {
    const targets = extractBashTargetFiles('echo hello | tee file.txt', cwd)
    assert.ok(targets.some((t) => t.endsWith('/file.txt')))
  })

  await t.test('ignores /dev/null redirects', () => {
    const targets = extractBashTargetFiles('echo hello > /dev/null', cwd)
    assert.equal(targets.length, 0)
  })

  await t.test('returns empty for read-only commands', () => {
    const targets = extractBashTargetFiles('cat file.txt', cwd)
    assert.equal(targets.length, 0)
  })

  await t.test('resolves relative paths against cwd', () => {
    const targets = extractBashTargetFiles('echo x > out.txt', cwd)
    assert.ok(targets[0]!.startsWith('/'))
    assert.ok(targets[0]!.includes('project'))
  })

  await t.test('deduplicates targets', () => {
    const targets = extractBashTargetFiles('echo a > file.txt && echo b >> file.txt', cwd)
    // May extract file.txt from both redirects, but should be deduplicated
    const unique = new Set(targets)
    assert.equal(targets.length, unique.size)
  })
})
