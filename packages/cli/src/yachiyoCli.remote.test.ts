import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemoteCommandRequest } from '@yachiyo/shared/remote/command'

import { runYachiyoCli } from './yachiyoCli.ts'

async function run(args: string[]): Promise<{ requests: RemoteCommandRequest[]; output: string }> {
  const requests: RemoteCommandRequest[] = []
  let output = ''
  await runYachiyoCli(['remote', ...args], {
    stdout: {
      write(chunk) {
        output += String(chunk)
        return true
      }
    },
    requestRemote: async (_socketPath, request) => {
      requests.push(request)
      return { echoed: request.action }
    }
  })
  return { requests, output }
}

test('remote subcommands map to command socket requests and print the JSON result', async () => {
  assert.deepEqual((await run(['status'])).requests, [{ action: 'status' }])
  assert.deepEqual((await run(['tunnel', 'install'])).requests, [
    { action: 'tunnel-install', mode: 'quick' }
  ])
  assert.deepEqual(
    (
      await run([
        'tunnel',
        'install',
        '--mode',
        'named',
        '--tunnel',
        'yachiyo-mac',
        '--hostname',
        'mac.example.com'
      ])
    ).requests,
    [
      {
        action: 'tunnel-install',
        mode: 'named',
        tunnelName: 'yachiyo-mac',
        hostname: 'mac.example.com'
      }
    ]
  )
  assert.deepEqual((await run(['tunnel', 'uninstall'])).requests, [{ action: 'tunnel-uninstall' }])
  assert.deepEqual((await run(['pairings', 'list'])).requests, [{ action: 'pairings-list' }])
  const revoked = await run(['pairings', 'revoke', 'pairing-1'])
  assert.deepEqual(revoked.requests, [{ action: 'pairings-revoke', pairingId: 'pairing-1' }])
  assert.deepEqual(JSON.parse(revoked.output), { echoed: 'pairings-revoke' })
})

test('invalid remote commands fail before reaching the app', async () => {
  await assert.rejects(run(['tunnel', 'install', '--mode', 'named', '--tunnel', 'x']), /--hostname/)
  await assert.rejects(
    run(['tunnel', 'install', '--mode', 'named', '--tunnel', 'x', '--hostname', 'not a host']),
    /Invalid remote command arguments/
  )
  await assert.rejects(run(['pairings', 'revoke']), /pairingId/)
  await assert.rejects(run(['tunnel', 'restart']), /Unknown remote command/)
})
