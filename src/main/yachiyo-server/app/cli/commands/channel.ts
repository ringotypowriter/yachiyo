import { resolveYachiyoSocketPath } from '../../../config/paths.ts'
import { namespaceHelp } from '../core/help.ts'
import { outputJson } from '../core/output.ts'
import { parseChannelGroupStatus } from '../core/parsers.ts'
import { defaultSendChannelGroupLabel, defaultSendChannelGroupStatus } from '../services/socket.ts'
import type { RunYachiyoCliOptions } from '../core/types.ts'

export async function handleChannelCommand(
  positionals: string[],
  flags: Map<string, string>,
  dbPath: string,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('channel')}\n`)
    return
  }

  const action = positionals[0]
  const useJson = flags.get('--json') === 'true'

  const storage =
    options.createStorage ??
    (async () => {
      const { createSqliteYachiyoStorage } = await import('../../../storage/sqlite/database.ts')
      return createSqliteYachiyoStorage(dbPath)
    })
  const channelStorage = typeof storage === 'function' ? await storage(dbPath) : storage

  try {
    if (action === 'users') {
      const subcommand = positionals[1]

      if (subcommand === 'set-label') {
        const id = positionals[2]
        const label = positionals.slice(3).join(' ')
        if (!id?.trim()) {
          throw new Error('User ID is required: channel users set-label <id> <label>')
        }

        const updated = channelStorage.updateChannelUser({ id, label })
        if (!updated) {
          throw new Error(`Unknown channel user: ${id}`)
        }
        outputJson(stdout, updated)
        return
      }

      if (subcommand !== undefined) {
        throw new Error(
          `Unknown channel users action: ${subcommand}. Expected: set-label or no subcommand`
        )
      }

      const users = channelStorage.listChannelUsers()
      if (useJson) {
        outputJson(stdout, users)
      } else {
        for (const u of users) {
          const labelPart = u.label ? ` "${u.label}"` : ''
          stdout.write(`[${u.status}] ${u.platform}:${u.username}${labelPart} id=${u.id}\n`)
        }
        if (users.length === 0) stdout.write('No channel users.\n')
      }
      return
    }

    if (action === 'groups') {
      const subcommand = positionals[1]

      if (subcommand === 'set-status') {
        const id = positionals[2]
        const rawStatus = positionals[3]
        let liveAppNotified = true
        if (!id?.trim()) {
          throw new Error('Group ID is required: channel groups set-status <id> <status>')
        }
        if (!rawStatus?.trim()) {
          throw new Error('Status is required: channel groups set-status <id> <status>')
        }

        const status = parseChannelGroupStatus(rawStatus)
        const socketPath = resolveYachiyoSocketPath()
        const sendStatus = options.sendChannelGroupStatus ?? defaultSendChannelGroupStatus

        try {
          await sendStatus(socketPath, { type: 'update-channel-group-status', id, status })
        } catch (error) {
          const code =
            error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : ''
          const message = error instanceof Error ? error.message : String(error)
          const canFallback =
            code === 'ENOENT' ||
            code === 'ECONNREFUSED' ||
            code === 'EPERM' ||
            message.includes('not running')
          if (!canFallback) {
            throw error
          }
          liveAppNotified = false
        }

        const updated = channelStorage.updateChannelGroup({ id, status })
        if (!updated) {
          throw new Error(`Unknown channel group: ${id}`)
        }

        if (!liveAppNotified) {
          options.stderr?.write(
            'Updated the stored group status, but the running app was not notified. Restart Yachiyo to apply it immediately.\n'
          )
        }

        outputJson(stdout, updated)
        return
      }

      if (subcommand === 'set-label') {
        const id = positionals[2]
        const label = positionals.slice(3).join(' ')
        let liveAppNotified = true
        if (!id?.trim()) {
          throw new Error('Group ID is required: channel groups set-label <id> <label>')
        }

        const socketPath = resolveYachiyoSocketPath()
        const sendLabel = options.sendChannelGroupLabel ?? defaultSendChannelGroupLabel

        try {
          await sendLabel(socketPath, { type: 'update-channel-group-label', id, label })
        } catch (error) {
          const code =
            error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : ''
          const message = error instanceof Error ? error.message : String(error)
          const canFallback =
            code === 'ENOENT' ||
            code === 'ECONNREFUSED' ||
            code === 'EPERM' ||
            message.includes('not running')
          if (!canFallback) {
            throw error
          }
          liveAppNotified = false
        }

        const updated = channelStorage.updateChannelGroup({ id, label })
        if (!updated) {
          throw new Error(`Unknown channel group: ${id}`)
        }

        if (!liveAppNotified) {
          options.stderr?.write(
            'Updated the stored group label, but the running app was not notified. Restart Yachiyo to apply it immediately.\n'
          )
        }

        outputJson(stdout, updated)
        return
      }

      if (subcommand !== undefined) {
        throw new Error(
          `Unknown channel groups action: ${subcommand}. Expected: set-status, set-label, or no subcommand`
        )
      }

      const groups = channelStorage.listChannelGroups()
      if (useJson) {
        outputJson(stdout, groups)
      } else {
        for (const g of groups) {
          const labelPart = g.label ? ` "${g.label}"` : ''
          stdout.write(`[${g.status}] ${g.platform}:${g.name}${labelPart} id=${g.id}\n`)
        }
        if (groups.length === 0) stdout.write('No channel groups.\n')
      }
      return
    }

    throw new Error(`Unknown channel action: ${action ?? '(none)'}. Expected: users, groups`)
  } finally {
    channelStorage.close()
  }
}
