import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { collectDescendants, killProcessTree, parsePsPairs } from './killProcessTree.ts'

describe('parsePsPairs', () => {
  it('parses pid/ppid columns and skips junk lines', () => {
    const stdout = [
      '    1     0',
      '  100     1',
      '  200   100',
      '',
      '  not a line',
      '  300   200  ignored-extra'
    ].join('\n')
    assert.deepEqual(parsePsPairs(stdout), [
      [1, 0],
      [100, 1],
      [200, 100],
      [300, 200]
    ])
  })
})

describe('collectDescendants', () => {
  it('walks the ppid tree transitively', () => {
    const pairs: Array<[number, number]> = [
      [100, 1],
      [101, 100],
      [102, 100],
      [103, 101],
      [200, 1], // unrelated subtree
      [201, 200]
    ]
    const out = collectDescendants(100, pairs)
    assert.deepEqual(
      out.sort((a, b) => a - b),
      [101, 102, 103]
    )
  })

  it('returns empty when the root has no children', () => {
    assert.deepEqual(collectDescendants(999, [[1, 0]]), [])
  })

  it('handles cycles defensively without looping forever', () => {
    // Not a real-world case, but guards against garbage input.
    const pairs: Array<[number, number]> = [
      [100, 200],
      [200, 100]
    ]
    const out = collectDescendants(100, pairs)
    assert.deepEqual(out, [200])
  })
})

describe('killProcessTree', () => {
  it('kills a grandchild that detached into its own process group', async () => {
    // Shell -> node -> detached sleep. The detached sleep is in a new pgid so
    // kill(-shell.pid) would NOT reach it; only the ppid-tree walk does.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });",
      'child.unref();',
      "process.stdout.write('grandchild:' + child.pid + '\\n');",
      '// Keep node parent alive so it remains a walkable descendant of the shell.',
      'setTimeout(() => {}, 60_000);'
    ].join('\n')

    const shell = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })

    try {
      let buffer = ''
      let stderrBuf = ''
      shell.stderr?.setEncoding('utf8')
      shell.stderr?.on('data', (chunk: string) => {
        stderrBuf += chunk
      })
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `grandchild pid never reported. stdout=${JSON.stringify(buffer)} stderr=${JSON.stringify(stderrBuf)}`
              )
            ),
          5000
        )
        shell.stdout?.setEncoding('utf8')
        shell.stdout?.on('data', (chunk: string) => {
          buffer += chunk
          const match = buffer.match(/grandchild:(\d+)/)
          if (match) {
            clearTimeout(timer)
            resolve(Number(match[1]))
          }
        })
        shell.once('error', reject)
      })
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

      // Grandchild should be alive before we kill.
      process.kill(grandchildPid, 0)

      assert.ok(shell.pid, 'shell pid missing')
      const result = killProcessTree(shell.pid)
      assert.ok(result.delivered, 'expected at least one signal to land')
      assert.ok(
        result.descendants.includes(grandchildPid),
        `expected descendants ${JSON.stringify(result.descendants)} to include grandchild ${grandchildPid}`
      )

      // Wait for everything to be reaped.
      await new Promise<void>((resolve) => {
        if (shell.exitCode !== null || shell.signalCode !== null) return resolve()
        shell.once('close', () => resolve())
      })

      // Give the kernel a moment to finish reaping the reparented grandchild.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          process.kill(grandchildPid, 0)
        } catch (err) {
          assert.equal((err as NodeJS.ErrnoException).code, 'ESRCH')
          return
        }
        await sleep(50)
      }
      assert.fail(`grandchild ${grandchildPid} still alive after killProcessTree`)
    } finally {
      if (shell.pid != null) {
        try {
          process.kill(-shell.pid, 'SIGKILL')
        } catch {
          // best-effort teardown — process may already be reaped
        }
      }
    }
  })
})
