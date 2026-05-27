import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  bashToolInputSchema,
  readToolInputSchema,
  writeToolInputSchema,
  editToolInputSchema,
  grepToolInputSchema,
  globToolInputSchema,
  webSearchToolInputSchema
} from './shared.ts'

describe('shadow fallbacks', () => {
  describe('readToolInputSchema', () => {
    it('accepts filePath as a shadow fallback for path', () => {
      const parsed = readToolInputSchema.safeParse({
        filePath: 'hello.txt',
        offset: 10,
        limit: 50
      })
      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.path, 'hello.txt')
        assert.strictEqual(parsed.data.offset, 10)
        assert.strictEqual(parsed.data.limit, 50)
      }
    })

    it('still accepts canonical path normally', () => {
      const parsed = readToolInputSchema.safeParse({
        path: 'hello.txt'
      })
      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.path, 'hello.txt')
      }
    })
  })

  describe('writeToolInputSchema', () => {
    it('accepts filePath as a shadow fallback for path', () => {
      const parsed = writeToolInputSchema.safeParse({
        filePath: 'out.txt',
        content: 'hello'
      })
      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.path, 'out.txt')
        assert.strictEqual(parsed.data.content, 'hello')
      }
    })
  })

  describe('editToolInputSchema', () => {
    it('accepts filePath as a shadow fallback for path', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        filePath: 'file.txt',
        oldText: 'hello',
        newText: 'hi'
      })
      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.path, 'file.txt')
      }
    })

    it('rejects both filePath and path together (strict mode)', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        filePath: 'other.txt',
        oldText: 'hello',
        newText: 'hi'
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects unknown keys even when filePath is used', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        filePath: 'file.txt',
        oldText: 'hello',
        newText: 'hi',
        bogus: true
      })
      assert.strictEqual(parsed.success, false)
    })
  })

  describe('grepToolInputSchema', () => {
    it('accepts filePath as a shadow fallback for path', () => {
      const parsed = grepToolInputSchema.safeParse({
        pattern: 'foo',
        filePath: '/some/dir'
      })
      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.path, '/some/dir')
      }
    })

    it('omits optional path when neither is provided', () => {
      const parsed = grepToolInputSchema.safeParse({
        pattern: 'foo'
      })
      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.path, undefined)
      }
    })

    it('accepts grep context up to 30 lines', () => {
      const parsed = grepToolInputSchema.safeParse({
        pattern: 'foo',
        context: 30
      })

      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.context, 30)
      }
    })

    it('rejects grep context above 30 lines', () => {
      const parsed = grepToolInputSchema.safeParse({
        pattern: 'foo',
        context: 31
      })

      assert.strictEqual(parsed.success, false)
    })
  })

  describe('globToolInputSchema', () => {
    it('accepts filePath as a shadow fallback for path', () => {
      const parsed = globToolInputSchema.safeParse({
        pattern: '*.ts',
        filePath: 'src'
      })
      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.path, 'src')
      }
    })
  })

  describe('webSearchToolInputSchema', () => {
    it('accepts web search limits up to 30 results', () => {
      const parsed = webSearchToolInputSchema.safeParse({
        query: 'yachiyo',
        limit: 30
      })

      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.limit, 30)
      }
    })

    it('rejects web search limits above 30 results', () => {
      const parsed = webSearchToolInputSchema.safeParse({
        query: 'yachiyo',
        limit: 31
      })

      assert.strictEqual(parsed.success, false)
    })
  })

  describe('bashToolInputSchema', () => {
    it('accepts timeout values up to 300 seconds', () => {
      const parsed = bashToolInputSchema.safeParse({
        command: 'sleep 300',
        timeout: 300
      })

      assert.strictEqual(parsed.success, true)
      if (parsed.success) {
        assert.strictEqual(parsed.data.timeout, 300)
      }
    })

    it('rejects timeout values above 300 seconds', () => {
      const parsed = bashToolInputSchema.safeParse({
        command: 'sleep 301',
        timeout: 301
      })

      assert.strictEqual(parsed.success, false)
    })
  })
})
