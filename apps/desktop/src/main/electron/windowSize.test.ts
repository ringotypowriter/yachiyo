import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadMainWindowSize, trackMainWindowSize } from './windowSize.ts'

const workArea = { width: 1920, height: 1080 }

class WindowStub extends EventEmitter {
  normal = { x: 120, y: 80, width: 1110, height: 740 }
  getNormalBounds(): typeof this.normal {
    return this.normal
  }
  getBounds(): { width: number; height: number } {
    return { width: 1920, height: 1080 }
  }
}

test('a new or corrupt local state uses default dimensions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yachiyo-window-size-'))
  const path = join(home, 'window-state.json')
  try {
    assert.deepEqual(loadMainWindowSize(path, workArea), { width: 1280, height: 820 })
    for (const contents of [
      '{broken',
      'null',
      '{"width":"1100","height":740}',
      '{"width":-1,"height":0}'
    ]) {
      await writeFile(path, contents)
      assert.deepEqual(loadMainWindowSize(path, workArea), { width: 1280, height: 820 })
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('manual resize and close persist normal dimensions for the next launch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yachiyo-window-size-'))
  const path = join(home, 'window-state.json')
  try {
    const window = new WindowStub()
    trackMainWindowSize(window, path)
    window.emit('resized')
    assert.deepEqual(loadMainWindowSize(path, workArea), { width: 1110, height: 740 })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { width: 1110, height: 740 })
    // Closing while maximized/fullscreen must not persist the screen-sized bounds.
    window.normal = { x: 20, y: 30, width: 1000, height: 700 }
    window.emit('close')
    assert.deepEqual(loadMainWindowSize(path, workArea), { width: 1000, height: 700 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('restoration respects minimum size and the current display work area', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yachiyo-window-size-'))
  const path = join(home, 'window-state.json')
  try {
    await writeFile(path, JSON.stringify({ width: 3600, height: 2000 }))
    assert.deepEqual(loadMainWindowSize(path, { width: 1440, height: 900 }), {
      width: 1440,
      height: 900
    })
    await writeFile(path, JSON.stringify({ width: 100, height: 100 }))
    assert.deepEqual(loadMainWindowSize(path, workArea), { width: 760, height: 500 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
