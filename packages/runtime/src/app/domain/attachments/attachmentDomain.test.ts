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

test('saveImageFilesToWorkspace keeps converted image names unique', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-attachment-domain-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const images = await saveImageFilesToWorkspace({
    workspacePath,
    messageId: 'message-1',
    images: [
      {
        filename: 'chart.gif',
        mediaType: 'image/png',
        dataUrl: 'data:image/png;base64,Zmlyc3Q='
      },
      {
        filename: 'chart.bmp',
        mediaType: 'image/png',
        dataUrl: 'data:image/png;base64,c2Vjb25k'
      }
    ]
  })

  assert.notEqual(images[0]?.workspacePath, images[1]?.workspacePath)
  assert.equal(await readFile(images[0]!.workspacePath!, 'utf8'), 'first')
  assert.equal(await readFile(images[1]!.workspacePath!, 'utf8'), 'second')
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

test('saveFileAttachmentsToWorkspace adds a storage extension for an extensionless file', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-attachment-domain-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const [attachment] = await saveFileAttachmentsToWorkspace({
    workspacePath,
    messageId: 'message-1',
    attachments: [
      {
        filename: 'LICENSE',
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,UERG'
      }
    ]
  })

  assert.equal(attachment?.filename, 'LICENSE')
  assert.ok(attachment?.workspacePath)
  assert.equal(attachment.workspacePath.endsWith('1-LICENSE.pdf'), true)
  assert.equal(await readFile(attachment.workspacePath, 'utf8'), 'PDF')
})

test('workspace attachment names stay within the filesystem byte limit', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-attachment-domain-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))

  const longAsciiName = `${'a'.repeat(250)}.pdf`
  const longUtf8Name = `${'界'.repeat(83)}.pdf`
  const attachments = await saveFileAttachmentsToWorkspace({
    workspacePath,
    messageId: 'message-1',
    attachments: [
      {
        filename: longAsciiName,
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,QQ=='
      },
      {
        filename: longUtf8Name,
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,Qg=='
      }
    ]
  })

  for (const attachment of attachments) {
    assert.ok(attachment.workspacePath)
    assert.equal(Buffer.byteLength(attachment.workspacePath.split('/').at(-1)!), 255)
  }
  assert.equal(await readFile(attachments[0]!.workspacePath!, 'utf8'), 'A')
  assert.equal(await readFile(attachments[1]!.workspacePath!, 'utf8'), 'B')

  const [image] = await saveImageFilesToWorkspace({
    workspacePath,
    messageId: 'message-2',
    images: [
      {
        filename: `a.${'x'.repeat(252)}`,
        mediaType: 'image/x-custom',
        dataUrl: 'data:image/x-custom;base64,Qw=='
      }
    ]
  })
  assert.ok(image?.workspacePath)
  assert.equal(Buffer.byteLength(image.workspacePath.split('/').at(-1)!), 255)
  assert.equal(await readFile(image.workspacePath, 'utf8'), 'C')
})
