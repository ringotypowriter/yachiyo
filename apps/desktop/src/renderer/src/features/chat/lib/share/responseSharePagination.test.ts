import assert from 'node:assert/strict'
import test from 'node:test'
import { allocateSharePages } from './responseSharePagination.ts'

test('260 compact table rows pay their repeated header once per page', () => {
  const units = Array.from({ length: 260 }, () => ({ height: 20, overhead: 80, group: 'table' }))
  const pages = allocateSharePages(units, { layout: 'pages', chromeHeight: 230 })
  assert.equal(pages.length, 7)
  assert.deepEqual(pages.flat(), units)
  assert.ok(pages.every((page) => 230 + 80 + page.length * 20 <= 1080))
})

test('split-line chrome is charged once per page, not once per line', () => {
  const units = Array.from({ length: 20 }, () => ({ height: 90, overhead: 80, group: 'code' }))
  const pages = allocateSharePages(units, { layout: 'pages', chromeHeight: 100 })
  assert.deepEqual(
    pages.map((page) => page.length),
    [10, 10]
  )
  assert.deepEqual(pages.flat(), units)
})

test('auto is single at the exact inclusive limit; last page is not padded', () => {
  assert.equal(
    allocateSharePages([{ height: 980 }], { layout: 'auto', chromeHeight: 100 }).length,
    1
  )
  const pages = allocateSharePages([{ height: 800 }, { height: 200 }], {
    layout: 'auto',
    chromeHeight: 100
  })
  assert.deepEqual(
    pages.map((page) => page.reduce((sum, unit) => sum + unit.height, 100)),
    [900, 300]
  )
})

test('headings travel with their following content without losing units', () => {
  const units = [{ height: 850 }, { height: 70, keepWithNext: true }, { height: 90 }]
  const pages = allocateSharePages(units, { layout: 'pages', chromeHeight: 100 })
  assert.deepEqual(pages, [[units[0]], [units[1], units[2]]])
  assert.deepEqual(pages.flat(), units)
})

test('long image rejects overflow explicitly, rather than falling back or cropping', () => {
  assert.equal(
    allocateSharePages([{ height: 5900 }], { layout: 'long', chromeHeight: 100 }).length,
    1
  )
  assert.throws(
    () => allocateSharePages([{ height: 5901 }], { layout: 'long', chromeHeight: 100 }),
    /6000/
  )
})

test('page cap never silently truncates; 30 pages remains permitted', () => {
  const units = Array.from({ length: 30 }, () => ({ height: 980 }))
  assert.equal(allocateSharePages(units, { layout: 'pages', chromeHeight: 100 }).length, 30)
  assert.throws(
    () => allocateSharePages([...units, { height: 980 }], { layout: 'auto', chromeHeight: 100 }),
    /30 pages/
  )
})

test('invalid measurements and unsplittable content fail explicitly', () => {
  assert.throws(
    () => allocateSharePages([{ height: NaN }], { layout: 'auto', chromeHeight: 10 }),
    /measurement/
  )
  assert.throws(
    () => allocateSharePages([{ height: 1081 }], { layout: 'pages', chromeHeight: 0 }),
    /fragment/
  )
  assert.throws(
    () =>
      allocateSharePages([{ height: 600, keepWithNext: true }, { height: 600 }], {
        layout: 'pages',
        chromeHeight: 0
      }),
    /heading/
  )
})
