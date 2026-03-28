import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCQImages } from './qqImageParsing.ts'

describe('parseCQImages', () => {
  it('returns original text and empty images for text-only messages', () => {
    const result = parseCQImages('hello world')
    assert.equal(result.text, 'hello world')
    assert.deepEqual(result.images, [])
  })

  it('extracts a single image file reference and strips the CQ code', () => {
    const raw = '[CQ:image,file=abc.jpg,url=https://example.com/img.jpg]'
    const result = parseCQImages(raw)
    assert.equal(result.text, '')
    assert.deepEqual(result.images, [{ file: 'abc.jpg' }])
  })

  it('extracts multiple image file references', () => {
    const raw =
      '[CQ:image,file=a.jpg,url=https://a.com/1.jpg][CQ:image,file=b.png,url=https://b.com/2.png]'
    const result = parseCQImages(raw)
    assert.equal(result.text, '')
    assert.deepEqual(result.images, [{ file: 'a.jpg' }, { file: 'b.png' }])
  })

  it('preserves text around image CQ codes', () => {
    const raw = 'look at this [CQ:image,file=x.jpg,url=https://img.io/x] nice right?'
    const result = parseCQImages(raw)
    assert.equal(result.text, 'look at this  nice right?')
    assert.deepEqual(result.images, [{ file: 'x.jpg' }])
  })

  it('skips image CQ codes without a file param', () => {
    const raw = '[CQ:image]'
    const result = parseCQImages(raw)
    assert.equal(result.text, '')
    assert.deepEqual(result.images, [])
  })

  it('preserves non-image CQ codes', () => {
    const raw = 'hey [CQ:face,id=123] [CQ:image,file=x.jpg,url=https://img.io/x]'
    const result = parseCQImages(raw)
    assert.equal(result.text, 'hey [CQ:face,id=123]')
    assert.deepEqual(result.images, [{ file: 'x.jpg' }])
  })

  it('handles empty string', () => {
    const result = parseCQImages('')
    assert.equal(result.text, '')
    assert.deepEqual(result.images, [])
  })

  it('handles image CQ code with subType and other extra params', () => {
    const raw = '[CQ:image,file=abc.jpg,subType=0,url=https://img.io/x,file_size=12345]'
    const result = parseCQImages(raw)
    assert.equal(result.text, '')
    assert.deepEqual(result.images, [{ file: 'abc.jpg' }])
  })

  it('extracts file hash identifiers used by NapCat', () => {
    const raw = '[CQ:image,file=0B1A2B3C4D5E6F.image,subType=0,url=https://gchat.qpic.cn/xxx]'
    const result = parseCQImages(raw)
    assert.deepEqual(result.images, [{ file: '0B1A2B3C4D5E6F.image' }])
  })
})
