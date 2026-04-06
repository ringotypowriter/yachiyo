import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createTool, type UpdateProfileDeps } from './updateProfileTool.ts'

function createExecute(deps: UpdateProfileDeps) {
  const tool = createTool(deps)
  const execute = tool.execute!
  return async (
    input: {
      section: string
      operation: 'upsert' | 'remove'
      entries?: Record<string, string>[]
      keys?: string[]
      indices?: number[]
    },
    options: object = {}
  ) =>
    execute(input, {
      abortSignal: AbortSignal.timeout(5000),
      toolCallId: 'test',
      messages: [],
      ...options
    }) as Promise<{
      content: Array<{ type: 'text'; text: string }>
      error?: string
    }>
}

test('updateProfile upserts rows with timestamp into owner Profile section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    const result = await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [
        { Key: 'Name', Value: 'Alice' },
        { Key: 'Role', Value: 'Engineer' }
      ]
    })

    assert.equal(result.error, undefined)
    assert.match(result.content[0]?.text ?? '', /Upserted 2 rows/)

    const content = await readFile(userDocumentPath, 'utf8')
    assert.match(content, /\| Name \| Alice \|/)
    assert.match(content, /\| Role \| Engineer \|/)
    // Timestamp column present
    assert.match(content, /\| Key \| Value \| Since \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile upsert matches by key column case-insensitively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Key: 'Name', Value: 'Alice' }]
    })

    // Update with different casing
    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Key: 'name', Value: 'Bob' }]
    })

    const content = await readFile(userDocumentPath, 'utf8')
    // Should have only one Name row, updated to Bob
    assert.doesNotMatch(content, /Alice/)
    assert.match(content, /\| name \| Bob \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile removes rows by key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [
        { Key: 'Name', Value: 'Alice' },
        { Key: 'Role', Value: 'Engineer' }
      ]
    })

    const removeResult = await execute({
      section: 'Profile',
      operation: 'remove',
      keys: ['Name']
    })

    assert.equal(removeResult.error, undefined)
    assert.match(removeResult.content[0]?.text ?? '', /Removed 1 row/)

    const content = await readFile(userDocumentPath, 'utf8')
    assert.doesNotMatch(content, /Alice/)
    assert.match(content, /\| Role \| Engineer \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile rejects unknown sections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    const result = await execute({
      section: 'Nonexistent',
      operation: 'upsert',
      entries: [{ Key: 'foo', Value: 'bar' }]
    })

    assert.ok(result.error)
    assert.match(result.content[0]?.text ?? '', /Unknown section/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile uses group schema for group mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath, userDocumentMode: 'group' })

    const result = await execute({
      section: 'People',
      operation: 'upsert',
      entries: [{ Nickname: 'xiao_ming', Identity: 'Zhang Ming', Notes: 'owner' }]
    })

    assert.equal(result.error, undefined)

    const content = await readFile(userDocumentPath, 'utf8')
    assert.match(content, /\| Nickname \| Identity \| Notes \| Since \|/)
    assert.match(content, /\| xiao_ming \| Zhang Ming \| owner \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile upserts rows by index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    // Seed two rows
    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [
        { Key: 'Name', Value: 'Alice' },
        { Key: 'Role', Value: 'Engineer' }
      ]
    })

    // Update second row (index 1) by index
    const result = await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Value: 'Architect' }],
      indices: [1]
    })

    assert.equal(result.error, undefined)
    assert.match(result.content[0]?.text ?? '', /Upserted 1 row/)

    const content = await readFile(userDocumentPath, 'utf8')
    // Row 0 unchanged
    assert.match(content, /\| Name \| Alice \|/)
    // Row 1 value updated, key preserved
    assert.match(content, /\| Role \| Architect \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile removes rows by index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    // Seed three rows
    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [
        { Key: 'Name', Value: 'Alice' },
        { Key: 'Role', Value: 'Engineer' },
        { Key: 'Team', Value: 'Backend' }
      ]
    })

    // Remove row at index 1 (Role)
    const result = await execute({
      section: 'Profile',
      operation: 'remove',
      indices: [1]
    })

    assert.equal(result.error, undefined)
    assert.match(result.content[0]?.text ?? '', /Removed 1 row/)

    const content = await readFile(userDocumentPath, 'utf8')
    assert.match(content, /\| Name \| Alice \|/)
    assert.doesNotMatch(content, /Engineer/)
    assert.match(content, /\| Team \| Backend \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile rejects out-of-range indices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    // Seed one row
    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Key: 'Name', Value: 'Alice' }]
    })

    // Try to update index 5 which doesn't exist
    const result = await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Value: 'Bob' }],
      indices: [5]
    })

    assert.ok(result.error)
    assert.match(result.content[0]?.text ?? '', /out of range/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile index upsert does not require key column', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    // Seed a row
    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Key: 'Name', Value: 'Alice' }]
    })

    // Update by index without providing the key column — should work
    const result = await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Value: 'Updated' }],
      indices: [0]
    })

    assert.equal(result.error, undefined)

    const content = await readFile(userDocumentPath, 'utf8')
    // Key preserved from existing row, value updated
    assert.match(content, /\| Name \| Updated \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile index upsert rejects blank key column', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Key: 'Name', Value: 'Alice' }]
    })

    // Try to blank out the key column via index upsert
    const result = await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Key: '', Value: 'Ghost' }],
      indices: [0]
    })

    assert.ok(result.error)
    assert.match(result.content[0]?.text ?? '', /key/i)

    // Original row should be untouched
    const content = await readFile(userDocumentPath, 'utf8')
    assert.match(content, /\| Name \| Alice \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile index upsert rejects duplicate key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    const execute = createExecute({ userDocumentPath })

    await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [
        { Key: 'Name', Value: 'Alice' },
        { Key: 'Role', Value: 'Engineer' }
      ]
    })

    // Try to change row 1's key to "Name" — duplicates row 0
    const result = await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Key: 'Name', Value: 'Imposter' }],
      indices: [1]
    })

    assert.ok(result.error)
    assert.match(result.content[0]?.text ?? '', /duplicate/i)

    // Table should be unchanged
    const content = await readFile(userDocumentPath, 'utf8')
    assert.match(content, /\| Name \| Alice \|/)
    assert.match(content, /\| Role \| Engineer \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateProfile migrates legacy freeform content into table rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-profile-'))
  const userDocumentPath = join(root, 'USER.md')

  try {
    // Write a legacy file with freeform prose in Profile
    await writeFile(
      userDocumentPath,
      [
        '# USER',
        '',
        '## Profile',
        '',
        'Alice is a senior engineer.',
        'Works on backend.',
        '',
        '## Preferences',
        '',
        '## Collaboration Notes',
        ''
      ].join('\n'),
      'utf8'
    )

    const execute = createExecute({ userDocumentPath })

    // Upsert into Profile — should migrate existing prose + add new row
    const result = await execute({
      section: 'Profile',
      operation: 'upsert',
      entries: [{ Key: 'Role', Value: 'Tech Lead' }]
    })

    assert.equal(result.error, undefined)

    const content = await readFile(userDocumentPath, 'utf8')
    // Legacy lines migrated as rows (last column filled)
    assert.match(content, /Alice is a senior engineer/)
    assert.match(content, /Works on backend/)
    // New row added
    assert.match(content, /\| Role \| Tech Lead \|/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
