import type { YachiyoServerEvent } from '../../../../shared/yachiyo/protocol.ts'

export const DEFAULT_THREAD_TITLE = 'New Chat'
export const DEFAULT_HARNESS_NAME = 'default.reply'
export const INTERRUPTED_RUN_ERROR = 'Run interrupted before completion.'
export const SHUTDOWN_RUN_ERROR = 'Application shut down before the run completed.'

export type CreateId = () => string
export type Timestamp = () => string

export type EmitServerEvent = <TEvent extends YachiyoServerEvent>(
  event: Omit<TEvent, 'eventId' | 'timestamp'>
) => void
