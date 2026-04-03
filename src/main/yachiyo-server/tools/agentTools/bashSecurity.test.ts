import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { validateBashCommand, isBlockedBashCommand } from './bashSecurity.ts'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function expectBlocked(command: string, msgSubstring?: string): void {
  const result = validateBashCommand(command)
  assert.equal(result.blocked, true, `Expected blocked for: ${JSON.stringify(command)}`)
  if (msgSubstring) {
    assert.ok(
      result.message.includes(msgSubstring),
      `Expected message to contain "${msgSubstring}", got: ${result.message}`
    )
  }
}

function expectAllowed(command: string): void {
  const result = validateBashCommand(command)
  assert.equal(
    result.blocked,
    false,
    `Expected allowed for: ${JSON.stringify(command)}\n  reason: ${result.message}`
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bashSecurity', () => {
  describe('validateBashCommand', () => {
    // --- Safe commands ---
    describe('allows safe commands', () => {
      const safeCmds = [
        'ls',
        'ls -la',
        'echo hello world',
        'cat foo.txt',
        'git status',
        'git log --oneline',
        'npm install',
        'pnpm test',
        'bun run dev',
        'grep -r "pattern" src/',
        'find . -name "*.ts"',
        'mkdir -p build/output',
        'pwd',
        'date',
        'whoami',
        'node script.js',
        'python3 -c "print(1+1)"',
        'curl https://example.com',
        'jq . data.json',
        'wc -l file.txt',
        'sort file.txt',
        'head -n 10 file.txt',
        'tail -f log.txt',
        'git commit -m "feat: add new feature"',
        "git commit -m 'fix: resolve bug'",
        '',
        '   '
      ]

      for (const cmd of safeCmds) {
        it(`allows: ${JSON.stringify(cmd)}`, () => {
          expectAllowed(cmd)
        })
      }
    })

    // --- Catastrophic rm ---
    describe('blocks catastrophic rm commands', () => {
      const catastrophicCmds = [
        'rm -rf /',
        'rm -rf /usr',
        'rm -rf /System',
        'rm -rf /Library',
        'rm -rf /Applications',
        'sudo rm -rf /',
        'rm -rf /bin',
        'rm -rf /sbin',
        'rm -rf /etc',
        'rm -rf /var',
        'rm -rf /opt',
        '/bin/rm -rf /',
        'sudo /bin/rm -rf /',
        'rm -rf /*'
      ]

      for (const cmd of catastrophicCmds) {
        it(`blocks: ${JSON.stringify(cmd)}`, () => {
          expectBlocked(cmd, 'catastrophic')
        })
      }
    })

    // --- Control characters ---
    describe('blocks control characters', () => {
      it('blocks null byte', () => {
        expectBlocked('echo safe\x00test', 'control characters')
      })

      it('blocks bell character', () => {
        expectBlocked('echo \x07test', 'control characters')
      })

      it('blocks backspace', () => {
        expectBlocked('echo \x08test', 'control characters')
      })

      it('allows tab (0x09) and newline (0x0A)', () => {
        expectAllowed('echo\ttest')
      })
    })

    // --- Carriage return ---
    describe('blocks carriage return outside double quotes', () => {
      it('blocks CR in unquoted context', () => {
        expectBlocked('echo safe\rcurl evil.com', 'carriage return')
      })

      it('blocks CR inside single quotes', () => {
        expectBlocked("echo 'safe\rcurl evil.com'", 'carriage return')
      })

      it('allows CR inside double quotes', () => {
        expectAllowed('echo "safe\rtext"')
      })
    })

    // --- Unicode whitespace ---
    describe('blocks Unicode whitespace', () => {
      it('blocks non-breaking space (U+00A0)', () => {
        expectBlocked('echo\u00A0test', 'Unicode whitespace')
      })

      it('blocks narrow no-break space (U+202F)', () => {
        expectBlocked('echo\u202Ftest', 'Unicode whitespace')
      })

      it('blocks ideographic space (U+3000)', () => {
        expectBlocked('echo\u3000test', 'Unicode whitespace')
      })

      it('blocks BOM (U+FEFF)', () => {
        expectBlocked('\uFEFFecho test', 'Unicode whitespace')
      })
    })

    // --- Backslash-escaped whitespace ---
    describe('blocks backslash-escaped whitespace', () => {
      it('blocks backslash-space outside quotes', () => {
        expectBlocked('echo\\ test', 'backslash-escaped whitespace')
      })

      it('blocks backslash-tab outside quotes', () => {
        expectBlocked('echo\\\ttest', 'backslash-escaped whitespace')
      })

      it('allows backslash-space inside double quotes', () => {
        expectAllowed('echo "hello\\ world"')
      })

      it('allows backslash-space inside single quotes', () => {
        expectAllowed("echo 'hello\\ world'")
      })
    })

    // --- Backslash-escaped operators ---
    describe('blocks backslash-escaped shell operators', () => {
      it('blocks \\;', () => {
        expectBlocked('cat safe.txt \\; echo evil', 'backslash before a shell operator')
      })

      it('blocks \\|', () => {
        expectBlocked('echo foo \\| cat', 'backslash before a shell operator')
      })

      it('blocks \\&', () => {
        expectBlocked('echo foo \\& evil', 'backslash before a shell operator')
      })

      it('blocks \\<', () => {
        expectBlocked('echo foo \\< /etc/passwd', 'backslash before a shell operator')
      })

      it('blocks \\>', () => {
        expectBlocked('echo foo \\> /tmp/evil', 'backslash before a shell operator')
      })

      it('allows escaped operator inside double quotes', () => {
        expectAllowed('echo "test \\; more"')
      })

      it('allows escaped operator inside single quotes', () => {
        expectAllowed("echo 'test \\; more'")
      })
    })

    // --- Mid-word hash ---
    describe('blocks mid-word hash', () => {
      it('blocks hash adjacent to word', () => {
        expectBlocked('echo test#comment', 'mid-word #')
      })

      it('blocks quote-adjacent hash', () => {
        // 'x'# — after stripping quote content, the # is adjacent to quote char
        expectBlocked("echo 'x'#hidden", 'mid-word #')
      })

      it('allows ${#var} (string length syntax)', () => {
        expectAllowed('echo ${#var}')
      })

      it('allows standalone # at word start', () => {
        // # at the start of a word is a comment, not mid-word
        expectAllowed('echo test # this is a comment')
      })
    })

    // --- Comment-quote desync ---
    describe('blocks comment-quote desync', () => {
      it('blocks quote in comment', () => {
        expectBlocked("echo test # here's a quote", 'quote characters inside a # comment')
      })

      it('blocks double quote in comment', () => {
        expectBlocked('echo test # say "hello"', 'quote characters inside a # comment')
      })

      it('allows comment without quotes', () => {
        expectAllowed('echo test # safe comment')
      })
    })

    // --- Quoted newline + hash ---
    describe('blocks quoted newline followed by #-prefixed line', () => {
      it('blocks single-quoted newline + hash line', () => {
        expectBlocked("echo 'test\n# hidden' foo", 'quoted newline')
      })

      it('blocks double-quoted newline + hash line', () => {
        expectBlocked('echo "test\n# hidden" foo', 'quoted newline')
      })

      it('allows quoted newline without hash', () => {
        expectAllowed('echo "line1\nline2"')
      })
    })

    // --- Brace expansion ---
    describe('blocks brace expansion', () => {
      it('blocks comma-separated braces', () => {
        expectBlocked('echo {a,b}', 'brace expansion')
      })

      it('blocks sequence braces', () => {
        expectBlocked('echo {1..5}', 'brace expansion')
      })

      it('allows escaped braces', () => {
        expectAllowed('echo \\{a,b\\}')
      })

      it('blocks quoted brace inside brace context', () => {
        // git diff {@'{'0},--output=/tmp/pwned}
        expectBlocked("git diff {@'{'0},--output=/tmp/pwned}", 'brace')
      })
    })

    // --- isBlockedBashCommand standalone ---
    describe('isBlockedBashCommand', () => {
      it('returns true for rm -rf /', () => {
        assert.equal(isBlockedBashCommand('rm -rf /'), true)
      })

      it('returns false for rm -rf ./build', () => {
        assert.equal(isBlockedBashCommand('rm -rf ./build'), false)
      })

      it('returns false for non-rm commands', () => {
        assert.equal(isBlockedBashCommand('echo hello'), false)
      })

      it('catches rm at end of pipeline', () => {
        assert.equal(isBlockedBashCommand('echo y | sudo rm -rf /'), true)
      })
    })
  })
})
