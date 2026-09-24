export interface ShellToken {
  text: string
  start: number
  end: number
  operator?: boolean
}

/** Lightweight shell tokenization for bash validators; not an expanding shell parser. */
export function tokenizeShellLike(
  command: string,
  options: { executionSyntax?: boolean } = {}
): ShellToken[] {
  const tokens: ShellToken[] = []
  let token: ShellToken | undefined
  let inSingleQuote = false
  let inDoubleQuote = false

  const ensureToken = (index: number): ShellToken => {
    if (!token) {
      token = { text: '', start: index, end: index }
    }
    return token
  }

  const finishToken = (): void => {
    if (!token) return
    tokens.push(token)
    token = undefined
  }

  const pushOperator = (index: number, text: string): void => {
    tokens.push({ text, start: index, end: index + text.length, operator: true })
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false
        if (token) token.end = i + 1
        continue
      }
      const current = ensureToken(i)
      current.text += char
      current.end = i + 1
      continue
    }

    if (inDoubleQuote) {
      if (char === '\\') {
        const current = ensureToken(i)
        if (i + 1 < command.length) {
          current.text += command[i + 1]!
          current.end = i + 2
          i++
        } else {
          current.text += char
          current.end = i + 1
        }
        continue
      }
      if (char === '"') {
        inDoubleQuote = false
        if (token) token.end = i + 1
        continue
      }
      const current = ensureToken(i)
      current.text += char
      current.end = i + 1
      continue
    }

    if (options.executionSyntax && char === '#' && !token) {
      // Quotes/operators inside a shell comment are data; retain its newline.
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
      continue
    }

    if (char === "'" || char === '"') {
      const current = ensureToken(i)
      current.end = i + 1
      inSingleQuote = char === "'"
      inDoubleQuote = char === '"'
      continue
    }

    if (char === '\\') {
      const current = ensureToken(i)
      if (i + 1 < command.length) {
        current.text += command[i + 1]!
        current.end = i + 2
        i++
      } else {
        current.text += char
        current.end = i + 1
      }
      continue
    }

    if (char === ' ' || char === '\t' || char === '\r') {
      finishToken()
      continue
    }

    if (options.executionSyntax && (char === '<' || char === '>')) {
      // A contiguous numeric token is a file descriptor, not an argument.
      if (token && /^\d+$/.test(token.text) && token.end === i) token = undefined
      finishToken()
      const next = command[i + 1]
      const operator = next === char || next === '&' || next === '|' ? char + next : char
      pushOperator(i, operator)
      i += operator.length - 1
      continue
    }

    if (options.executionSyntax && (char === '(' || char === ')')) {
      finishToken()
      pushOperator(i, char)
      continue
    }

    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      finishToken()
      const nextChar = command[i + 1]
      if ((char === '|' || char === '&') && nextChar === char) {
        pushOperator(i, `${char}${nextChar}`)
        i++
      } else {
        pushOperator(i, char)
      }
      continue
    }

    const current = ensureToken(i)
    current.text += char
    current.end = i + 1
  }

  finishToken()
  return tokens
}
