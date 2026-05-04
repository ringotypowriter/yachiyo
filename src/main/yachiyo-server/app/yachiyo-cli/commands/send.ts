import { resolveYachiyoSocketPath } from '../../../config/paths.ts'
import { namespaceHelp } from '../core/help.ts'
import { defaultSendChannel, defaultSendNotification } from '../services/socket.ts'
import type { RunYachiyoCliOptions } from '../core/types.ts'

export async function handleSendCommand(
  positionals: string[],
  flags: Map<string, string>,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('send')}\n`)
    return
  }

  const subcommand = positionals[0]

  if (subcommand === 'notification') {
    const body = positionals[1]
    if (!body?.trim()) {
      throw new Error('Message is required: send notification <message> [--title <title>]')
    }
    const title = flags.get('--title') ?? 'Yachiyo'
    const socketPath = resolveYachiyoSocketPath()
    const send = options.sendNotification ?? defaultSendNotification
    await send(socketPath, { title, body })
    stdout.write(`Notification sent.\n`)
    return
  }

  if (subcommand === 'channel') {
    const id = positionals[1]
    const message = positionals[2]
    if (!id?.trim()) {
      throw new Error('Channel user or group ID is required: send channel <id> <message>')
    }
    if (!message?.trim()) {
      throw new Error('Message is required: send channel <id> <message>')
    }
    const socketPath = resolveYachiyoSocketPath()
    const send = options.sendChannel ?? defaultSendChannel
    await send(socketPath, { type: 'send-channel', id, message })
    stdout.write(`Message sent.\n`)
    return
  }

  throw new Error(
    `Unknown send subcommand: ${subcommand ?? '(none)'}. Expected: notification, channel`
  )
}
