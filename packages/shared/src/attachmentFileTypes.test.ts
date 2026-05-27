import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_ATTACHMENT_FILE_BYTES,
  classifyAttachmentFileSelection,
  collectAcceptedAttachmentFiles,
  resolveAcceptedAttachmentMediaType
} from './attachmentFileTypes.ts'

test('resolveAcceptedAttachmentMediaType accepts JSON and JSON-derived media types', () => {
  assert.equal(
    resolveAcceptedAttachmentMediaType({ name: 'payload.json', type: 'application/json' }),
    'application/json'
  )
  assert.equal(
    resolveAcceptedAttachmentMediaType({
      name: 'manifest.webmanifest',
      type: 'application/manifest+json'
    }),
    'application/manifest+json'
  )
})

test('resolveAcceptedAttachmentMediaType falls back to structured text extensions', () => {
  assert.equal(
    resolveAcceptedAttachmentMediaType({ name: 'events.jsonl', type: '' }),
    'application/x-ndjson'
  )
  assert.equal(
    resolveAcceptedAttachmentMediaType({ name: 'settings.yaml', type: '' }),
    'application/yaml'
  )
  assert.equal(
    resolveAcceptedAttachmentMediaType({ name: 'config.toml', type: 'application/octet-stream' }),
    'application/toml'
  )
})

test('collectAcceptedAttachmentFiles keeps text-like files and rejects binary files', () => {
  const files = [
    { name: 'notes.md', type: 'text/markdown' },
    { name: 'schema.jsonc', type: '' },
    { name: 'archive.zip', type: 'application/zip' }
  ]

  assert.deepEqual(collectAcceptedAttachmentFiles(files), [
    { file: files[0], mediaType: 'text/markdown' },
    { file: files[1], mediaType: 'application/jsonc' }
  ])
})

test('resolveAcceptedAttachmentMediaType accepts common code and config files by extension or basename', () => {
  assert.equal(
    resolveAcceptedAttachmentMediaType({ name: 'script.ts', type: '' }),
    'text/typescript'
  )
  assert.equal(resolveAcceptedAttachmentMediaType({ name: 'query.sql', type: '' }), 'text/x-sql')
  assert.equal(resolveAcceptedAttachmentMediaType({ name: '.gitignore', type: '' }), 'text/plain')
  assert.equal(resolveAcceptedAttachmentMediaType({ name: 'Dockerfile', type: '' }), 'text/plain')
  assert.equal(
    resolveAcceptedAttachmentMediaType({ name: 'api.graphql', type: 'application/octet-stream' }),
    'text/graphql'
  )
})

test('classifyAttachmentFileSelection explains unsupported, oversized, and sensitive rejections', () => {
  const files = [
    { name: 'config.json', type: 'application/json', size: 128 },
    { name: 'archive.zip', type: 'application/zip', size: 512 },
    { name: 'large.log', type: 'text/plain', size: MAX_ATTACHMENT_FILE_BYTES + 1 },
    { name: '.env.local', type: 'text/plain', size: 64 }
  ]

  assert.deepEqual(classifyAttachmentFileSelection(files), {
    accepted: [{ file: files[0], mediaType: 'application/json' }],
    rejected: [
      { file: files[1], reason: 'unsupported-type' },
      { file: files[2], reason: 'too-large', maxBytes: MAX_ATTACHMENT_FILE_BYTES },
      { file: files[3], reason: 'sensitive-file' }
    ]
  })
})

test('classifyAttachmentFileSelection allows template env files', () => {
  const files = [{ name: '.env.example', type: 'text/plain', size: 32 }]

  assert.deepEqual(classifyAttachmentFileSelection(files), {
    accepted: [{ file: files[0], mediaType: 'text/plain' }],
    rejected: []
  })
})
