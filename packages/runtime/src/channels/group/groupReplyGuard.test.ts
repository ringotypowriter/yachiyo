import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  GROUP_REPLY_MAX_CHARS,
  findGroupReplyStyleIssue,
  hasForbiddenGroupReplyPrefix,
  hasVisibleGroupReplyContent,
  isOverlongGroupReply
} from './groupReplyGuard.ts'

describe('findGroupReplyStyleIssue', () => {
  it('rejects agreement-filler openers', () => {
    assert.match(findGroupReplyStyleIssue('对，眼神一出来气质就立住了。') ?? '', /agreement filler/)
    assert.match(findGroupReplyStyleIssue('是的，更新内容确实很丰富。') ?? '', /agreement filler/)
    assert.match(findGroupReplyStyleIssue('确实，这个说得有道理。') ?? '', /agreement filler/)
  })

  it('allows words that merely start with a filler character', () => {
    assert.equal(findGroupReplyStyleIssue('对面比你还会玩'), null)
    assert.equal(findGroupReplyStyleIssue('那确实，不然还能是人腿吗'), null)
  })

  it('rejects the quoted-simile commentary formula', () => {
    assert.match(findGroupReplyStyleIssue('这就像老婆饼里没有老婆。') ?? '', /commentary formula/)
    assert.match(findGroupReplyStyleIssue('这张像是被迫营业的表情。') ?? '', /commentary formula/)
  })

  it('rejects clause pile-ups', () => {
    assert.match(
      findGroupReplyStyleIssue('先看背景，再看气氛，然后看表情，接着看运镜，最后看结局，收工。') ??
        '',
      /too many clauses/
    )
  })

  it('allows longer explanation quips up to 4 separators (real DeepSeek-era samples)', () => {
    for (const sample of [
      '(0.5)^n 呗，n=1是50%，n=2是25%，被毛笔点一下就死就是n=1那50%你没躲掉',
      '啊我懂了，每家一直生到生出男孩为止，虽然过程很重男轻女，但数学结果是男女比例还是1:1，所以人口普查数字确实可能没造假'
    ]) {
      assert.equal(findGroupReplyStyleIssue(sample), null, sample)
    }
  })

  it('allows real chat-voice replies (DeepSeek-era samples)', () => {
    for (const sample of [
      '五次方程没有通用求根公式，这是阿贝尔证明的，你饶了我吧',
      '妈妈给我什么配置我就用什么配置，总之不是豆包',
      '金华火腿算好玩的地方吗',
      '因为违法（',
      '那我还好，我没有信用分，不会被清理'
    ]) {
      assert.equal(findGroupReplyStyleIssue(sample), null, sample)
    }
  })
})

describe('isOverlongGroupReply', () => {
  it('allows a short chat sentence', () => {
    assert.equal(isOverlongGroupReply('这猫脸也太臭了哈哈'), false)
  })

  it('allows exactly the limit', () => {
    assert.equal(isOverlongGroupReply('字'.repeat(GROUP_REPLY_MAX_CHARS)), false)
  })

  it('rejects one code point over the limit', () => {
    assert.equal(isOverlongGroupReply('字'.repeat(GROUP_REPLY_MAX_CHARS + 1)), true)
  })

  it('counts code points, not UTF-16 units', () => {
    // Astral-plane emoji are 2 UTF-16 units but 1 code point each.
    assert.equal(isOverlongGroupReply('😹'.repeat(GROUP_REPLY_MAX_CHARS)), false)
  })

  it('ignores surrounding whitespace', () => {
    assert.equal(isOverlongGroupReply(`  ${'字'.repeat(GROUP_REPLY_MAX_CHARS)}  `), false)
  })
})

describe('hasForbiddenGroupReplyPrefix', () => {
  it('rejects replies that start with an ASCII colon', () => {
    assert.equal(hasForbiddenGroupReplyPrefix(':hello there'), true)
  })

  it('rejects replies that start with a full-width colon after whitespace', () => {
    assert.equal(hasForbiddenGroupReplyPrefix('   ：hello there'), true)
  })

  it('rejects replies that start with a closing brace after whitespace', () => {
    assert.equal(hasForbiddenGroupReplyPrefix('   }hello there'), true)
  })

  it('allows normal replies', () => {
    assert.equal(hasForbiddenGroupReplyPrefix('hello there'), false)
  })
})

describe('hasVisibleGroupReplyContent', () => {
  it('rejects whitespace-only replies', () => {
    assert.equal(hasVisibleGroupReplyContent('   \n\t  '), false)
  })

  it('rejects invisible-only replies', () => {
    assert.equal(hasVisibleGroupReplyContent('\u200B\u200D\u2060\uFEFF'), false)
  })

  it('allows replies with visible text', () => {
    assert.equal(hasVisibleGroupReplyContent(' \u200B hello \u200D '), true)
  })
})
