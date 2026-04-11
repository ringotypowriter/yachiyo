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

    // --- Huge search root (scope block) ---
    describe('blocks huge-root recursive scans', () => {
      const blockedScans = [
        // Path-only (find/tree/du): every positional is a path.
        'find /',
        'find / -name foo',
        'find ~',
        'find ~/ -type f',
        'find $HOME -name foo',
        'find ${HOME}',
        'tree /',
        'tree ~',
        'du /',
        'du -sh ~',
        // Pattern-first (rg/fd/ag/ack): path is positional #2+.
        'fd pattern /',
        'fd pattern ~',
        'fd --extension ts pattern /',
        'rg needle /',
        'rg needle ~',
        'rg --glob *.ts needle /',
        'ag pattern /',
        'ack needle /',
        // Pattern provided via flag → every positional is a path.
        'rg -e foo / src',
        'rg --regexp=foo / src',
        'rg -f patterns.txt /',
        'grep -r -e foo / src',
        // Conditional recursers: only block with a recursive flag.
        'grep -r needle /',
        'grep -R needle ~',
        'grep -rn needle /',
        'grep --recursive needle /',
        'grep -r --include *.ts needle /',
        'ls -R /',
        'ls -R ~',
        'ls -lR ~',
        'ls --recursive ~',
        // Pipeline segment: huge scan buried in a later segment still trips.
        'echo done && find / -name foo',
        'echo start; rg pattern ~',
        // $HOME / ${HOME} trailing-slash forms.
        'find $HOME/ -name foo',
        'find ${HOME}/ -name foo',
        'rg needle $HOME/',
        'rg needle ${HOME}/',
        'fd pattern $HOME/',
        'grep -r needle ${HOME}/',
        'tree $HOME/',
        'du -sh ${HOME}/',
        // Wrapper forms: sudo/doas/env/exec and path-prefixed binaries.
        'sudo find / -name foo',
        'sudo rg needle /',
        'sudo -H find / -name foo',
        'sudo -u root find / -name foo',
        'sudo -- find / -name foo',
        'doas find / -name foo',
        'env find / -name foo',
        'env LC_ALL=C find / -name foo',
        'env -u LANG find / -name foo',
        'exec find / -name foo',
        'LC_ALL=C find / -name foo',
        'LC_ALL=C rg needle /',
        'LC_ALL=C FOO=bar find / -name foo',
        'LC_ALL=C sudo find / -name foo',
        '/usr/bin/find / -name foo',
        '/opt/homebrew/bin/rg needle ~',
        './my/bin/find / -name foo'
      ]

      for (const cmd of blockedScans) {
        it(`blocks: ${JSON.stringify(cmd)}`, () => {
          expectBlocked(cmd, 'scan range is too large')
        })
      }
    })

    describe('allows narrow scans and non-recursive variants', () => {
      const allowedScans = [
        // Narrow path-only scans.
        'find . -name foo',
        'find src -name foo',
        'find ~/projects -type f',
        'find /etc/nginx -name "*.conf"',
        'find src -name / -type f', // `-name /` is a filter value, not a path
        'tree src',
        'du -sh src',
        'ls /',
        'ls ~',
        'ls -la /etc',
        'ls -R src',
        // Reviewer P2: `ls -r` is sort-reverse, NOT recursive (only `-R` is).
        'ls -r ~',
        'ls -r /',
        'ls -lr ~',
        'ls -latr ~',
        // Pattern-first: `/` and `~` as the FIRST positional are patterns,
        // not paths.
        'rg / src',
        'rg / .',
        'rg /',
        'rg ~ src',
        'rg ~',
        'fd / src',
        'fd / .',
        'fd /',
        'ag / src',
        'ag ~ src',
        'ack / src',
        // Reviewer P1: value-taking flags must not eat the following positional.
        "rg --glob '*.ts' / src",
        'rg --glob *.ts / src',
        'rg --glob=*.ts / src',
        'rg -g *.ts / src',
        'rg -t rust / src',
        'rg --type rust / src',
        'rg -C 3 / src',
        'rg --max-count 5 / src',
        'fd --extension ts / src',
        'fd --extension ts / .',
        'fd -e ts / src',
        'fd -d 3 / src',
        "grep -r --include '*.ts' / src",
        'grep -r --include *.ts / src',
        'grep -r --include=*.ts / src',
        'grep -r -C 2 / src',
        // Pattern-first with explicit narrow path.
        'rg needle src/',
        'rg needle',
        'fd . src/',
        // Conditional recursers with pattern = `/` or narrow path.
        'grep -r / src',
        'grep -r needle src/',
        'grep needle /etc/hosts',
        // Narrow subpaths under $HOME / ~ — the trailing-slash regex must
        // not over-match.
        'find $HOME/Downloads -name foo',
        'find ${HOME}/projects -type f',
        'rg needle $HOME/projects',
        'grep -r needle ${HOME}/src',
        'fd pattern ~/projects',
        // Narrow scans with wrappers — wrapper stripping must not turn a
        // narrow scan into a false-positive.
        'sudo find src -name foo',
        'sudo rg needle src/',
        'LC_ALL=C rg needle src/',
        'LC_ALL=C find . -name foo',
        'env LC_ALL=C find src -name foo',
        '/usr/bin/find src -name foo',
        // Misc safe.
        'cat /etc/hosts',
        'echo ~',
        'echo /'
      ]

      for (const cmd of allowedScans) {
        it(`allows: ${JSON.stringify(cmd)}`, () => {
          expectAllowed(cmd)
        })
      }
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
