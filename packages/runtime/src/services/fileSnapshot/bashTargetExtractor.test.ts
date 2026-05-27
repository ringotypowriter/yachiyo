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
    const unique = new Set(targets)
    assert.equal(targets.length, unique.size)
  })

  await t.test('extracts cp destination', () => {
    const targets = extractBashTargetFiles('cp source.txt dest.txt', cwd)
    assert.ok(targets.some((t) => t.endsWith('/dest.txt')))
    assert.ok(!targets.some((t) => t.endsWith('/source.txt')))
  })

  await t.test('extracts mv destination', () => {
    const targets = extractBashTargetFiles('mv old.txt new.txt', cwd)
    assert.ok(targets.some((t) => t.endsWith('/new.txt')))
    assert.ok(!targets.some((t) => t.endsWith('/old.txt')))
  })

  await t.test('extracts touch targets', () => {
    const targets = extractBashTargetFiles('touch a.txt b.txt', cwd)
    assert.ok(targets.some((t) => t.endsWith('/a.txt')))
    assert.ok(targets.some((t) => t.endsWith('/b.txt')))
  })

  await t.test('extracts rm targets', () => {
    const targets = extractBashTargetFiles('rm -f a.txt b.txt', cwd)
    assert.ok(targets.some((t) => t.endsWith('/a.txt')))
    assert.ok(targets.some((t) => t.endsWith('/b.txt')))
  })

  await t.test('extracts absolute paths from string literals', () => {
    const targets = extractBashTargetFiles(
      `python3 -c "with open('/tmp/out.txt','w') as f: f.write('x')"`,
      cwd
    )
    assert.ok(targets.some((t) => t === '/tmp/out.txt'))
  })

  await t.test('handles command chains with semicolons', () => {
    const targets = extractBashTargetFiles('echo a > file1.txt; echo b > file2.txt', cwd)
    assert.ok(targets.some((t) => t.endsWith('/file1.txt')))
    assert.ok(targets.some((t) => t.endsWith('/file2.txt')))
  })

  await t.test('handles out-of-workspace redirects', () => {
    const targets = extractBashTargetFiles("echo 'hello' > /tmp/external.txt", cwd)
    assert.ok(targets.some((t) => t === '/tmp/external.txt'))
  })

  await t.test('ignores string literals that are not paths', () => {
    const targets = extractBashTargetFiles(`echo "hello world"`, cwd)
    assert.equal(targets.length, 0)
  })
})
