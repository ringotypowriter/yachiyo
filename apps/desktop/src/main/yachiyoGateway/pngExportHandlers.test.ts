import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { MAX_PNG_EXPORT_BYTES, savePngFiles } from './pngExportHandlers.ts'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'png-export-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('saves ordered PNG pages in unique new directories with normalized filenames', async (t) => {
  const parent = await temporaryDirectory(t)
  await writeFile(join(parent, 'existing.png'), 'keep')
  let dialogCalls = 0
  const dependencies = {
    chooseDirectory: async () => {
      dialogCalls += 1
      return parent
    }
  }
  const result = await savePngFiles(
    {
      pages: [png.buffer, new Uint8Array([...png, 1])],
      filenamePrefix: 'folder/chart.PNG'
    },
    dependencies
  )
  assert.equal(result.canceled, false)
  if (result.canceled) return
  assert.equal(dialogCalls, 1)
  assert.equal(dirname(result.directoryPath), parent)
  assert.match(basename(result.directoryPath), /^folder-chart-/)
  assert.deepEqual(
    result.filePaths.map((path) => basename(path)),
    ['folder-chart-01.png', 'folder-chart-02.png']
  )
  assert.deepEqual(await readFile(result.filePaths[0]), Buffer.from(png))
  assert.deepEqual(await readFile(result.filePaths[1]), Buffer.from([...png, 1]))
  const second = await savePngFiles(
    { pages: [png], filenamePrefix: 'folder/chart.PNG' },
    dependencies
  )
  assert.equal(second.canceled, false)
  if (!second.canceled) assert.notEqual(second.directoryPath, result.directoryPath)
  assert.equal(await readFile(join(parent, 'existing.png'), 'utf8'), 'keep')
})

test('cancellation performs no filesystem operations', async (t) => {
  const parent = await temporaryDirectory(t)
  let calls = 0
  const result = await savePngFiles(
    { pages: [png] },
    {
      chooseDirectory: async () => {
        calls += 1
        return undefined
      },
      filesystem: {
        mkdtemp: async () => {
          throw new Error('must not create')
        },
        writeFile: async () => {
          throw new Error('must not write')
        },
        rm: async () => {
          throw new Error('must not remove')
        }
      }
    }
  )
  assert.deepEqual(result, { canceled: true })
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(parent), [])
})

test('rejects empty, excessive, invalid and oversized pages before showing the dialog', async () => {
  const dependencies = {
    chooseDirectory: async () => {
      throw new Error('must not prompt')
    }
  }
  await assert.rejects(savePngFiles({ pages: [] }, dependencies), /at least one/)
  await assert.rejects(savePngFiles({ pages: Array(31).fill(png) }, dependencies), /at most 30/)
  await assert.rejects(savePngFiles({ pages: [png, new Uint8Array(8)] }, dependencies), /valid PNG/)
  await assert.rejects(
    savePngFiles({ pages: [[...png] as unknown as Uint8Array] }, dependencies),
    /valid PNG/
  )
  const large = new Uint8Array(MAX_PNG_EXPORT_BYTES / 2 + 1)
  large.set(png)
  await assert.rejects(savePngFiles({ pages: [large, large] }, dependencies), /128 MiB/)
})

test('accepts thirty pages and keeps path-like prefixes inside the new directory', async (t) => {
  const parent = await temporaryDirectory(t)
  const result = await savePngFiles(
    { pages: Array(30).fill(png), filenamePrefix: '../../escape' },
    {
      chooseDirectory: async () => parent
    }
  )
  assert.equal(result.canceled, false)
  if (result.canceled) return
  assert.equal(dirname(result.directoryPath), parent)
  assert.equal((await readdir(result.directoryPath)).length, 30)
  assert.ok(result.filePaths.every((path) => dirname(path) === result.directoryPath))
  assert.match(result.filePaths[29], /-30\.png$/)
})

test('partial write failure removes only the new export directory', async (t) => {
  const parent = await temporaryDirectory(t)
  const existing = await mkdtemp(join(parent, 'diagram-'))
  await writeFile(join(existing, 'keep.txt'), 'untouched')
  let writes = 0
  await assert.rejects(
    savePngFiles(
      { pages: [png, png] },
      {
        chooseDirectory: async () => parent,
        filesystem: {
          mkdtemp,
          rm,
          writeFile: async (path, data, options) => {
            writes += 1
            if (writes === 2) throw new Error('disk full')
            await writeFile(path, data, options)
          }
        }
      }
    ),
    /disk full/
  )
  assert.equal(writes, 2)
  assert.deepEqual(await readdir(parent), [basename(existing)])
  assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'untouched')
})

test('directory creation failure never cleans up an existing path', async (t) => {
  const parent = await temporaryDirectory(t)
  await writeFile(join(parent, 'keep.txt'), 'untouched')
  await assert.rejects(
    savePngFiles(
      { pages: [png] },
      {
        chooseDirectory: async () => parent,
        filesystem: {
          mkdtemp: async () => {
            throw new Error('permission denied')
          },
          writeFile,
          rm: async () => {
            throw new Error('must not remove')
          }
        }
      }
    ),
    /permission denied/
  )
  assert.equal(await readFile(join(parent, 'keep.txt'), 'utf8'), 'untouched')
})
