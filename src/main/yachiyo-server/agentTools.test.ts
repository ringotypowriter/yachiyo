import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  isBlockedBashCommand,
  runBashTool,
  runEditTool,
  runReadTool,
  runWriteTool,
  summarizeToolOutput
} from './agentTools.ts'

async function withWorkspace(fn: (workspacePath: string) => Promise<void> | void): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-agent-tools-'))

  try {
    await fn(workspacePath)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

test('runReadTool returns a bounded excerpt from the workspace', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive', 'utf8')

    const result = await runReadTool(
      {
        path: 'notes.txt',
        startLine: 2,
        lineCount: 2
      },
      { workspacePath }
    )

    assert.equal(result.ok, true)
    assert.equal(result.path, join(workspacePath, 'notes.txt'))
    assert.equal(result.content, 'two\nthree')
    assert.equal(result.startLine, 2)
    assert.equal(result.endLine, 3)
    assert.equal(result.truncated, true)
  })
})

test('runWriteTool refuses to overwrite an existing file unless explicitly requested', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'draft.txt'), 'first', 'utf8')

    const blocked = await runWriteTool(
      {
        path: 'draft.txt',
        content: 'second'
      },
      { workspacePath }
    )

    const replaced = await runWriteTool(
      {
        path: 'draft.txt',
        content: 'second',
        overwrite: true
      },
      { workspacePath }
    )

    assert.equal(blocked.ok, false)
    assert.match(blocked.error ?? '', /overwrite=true/)
    assert.equal(replaced.ok, true)
    assert.equal(await readFile(join(workspacePath, 'draft.txt'), 'utf8'), 'second')
  })
})

test('runEditTool uses targeted search and replace without rewriting the file by hand', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'draft.txt'), 'alpha beta alpha', 'utf8')

    const ambiguous = await runEditTool(
      {
        path: 'draft.txt',
        oldText: 'alpha',
        newText: 'omega'
      },
      { workspacePath }
    )
    const replaced = await runEditTool(
      {
        path: 'draft.txt',
        oldText: 'alpha',
        newText: 'omega',
        replaceAll: true
      },
      { workspacePath }
    )

    assert.equal(ambiguous.ok, false)
    assert.match(ambiguous.error ?? '', /replaceAll=true/)
    assert.equal(replaced.ok, true)
    assert.equal(replaced.replacements, 2)
    assert.equal(await readFile(join(workspacePath, 'draft.txt'), 'utf8'), 'omega beta omega')
  })
})

test('isBlockedBashCommand catches catastrophic rm variants without overblocking safe commands', () => {
  for (const command of [
    'rm /',
    'rm -rf /',
    'sudo rm -rf /',
    '/bin/rm -rf /',
    'rm -rf /System',
    'echo ok && rm -rf /usr'
  ]) {
    assert.equal(isBlockedBashCommand(command), true, command)
  }

  for (const command of [
    'pwd',
    'rm -rf ./tmp',
    'rm -rf ../build',
    'printf "rm -rf /"',
    'echo rm -rf /'
  ]) {
    assert.equal(isBlockedBashCommand(command), false, command)
  }
})

test('runBashTool blocks obviously catastrophic destructive commands before invoking any runner', async () => {
  await withWorkspace(async (workspacePath) => {
    let called = false
    const result = await runBashTool(
      {
        command: 'rm -rf /'
      },
      { workspacePath },
      {
        runCommand: async () => {
          called = true
          return {
            exitCode: 0,
            stdout: 'should not run',
            stderr: ''
          }
        }
      }
    )

    assert.equal(result.ok, false)
    assert.equal(result.blocked, true)
    assert.equal(result.cwd, workspacePath)
    assert.equal(called, false)
    assert.equal(
      summarizeToolOutput('bash', result),
      'Blocked an obviously catastrophic destructive command.'
    )
  })
})

test('runBashTool uses the injected runner for safe commands', async () => {
  await withWorkspace(async (workspacePath) => {
    let runnerInput:
      | {
          command: string
          cwd: string
          timeoutMs: number
        }
      | undefined

    const result = await runBashTool(
      {
        command: 'pwd',
        timeoutMs: 4567
      },
      { workspacePath },
      {
        runCommand: async (input) => {
          runnerInput = {
            command: input.command,
            cwd: input.cwd,
            timeoutMs: input.timeoutMs
          }

          return {
            exitCode: 0,
            stdout: `${input.cwd}\n`,
            stderr: ''
          }
        }
      }
    )

    assert.deepEqual(runnerInput, {
      command: 'pwd',
      cwd: workspacePath,
      timeoutMs: 4567
    })
    assert.equal(result.ok, true)
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, `${workspacePath}\n`)
    assert.equal(result.stderr, '')
  })
})

test('runBashTool maps injected runner failures into a failed tool result', async () => {
  await withWorkspace(async (workspacePath) => {
    const error = Object.assign(new Error('Command failed'), {
      code: 7,
      stdout: 'partial stdout',
      stderr: 'bad things happened',
      killed: false
    })

    const result = await runBashTool(
      {
        command: 'false'
      },
      { workspacePath },
      {
        runCommand: async () => {
          throw error
        }
      }
    )

    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 7)
    assert.equal(result.stdout, 'partial stdout')
    assert.equal(result.stderr, 'bad things happened')
    assert.equal(result.error, 'Command failed')
  })
})
