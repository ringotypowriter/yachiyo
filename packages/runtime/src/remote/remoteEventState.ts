import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { z } from 'zod'

import { idSchema } from '@yachiyo/shared/remote/common'
import { remoteAppearanceSchema, remoteRunStatusSchema } from '@yachiyo/shared/remote/projections'

import type { RemoteEventHubPersistence, RemoteEventHubState } from './remoteEventHub.ts'

const seqSchema = z.int().min(0)

const stateSchema = z.object({
  epoch: z.string().min(1),
  seq: seqSchema,
  journalFloor: seqSchema,
  threads: z.array(
    z.tuple([
      idSchema,
      z.object({
        presence: z
          .discriminatedUnion('kind', [
            z.object({
              seq: seqSchema,
              kind: z.literal('summary'),
              deferred: z.literal(true).optional()
            }),
            z.object({
              seq: seqSchema,
              kind: z.literal('removed'),
              reason: z.enum(['archived', 'deleted'])
            })
          ])
          .optional(),
        run: z
          .object({
            seq: seqSchema,
            event: z.object({
              type: z.literal('run.status'),
              threadId: idSchema,
              runId: idSchema,
              status: remoteRunStatusSchema,
              error: z.string().optional()
            })
          })
          .optional()
      })
    ])
  ),
  appearance: z.object({ seq: seqSchema, appearance: remoteAppearanceSchema }).optional()
})

const fileSchema = z.object({
  version: z.literal(1),
  cleanShutdown: z.boolean(),
  state: stateSchema.optional()
})

type StateFile = z.infer<typeof fileSchema>

/**
 * `<home>/remote/event-state.json`: the hub's epoch, seq and inbox journal, valid only after a
 * clean shutdown. Opening marks the file in use, so after a crash (or a missing or corrupt
 * file) the hub starts a new epoch and phones resync, exactly as before persistence existed.
 */
export function createRemoteEventStateFile(
  path: string,
  log: (line: string) => void = () => undefined
): RemoteEventHubPersistence {
  const write = (file: StateFile): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(file), { mode: 0o600 })
    renameSync(temp, path)
  }

  return {
    open() {
      let restored: RemoteEventHubState | null = null
      try {
        const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
        if (parsed.success && parsed.data.cleanShutdown && parsed.data.state) {
          restored = parsed.data.state
        } else {
          log('[remote] event state is not from a clean shutdown; starting a new epoch')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`[remote] event state unreadable; starting a new epoch: ${String(error)}`)
        }
      }
      try {
        write({ version: 1, cleanShutdown: false })
      } catch (error) {
        // Without the in-use marker a crash could not be told apart from a clean exit.
        log(`[remote] could not mark event state in use; starting a new epoch: ${String(error)}`)
        return null
      }
      return restored
    },
    close(state) {
      write({ version: 1, cleanShutdown: true, state })
    }
  }
}
