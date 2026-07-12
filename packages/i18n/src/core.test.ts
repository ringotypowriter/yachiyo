import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createI18n, resolveLocale, type I18n, type Messages } from './core.ts'

const en = {
  greeting: 'Hello, {name}!',
  tokens: 'Used {count} tokens',
  plain: 'Plain text',
  nested: {
    deep: {
      label: 'Deep label'
    }
  },
  items: {
    one: '{count} item',
    other: '{count} items'
  }
} as const

const zhCN = {
  greeting: '你好，{name}！',
  tokens: '已使用 {count} 个 token',
  plain: '纯文本',
  nested: {
    deep: {
      label: '深层标签'
    }
  },
  items: {
    other: '{count} 个项目'
  }
} satisfies Messages<typeof en>

function makeI18n(): I18n<typeof en> {
  return createI18n({ en, 'zh-CN': zhCN })
}

test('t returns the English message by default', () => {
  const i18n = makeI18n()
  assert.equal(i18n.getLocale(), 'en')
  assert.equal(i18n.t('plain'), 'Plain text')
})

test('t resolves nested dot-path keys', () => {
  const i18n = makeI18n()
  assert.equal(i18n.t('nested.deep.label'), 'Deep label')
})

test('t interpolates string params', () => {
  const i18n = makeI18n()
  assert.equal(i18n.t('greeting', { name: 'Yachiyo' }), 'Hello, Yachiyo!')
})

test('t formats number params with locale-aware grouping', () => {
  const i18n = makeI18n()
  assert.equal(i18n.t('tokens', { count: 12345 }), 'Used 12,345 tokens')
})

test('t leaves unmatched placeholders intact', () => {
  const i18n = makeI18n()
  assert.equal(i18n.t('greeting'), 'Hello, {name}!')
})

test('setLocale switches the active catalog', () => {
  const i18n = makeI18n()
  i18n.setLocale('zh-CN')
  assert.equal(i18n.getLocale(), 'zh-CN')
  assert.equal(i18n.t('plain'), '纯文本')
  assert.equal(i18n.t('greeting', { name: '队长' }), '你好，队长！')
})

test('t falls back to English, then to the key itself', () => {
  const partial = { plain: '纯文本' } as unknown as Messages<typeof en>
  const i18n = createI18n({ en, 'zh-CN': partial })
  i18n.setLocale('zh-CN')
  assert.equal(i18n.t('nested.deep.label'), 'Deep label')
  const loose = i18n.t as (key: string) => string
  assert.equal(loose('does.not.exist'), 'does.not.exist')
})

test('tPlural selects plural category via Intl.PluralRules', () => {
  const i18n = makeI18n()
  assert.equal(i18n.tPlural('items', 1), '1 item')
  assert.equal(i18n.tPlural('items', 2), '2 items')
  assert.equal(i18n.tPlural('items', 0), '0 items')
})

test('tPlural falls back to "other" when the locale has no "one" form', () => {
  const i18n = makeI18n()
  i18n.setLocale('zh-CN')
  assert.equal(i18n.tPlural('items', 1), '1 个项目')
  assert.equal(i18n.tPlural('items', 5), '5 个项目')
})

test('onLocaleChange notifies on change, not on same value, and unsubscribes', () => {
  const i18n = makeI18n()
  let calls = 0
  const off = i18n.onLocaleChange(() => {
    calls += 1
  })
  i18n.setLocale('zh-CN')
  assert.equal(calls, 1)
  i18n.setLocale('zh-CN')
  assert.equal(calls, 1)
  off()
  i18n.setLocale('en')
  assert.equal(calls, 1)
})

test('resolveLocale honors explicit settings', () => {
  assert.equal(resolveLocale('en', 'zh-CN'), 'en')
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN')
})

test('resolveLocale maps auto and invalid settings from the system locale', () => {
  assert.equal(resolveLocale('auto', 'zh-Hans-CN'), 'zh-CN')
  assert.equal(resolveLocale('auto', 'zh'), 'zh-CN')
  assert.equal(resolveLocale('auto', 'en-US'), 'en')
  assert.equal(resolveLocale('auto', 'ja-JP'), 'en')
  assert.equal(resolveLocale(undefined, 'zh-CN'), 'zh-CN')
  assert.equal(resolveLocale('garbage', 'fr-FR'), 'en')
})

test('formatNumber uses locale-aware grouping', () => {
  const i18n = makeI18n()
  assert.equal(i18n.formatNumber(1234567.89), '1,234,567.89')
})

test('formatDate presets produce distinct non-empty output', () => {
  const i18n = makeI18n()
  const date = new Date(2026, 6, 12, 15, 30)
  const time = i18n.formatDate(date, 'time')
  const dateOnly = i18n.formatDate(date, 'date')
  const dateTime = i18n.formatDate(date, 'dateTime')
  assert.ok(time.includes('30'))
  assert.ok(!time.includes('2026'))
  assert.ok(dateOnly.includes('2026'))
  assert.ok(!dateOnly.includes('30'))
  assert.ok(dateTime.includes('2026'))
  assert.ok(dateTime.includes('30'))
})

test('formatDate relative preset renders human-friendly offsets', () => {
  const i18n = makeI18n()
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  assert.equal(i18n.formatDate(yesterday, 'relative'), 'yesterday')
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  assert.equal(i18n.formatDate(twoHoursAgo, 'relative'), '2 hours ago')
})
