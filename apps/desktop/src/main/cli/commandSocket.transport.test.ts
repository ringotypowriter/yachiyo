import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import type { CommandEndpoint } from '@yachiyo/runtime/config/commandEndpoint'
import {
  cleanupCommandEndpoint,
  createCommandSocketRestartPolicy,
  prepareCommandEndpoint,
  probeCommandEndpoint
} from './commandSocket.ts'

function createFilesystemRecorder(): {
  calls: string[]
  fileSystem: {
    existsSync: (path: string) => boolean
    mkdirSync: (path: string, options: { recursive: boolean }) => void
    unlinkSync: (path: string) => void
  }
} {
  const calls: string[] = []
  return {
    calls,
    fileSystem: {
      existsSync: (path) => {
        calls.push(`exists:${path}`)
        return true
      },
      mkdirSync: (path) => {
        calls.push(`mkdir:${path}`)
      },
      unlinkSync: (path) => {
        calls.push(`unlink:${path}`)
      }
    }
  }
}

test('Unix command endpoint performs stale socket preparation and close cleanup', () => {
  const endpoint: CommandEndpoint = {
    kind: 'unix-socket',
    address: '/Users/yuki/.yachiyo/yachiyo.sock'
  }
  const { calls, fileSystem } = createFilesystemRecorder()

  prepareCommandEndpoint(endpoint, fileSystem)
  cleanupCommandEndpoint(endpoint, fileSystem)

  assert.deepEqual(calls, [
    'mkdir:/Users/yuki/.yachiyo',
    'exists:/Users/yuki/.yachiyo/yachiyo.sock',
    'unlink:/Users/yuki/.yachiyo/yachiyo.sock',
    'exists:/Users/yuki/.yachiyo/yachiyo.sock',
    'unlink:/Users/yuki/.yachiyo/yachiyo.sock'
  ])
})

test('Windows named pipe never invokes filesystem preparation or unlink', () => {
  const endpoint: CommandEndpoint = {
    kind: 'windows-pipe',
    address: '\\\\.\\pipe\\yachiyo-0123456789abcdef'
  }
  const { calls, fileSystem } = createFilesystemRecorder()

  prepareCommandEndpoint(endpoint, fileSystem)
  cleanupCommandEndpoint(endpoint, fileSystem)

  assert.deepEqual(calls, [])
})

test('named-pipe health probe connects to the endpoint address and closes cleanly', async () => {
  const endpoint: CommandEndpoint = {
    kind: 'windows-pipe',
    address: '\\\\.\\pipe\\yachiyo-0123456789abcdef'
  }
  const addresses: string[] = []
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    endCalls: 0,
    destroyCalls: 0,
    end() {
      this.endCalls++
      emitter.emit('close')
    },
    destroy() {
      this.destroyCalls++
      emitter.emit('close')
    }
  })

  const healthy = await probeCommandEndpoint(endpoint, {
    timeoutMs: 50,
    connect: (address, onConnect) => {
      addresses.push(address)
      queueMicrotask(onConnect)
      return socket
    }
  })

  assert.equal(healthy, true)
  assert.deepEqual(addresses, [endpoint.address])
  assert.equal(socket.endCalls, 1)
  assert.equal(socket.destroyCalls, 0)
})

test('command endpoint restart policy delays retries, stops at its bound, and resets after recovery', () => {
  const policy = createCommandSocketRestartPolicy({
    initialDelayMs: 250,
    maxAttempts: 3
  })

  assert.equal(policy.nextDelay(), 250)
  assert.equal(policy.nextDelay(), 500)
  assert.equal(policy.nextDelay(), 1_000)
  assert.equal(policy.nextDelay(), null)
  assert.equal(policy.nextDelay(), null)

  policy.reset()
  assert.equal(policy.nextDelay(), 250)
})
