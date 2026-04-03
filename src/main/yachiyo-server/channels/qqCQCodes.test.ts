import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCQCodes, extractReplyId } from './qqCQCodes.ts'

describe('resolveCQCodes', () => {
  // ── face ──────────────────────────────────────────────────────────
  it('converts known face IDs to emoji labels', () => {
    assert.equal(resolveCQCodes('[CQ:face,id=14]'), '[微笑]')
    assert.equal(resolveCQCodes('[CQ:face,id=5]'), '[流泪]')
  })

  it('converts unknown face IDs to generic label', () => {
    assert.equal(resolveCQCodes('[CQ:face,id=9999]'), '[表情]')
  })

  // ── simple labels ─────────────────────────────────────────────────
  it('converts record to voice label', () => {
    assert.equal(resolveCQCodes('[CQ:record,file=abc.amr,url=https://x.com/v]'), '[语音]')
  })

  it('converts video to video label', () => {
    assert.equal(resolveCQCodes('[CQ:video,file=clip.mp4,url=https://x.com/v]'), '[视频]')
  })

  it('converts poke to poke label', () => {
    assert.equal(resolveCQCodes('[CQ:poke,qq=123]'), '[戳一戳]')
  })

  it('converts contact to contact label', () => {
    assert.equal(resolveCQCodes('[CQ:contact,type=qq,id=123]'), '[名片]')
  })

  it('converts location to location label', () => {
    assert.equal(
      resolveCQCodes('[CQ:location,lat=39.9,lon=116.3,title=Beijing]'),
      '[位置: Beijing]'
    )
  })

  it('converts location without title to plain label', () => {
    assert.equal(resolveCQCodes('[CQ:location,lat=39.9,lon=116.3]'), '[位置]')
  })

  it('converts forward to forward label', () => {
    assert.equal(resolveCQCodes('[CQ:forward,id=abc123]'), '[合并转发]')
  })

  // ── share ─────────────────────────────────────────────────────────
  it('converts share with title and url', () => {
    assert.equal(
      resolveCQCodes('[CQ:share,url=https://example.com,title=Example Site]'),
      '[链接: Example Site](https://example.com)'
    )
  })

  it('converts share with only url', () => {
    assert.equal(
      resolveCQCodes('[CQ:share,url=https://example.com]'),
      '[链接](https://example.com)'
    )
  })

  // ── json card ─────────────────────────────────────────────────────
  it('extracts title from json card meta detail', () => {
    const data = encodeURIComponent(
      JSON.stringify({ meta: { detail_1: { title: '小程序标题', desc: '描述' } } })
    )
    assert.equal(resolveCQCodes(`[CQ:json,data=${data}]`), '[卡片: 小程序标题]')
  })

  it('extracts prompt from json card', () => {
    const data = encodeURIComponent(JSON.stringify({ prompt: '[分享]一篇文章' }))
    assert.equal(resolveCQCodes(`[CQ:json,data=${data}]`), '[卡片: [分享]一篇文章]')
  })

  it('falls back to generic label for unparseable json', () => {
    assert.equal(resolveCQCodes('[CQ:json,data=not-valid-json]'), '[卡片]')
  })

  it('falls back to generic label for json without useful fields', () => {
    const data = encodeURIComponent(JSON.stringify({ app: 'unknown', ver: '1.0' }))
    assert.equal(resolveCQCodes(`[CQ:json,data=${data}]`), '[卡片]')
  })

  // ── xml card ──────────────────────────────────────────────────────
  it('extracts brief from xml card', () => {
    const xml = encodeURIComponent('<msg><item brief="转发消息概要"/></msg>')
    assert.equal(resolveCQCodes(`[CQ:xml,data=${xml}]`), '[卡片: 转发消息概要]')
  })

  it('falls back to generic label for xml without brief', () => {
    const xml = encodeURIComponent('<msg><item/></msg>')
    assert.equal(resolveCQCodes(`[CQ:xml,data=${xml}]`), '[卡片]')
  })

  // ── reply ─────────────────────────────────────────────────────────
  it('strips reply CQ code', () => {
    assert.equal(resolveCQCodes('[CQ:reply,id=123456]hello'), 'hello')
  })

  // ── catch-all ─────────────────────────────────────────────────────
  it('converts unknown CQ codes to a clean label', () => {
    assert.equal(resolveCQCodes('[CQ:music,type=qq,id=123]'), '[music]')
  })

  // ── mixed ─────────────────────────────────────────────────────────
  it('handles multiple CQ codes in one message', () => {
    const input = '[CQ:reply,id=999]hey [CQ:face,id=14] look [CQ:record,file=a.amr]'
    assert.equal(resolveCQCodes(input), 'hey [微笑] look [语音]')
  })

  it('preserves plain text without CQ codes', () => {
    assert.equal(resolveCQCodes('just normal text'), 'just normal text')
  })

  it('handles empty string', () => {
    assert.equal(resolveCQCodes(''), '')
  })
})

describe('extractReplyId', () => {
  it('extracts reply message ID', () => {
    assert.equal(extractReplyId('[CQ:reply,id=123456]hello'), '123456')
  })

  it('returns null when no reply', () => {
    assert.equal(extractReplyId('just text'), null)
  })

  it('extracts reply ID even with other params', () => {
    assert.equal(extractReplyId('[CQ:reply,id=789,seq=100]text'), '789')
  })
})
