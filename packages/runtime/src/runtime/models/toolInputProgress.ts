/** Track JSON argument progress without treating whitespace inside strings as a stall. */
export class ToolInputProgress {
  chars = 0
  deltas = 0
  private inString = false
  private escaped = false
  private whitespaceChars = 0
  private lastProgressAt: number

  constructor(now = Date.now()) {
    this.lastProgressAt = now
  }

  append(delta: string, now = Date.now()): void {
    this.chars += delta.length
    this.deltas++
    for (const char of delta) {
      if (this.inString || !/\s/.test(char)) {
        this.lastProgressAt = now
        this.whitespaceChars = 0
      } else {
        this.whitespaceChars++
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (char === '\\') this.escaped = true
        else if (char === '"') this.inString = false
      } else if (char === '"') {
        this.inString = true
      }
      if (this.whitespaceChars >= 4096) this.fail()
    }
    if (now - this.lastProgressAt >= 60_000) this.fail()
  }

  private fail(): never {
    throw new Error(
      'Tool input made no meaningful progress: repeated empty or whitespace arguments'
    )
  }
}
