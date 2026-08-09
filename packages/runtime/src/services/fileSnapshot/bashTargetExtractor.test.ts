import assert from 'node:assert/strict'
import { basename, isAbsolute, resolve } from 'node:path'
import test from 'node:test'

import { extractBashTargetFiles } from './bashTargetExtractor.ts'

test('extractBashTargetFiles', async (t) => {
  const cwd = resolve('home', 'user', 'project')

  const hasTargetNamed = (targets: string[], filename: string): boolean =>
    targets.some((target) => basename(target) === filename)

  await t.test('extracts sed -i targets', () => {
    const targets = extractBashTargetFiles("sed -i 's/old/new/' file.txt", cwd)
    assert.equal(hasTargetNamed(targets, 'file.txt'), true)
  })

  await t.test('extracts redirect targets', () => {
    const targets = extractBashTargetFiles("echo 'hello' > output.txt", cwd)
    assert.equal(hasTargetNamed(targets, 'output.txt'), true)
  })

  await t.test('extracts tee targets', () => {
    const targets = extractBashTargetFiles('echo hello | tee file.txt', cwd)
    assert.equal(hasTargetNamed(targets, 'file.txt'), true)
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
    assert.equal(isAbsolute(targets[0]!), true)
    assert.equal(targets[0], resolve(cwd, 'out.txt'))
  })

  await t.test('deduplicates targets', () => {
    const targets = extractBashTargetFiles('echo a > file.txt && echo b >> file.txt', cwd)
    const unique = new Set(targets)
    assert.equal(targets.length, unique.size)
  })

  await t.test('extracts cp destination', () => {
    const targets = extractBashTargetFiles('cp source.txt dest.txt', cwd)
    assert.equal(hasTargetNamed(targets, 'dest.txt'), true)
    assert.equal(hasTargetNamed(targets, 'source.txt'), false)
  })

  await t.test('extracts mv destination', () => {
    const targets = extractBashTargetFiles('mv old.txt new.txt', cwd)
    assert.equal(hasTargetNamed(targets, 'new.txt'), true)
    assert.equal(hasTargetNamed(targets, 'old.txt'), false)
  })

  await t.test('extracts touch targets', () => {
    const targets = extractBashTargetFiles('touch a.txt b.txt', cwd)
    assert.equal(hasTargetNamed(targets, 'a.txt'), true)
    assert.equal(hasTargetNamed(targets, 'b.txt'), true)
  })

  await t.test('extracts rm targets', () => {
    const targets = extractBashTargetFiles('rm -f a.txt b.txt', cwd)
    assert.equal(hasTargetNamed(targets, 'a.txt'), true)
    assert.equal(hasTargetNamed(targets, 'b.txt'), true)
  })

  await t.test('extracts absolute paths from string literals', () => {
    const targets = extractBashTargetFiles(
      `python3 -c "with open('/tmp/out.txt','w') as f: f.write('x')"`,
      cwd
    )
    assert.equal(targets.includes(resolve(cwd, '/tmp/out.txt')), true)
  })

  await t.test('handles command chains with semicolons', () => {
    const targets = extractBashTargetFiles('echo a > file1.txt; echo b > file2.txt', cwd)
    assert.equal(hasTargetNamed(targets, 'file1.txt'), true)
    assert.equal(hasTargetNamed(targets, 'file2.txt'), true)
  })

  await t.test('handles out-of-workspace redirects', () => {
    const targets = extractBashTargetFiles("echo 'hello' > /tmp/external.txt", cwd)
    assert.equal(targets.includes(resolve(cwd, '/tmp/external.txt')), true)
  })

  await t.test('ignores string literals that are not paths', () => {
    const targets = extractBashTargetFiles(`echo "hello world"`, cwd)
    assert.equal(targets.length, 0)
  })
})
