import { resolveYachiyoSocketPath } from '@yachiyo/runtime/config/paths'
import {
  remoteCommandRequestSchema,
  type RemoteCommandRequest
} from '@yachiyo/shared/remote/command'

import { namespaceHelp } from '../core/help.ts'
import type { RunYachiyoCliOptions } from '../core/types.ts'
import { defaultRequestRemote } from '../services/remote.ts'

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing ${name}.\n\n${namespaceHelp('remote')}`)
  return value
}

function parseRequest(positionals: string[], flags: Map<string, string>): RemoteCommandRequest {
  const [group, action, argument] = positionals
  let candidate: unknown
  if (group === 'status') {
    candidate = { action: 'status' }
  } else if (group === 'tunnel' && action === 'install') {
    const mode = flags.get('--mode') ?? 'quick'
    candidate =
      mode === 'named'
        ? {
            action: 'tunnel-install',
            mode,
            tunnelName: required(flags.get('--tunnel'), '--tunnel <name>'),
            hostname: required(flags.get('--hostname'), '--hostname <host>')
          }
        : { action: 'tunnel-install', mode }
  } else if (group === 'tunnel' && action === 'uninstall') {
    candidate = { action: 'tunnel-uninstall' }
  } else if (group === 'pairings' && action === 'list') {
    candidate = { action: 'pairings-list' }
  } else if (group === 'pairings' && action === 'revoke') {
    candidate = { action: 'pairings-revoke', pairingId: required(argument, '<pairingId>') }
  } else {
    throw new Error(`Unknown remote command.\n\n${namespaceHelp('remote')}`)
  }
  const parsed = remoteCommandRequestSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Error(`Invalid remote command arguments.\n\n${namespaceHelp('remote')}`)
  }
  return parsed.data
}

export async function handleRemoteCommand(
  positionals: string[],
  flags: Map<string, string>,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('remote')}\n`)
    return
  }
  const request = parseRequest(positionals, flags)
  const send = options.requestRemote ?? defaultRequestRemote
  const result = await send(resolveYachiyoSocketPath(), request)
  stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
