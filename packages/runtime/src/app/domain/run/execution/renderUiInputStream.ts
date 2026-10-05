import type { RenderUiToolCallDetails } from '@yachiyo/shared/protocol'

const MAX_RAW_CHARS = 2 * 1024 * 1024
const MAX_SOURCE_BYTES = 256 * 1024
const fields = new Set(['title', 'css', 'html', 'js'])
type Field = 'title' | 'css' | 'html' | 'js'
type State =
  | 'open'
  | 'keyOrEnd'
  | 'key'
  | 'colon'
  | 'valueStart'
  | 'value'
  | 'commaOrEnd'
  | 'done'
  | 'invalid'

/** Bounded incremental JSON object reader. Never stores the escaped input or recovers malformed JSON. */
export class RenderUiInputStream {
  private state: State = 'open'
  private rawChars = 0
  private sourceBytes = 0
  private key = ''
  private current: Field | undefined
  private escape = false
  private unicode = ''
  private pendingHigh = ''
  private afterComma = false
  private values: Partial<Record<Field, string>> = {}

  append(delta: string): RenderUiToolCallDetails | undefined {
    if (this.state === 'invalid' || this.rawChars + delta.length > MAX_RAW_CHARS) {
      this.state = 'invalid'
      return undefined
    }
    this.rawChars += delta.length
    for (const char of delta) {
      if (this.state === 'key' || this.state === 'value') {
        if (this.unicode) {
          if (!/^[0-9a-fA-F]$/.test(char)) {
            this.state = 'invalid'
            break
          }
          this.unicode += char
          if (this.unicode.length === 5) {
            this.addChar(String.fromCharCode(parseInt(this.unicode.slice(1), 16)))
            this.unicode = ''
          }
          continue
        }
        if (this.escape) {
          this.escape = false
          const escaped: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t'
          }
          if (char === 'u') this.unicode = 'u'
          else if (char in escaped) this.addChar(escaped[char])
          else this.state = 'invalid'
          if (this.state === 'invalid') break
          continue
        }
        if (char === '\\') {
          this.escape = true
          continue
        }
        if (char === '"') {
          if (this.pendingHigh) {
            this.state = 'invalid'
            break
          }
          if (this.state === 'key') {
            if (!fields.has(this.key) || this.key in this.values) {
              this.state = 'invalid'
              break
            }
            this.current = this.key as Field
            this.key = ''
            this.state = 'colon'
          } else {
            this.current = undefined
            this.state = 'commaOrEnd'
          }
          continue
        }
        if (char.charCodeAt(0) < 32) {
          this.state = 'invalid'
          break
        }
        this.addChar(char)
        if (this.isInvalid()) break
        continue
      }
      const whitespace = char === ' ' || char === '\n' || char === '\r' || char === '\t'
      if (whitespace && this.state !== 'done') continue
      if (this.state === 'open' && char === '{') this.state = 'keyOrEnd'
      else if (this.state === 'keyOrEnd' && char === '"') {
        this.key = ''
        this.state = 'key'
        this.afterComma = false
      } else if (this.state === 'keyOrEnd' && char === '}' && !this.afterComma) this.state = 'done'
      else if (this.state === 'colon' && char === ':') this.state = 'valueStart'
      else if (this.state === 'valueStart' && char === '"' && this.current) {
        this.values[this.current] = ''
        this.state = 'value'
      } else if (this.state === 'commaOrEnd' && char === ',') {
        this.state = 'keyOrEnd'
        this.afterComma = true
      } else if (this.state === 'commaOrEnd' && char === '}') this.state = 'done'
      else if (this.state !== 'done' || !whitespace) this.state = 'invalid'
      if (this.state === 'invalid') break
    }
    if (this.state === 'invalid' || !this.values.title?.trim() || !this.values.html?.trim())
      return undefined
    return {
      kind: 'renderUi',
      title: this.values.title,
      css: this.values.css ?? '',
      html: this.values.html,
      js: this.values.js ?? ''
    }
  }

  private isInvalid(): boolean {
    return this.state === 'invalid'
  }

  private addChar(char: string): void {
    const code = char.charCodeAt(0)
    if (char.length === 2 && !this.pendingHigh && code >= 0xd800 && code <= 0xdbff) {
      // A provider may supply a complete Unicode scalar in one JS code point.
    } else if (this.pendingHigh) {
      if (code < 0xdc00 || code > 0xdfff) {
        this.state = 'invalid'
        return
      }
      char = this.pendingHigh + char
      this.pendingHigh = ''
    } else if (code >= 0xd800 && code <= 0xdbff) {
      this.pendingHigh = char
      return
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      this.state = 'invalid'
      return
    }
    if (this.state === 'key') {
      this.key += char
      if (this.key.length > 5) this.state = 'invalid'
      return
    }
    if (!this.current) {
      this.state = 'invalid'
      return
    }
    this.values[this.current] = (this.values[this.current] ?? '') + char
    if (this.current === 'title') {
      if (this.values.title!.length > 160) this.state = 'invalid'
    } else {
      this.sourceBytes += Buffer.byteLength(char, 'utf8')
      if (this.sourceBytes > MAX_SOURCE_BYTES) this.state = 'invalid'
    }
  }
}
