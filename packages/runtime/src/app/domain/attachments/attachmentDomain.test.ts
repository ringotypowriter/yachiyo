import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { saveFileAttachmentsToWorkspace, saveImageFilesToWorkspace } from './attachmentDomain.ts'

test('saveImageFilesToWorkspace uses the converted media type for the stored extension', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-attachment-domain-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const [image] = await saveImageFilesToWorkspace({
    workspacePath,
    messageId: 'message-1',
    images: [
      {
        filename: 'diagram.bmp',
        mediaType: 'image/png',
        dataUrl: 'data:image/png;base64,cG5n'
      }
    ]
  })

  assert.equal(image?.filename, 'diagram.bmp')
  assert.ok(image?.workspacePath)
  assert.equal(image.workspacePath.endsWith('diagram.png'), true)
  assert.equal(await readFile(image!.workspacePath, 'utf8'), 'png')
})

test('saveImageFilesToWorkspace preserves the BMP extension for unconverted local images', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-attachment-domain-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const [image] = await saveImageFilesToWorkspace({
    workspacePath,
    messageId: 'message-1',
    images: [
      {
        filename: 'diagram.bmp',
        mediaType: 'image/bmp',
        dataUrl: 'data:image/bmp;base64,Ym1w'
      }
    ]
  })

  assert.ok(image?.workspacePath)
  assert.equal(image.workspacePath.endsWith('diagram.bmp'), true)
  assert.equal(await readFile(image.workspacePath, 'utf8'), 'bmp')
})

test('saveImageFilesToWorkspace preserves the filename extension for open-set local image types', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-attachment-domain-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const [image] = await saveImageFilesToWorkspace({
    workspacePath,
    messageId: 'message-1',
    images: [
      {
        filename: 'diagram.tiff',
        mediaType: 'image/tiff',
        dataUrl: 'data:image/tiff;base64,dGlmZg=='
      }
    ]
  })

  assert.ok(image?.workspacePath)
  assert.equal(image.workspacePath.endsWith('diagram.tiff'), true)
  assert.equal(await readFile(image.workspacePath, 'utf8'), 'tiff')
})

test('saveFileAttachmentsToWorkspace preserves duplicate display names without overwriting data', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-attachment-domain-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const attachments = await saveFileAttachmentsToWorkspace({
    workspacePath,
    messageId: 'message-1',
    attachments: [
      {
        filename: 'report.pdf',
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,Zmlyc3Q=',
        attachmentIndex: 1
      },
      {
        filename: 'report.pdf',
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,c2Vjb25k',
        attachmentIndex: 2
      }
    ]
  })

  assert.deepEqual(
    attachments.map(({ filename, attachmentIndex }) => ({ filename, attachmentIndex })),
    [
      { filename: 'report.pdf', attachmentIndex: 1 },
      { filename: 'report.pdf', attachmentIndex: 2 }
    ]
  )
  assert.notEqual(attachments[0]?.workspacePath, attachments[1]?.workspacePath)
  assert.equal(await readFile(attachments[0]!.workspacePath, 'utf8'), 'first')
  assert.equal(await readFile(attachments[1]!.workspacePath, 'utf8'), 'second')
})

test('saveFileAttachmentsToWorkspace preserves names that collide after sanitizing', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-attachment-domain-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const attachments = await saveFileAttachmentsToWorkspace({
    workspacePath,
    messageId: 'message-1',
    attachments: [
      {
        filename: 'a/b.pdf',
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,Zmlyc3Q='
      },
      {
        filename: 'a\\b.pdf',
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,c2Vjb25k'
      }
    ]
  })

  assert.notEqual(attachments[0]?.workspacePath, attachments[1]?.workspacePath)
  assert.equal(await readFile(attachments[0]!.workspacePath, 'utf8'), 'first')
  assert.equal(await readFile(attachments[1]!.workspacePath, 'utf8'), 'second')
})
