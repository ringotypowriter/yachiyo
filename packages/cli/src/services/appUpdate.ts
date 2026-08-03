import { connect } from 'node:net'

import { formatAppUpdateBlockedError } from '@yachiyo/shared/appUpdate'
import type {
  AppUpdateApplyResult,
  AppUpdateCommandRequest,
  AppUpdateCommandResponse,
  AppUpdateInstallResult,
  AppUpdatePrepareResult,
  AppUpdateSnapshot,
  AppUpdateStatusResult
} from '@yachiyo/shared/appUpdate'

const STATUS_REQUEST_TIMEOUT_MS = 2 * 60 * 1_000
const APPLY_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000
const RESTART_TIMEOUT_MS = 5 * 60 * 1_000
const RESTART_POLL_INTERVAL_MS = 1_000

class YachiyoAppNotRunningError extends Error {}

export interface ApplyAppUpdateOptions {
  force?: boolean
  initiatorRunId?: string
  onBeforeInstall?: (
    prepared: Extract<AppUpdatePrepareResult, { state: 'restart-required' }>
  ) => void
  restartTimeoutMs?: number
  pollIntervalMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid app update response: ${key} is missing.`)
  }
  return value
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid app update response: ${key} is missing.`)
  }
  return value as number
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid app update response: ${key} is missing.`)
  }
  return value
}

function parseStatusResult(value: unknown): AppUpdateStatusResult {
  if (!isRecord(value)) {
    throw new Error('Invalid app update status response.')
  }
  const state = value.state
  const runningVersion = readString(value, 'runningVersion')
  if (state === 'up-to-date') {
    return { state, runningVersion }
  }
  if (state !== 'available' && state !== 'ready') {
    throw new Error('Invalid app update status response.')
  }
  return {
    state,
    runningVersion,
    targetVersion: readString(value, 'targetVersion')
  }
}

function parsePrepareResult(value: unknown): AppUpdatePrepareResult {
  if (!isRecord(value)) {
    throw new Error('Invalid app update apply response.')
  }
  const state = value.state
  const runningVersion = readString(value, 'runningVersion')
  if (state === 'up-to-date') {
    return { state, runningVersion }
  }
  if (state !== 'restart-required') {
    throw new Error('Invalid app update apply response.')
  }
  const interruptedRunCount = readNonNegativeInteger(value, 'interruptedRunCount')
  const blockingRunCount = readNonNegativeInteger(value, 'blockingRunCount')
  const initiatorRunActive = readBoolean(value, 'initiatorRunActive')
  if (blockingRunCount > interruptedRunCount) {
    throw new Error('Invalid app update apply response: blockingRunCount exceeds active runs.')
  }
  return {
    state,
    runningVersion,
    targetVersion: readString(value, 'targetVersion'),
    interruptedRunCount,
    blockingRunCount,
    initiatorRunActive
  }
}

function parseInstallResult(value: unknown): AppUpdateInstallResult {
  if (!isRecord(value) || value.state !== 'installing') {
    throw new Error('Invalid app update install response.')
  }
  return {
    state: 'installing',
    interruptedRunCount: readNonNegativeInteger(value, 'interruptedRunCount'),
    initiatorRunInterrupted: readBoolean(value, 'initiatorRunInterrupted')
  }
}

function parseSnapshot(value: unknown): AppUpdateSnapshot {
  if (!isRecord(value)) {
    throw new Error('Invalid app update snapshot response.')
  }
  return { runningVersion: readString(value, 'runningVersion') }
}

function requestAppUpdate(
  socketPath: string,
  request: Omit<AppUpdateCommandRequest, 'type'>,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let response = ''
    let settled = false
    const client = connect(socketPath, () => {
      client.end(JSON.stringify({ type: 'app-update', ...request }))
    })

    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true
      client.removeAllListeners()
      if (!client.destroyed) client.destroy()
      if (error) reject(error)
      else resolve(result)
    }

    client.setEncoding('utf8')
    client.setTimeout(timeoutMs)
    client.on('data', (chunk: string) => {
      response += chunk
    })
    client.on('end', () => {
      let parsed: AppUpdateCommandResponse
      try {
        parsed = JSON.parse(response) as AppUpdateCommandResponse
      } catch {
        finish(new Error('Yachiyo app returned an invalid update response.'))
        return
      }
      if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
        finish(new Error('Yachiyo app returned an invalid update response.'))
        return
      }
      if (!parsed.ok) {
        finish(new Error(typeof parsed.error === 'string' ? parsed.error : 'App update failed.'))
        return
      }
      finish(undefined, parsed.result)
    })
    client.on('timeout', () => {
      finish(new Error('Timed out waiting for the Yachiyo app update response.'))
    })
    client.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        finish(new YachiyoAppNotRunningError('Yachiyo app is not running. Start the app first.'))
      } else {
        finish(error)
      }
    })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function defaultGetAppUpdateStatus(
  socketPath: string
): Promise<AppUpdateStatusResult> {
  return parseStatusResult(
    await requestAppUpdate(socketPath, { action: 'status' }, STATUS_REQUEST_TIMEOUT_MS)
  )
}

export async function defaultApplyAppUpdate(
  socketPath: string,
  options: ApplyAppUpdateOptions = {}
): Promise<AppUpdateApplyResult> {
  const prepared = parsePrepareResult(
    await requestAppUpdate(
      socketPath,
      {
        action: 'prepare',
        ...(options.initiatorRunId ? { initiatorRunId: options.initiatorRunId } : {})
      },
      APPLY_REQUEST_TIMEOUT_MS
    )
  )
  if (prepared.state === 'up-to-date') {
    return prepared
  }
  if (prepared.blockingRunCount > 0 && options.force !== true) {
    throw new Error(formatAppUpdateBlockedError(prepared))
  }
  options.onBeforeInstall?.(prepared)

  const installing = parseInstallResult(
    await requestAppUpdate(
      socketPath,
      {
        action: 'install',
        force: options.force === true,
        ...(options.initiatorRunId ? { initiatorRunId: options.initiatorRunId } : {})
      },
      STATUS_REQUEST_TIMEOUT_MS
    )
  )

  if (options.initiatorRunId) {
    // A Yachiyo tool child is detached and survives the Electron utility
    // process exit, but its stdout pipe belongs to that exiting process. This
    // remains true even if the initiating run finishes before installation.
    // Return only the honest restart-started state; the post-restart channel
    // receipt is persisted and sent by the runtime layer.
    return {
      state: 'restart-started',
      previousVersion: prepared.runningVersion,
      targetVersion: prepared.targetVersion,
      interruptedRunCount: installing.interruptedRunCount,
      initiatorRunInterrupted: installing.initiatorRunInterrupted
    }
  }

  const restartTimeoutMs = options.restartTimeoutMs ?? RESTART_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? RESTART_POLL_INTERVAL_MS
  const deadline = Date.now() + restartTimeoutMs
  let lastRunningVersion = prepared.runningVersion

  while (Date.now() <= deadline) {
    try {
      const snapshot = parseSnapshot(
        await requestAppUpdate(socketPath, { action: 'snapshot' }, 5_000)
      )
      lastRunningVersion = snapshot.runningVersion
      if (snapshot.runningVersion === prepared.targetVersion) {
        return {
          state: 'updated',
          previousVersion: prepared.runningVersion,
          targetVersion: prepared.targetVersion,
          runningVersion: snapshot.runningVersion,
          interruptedRunCount: installing.interruptedRunCount,
          initiatorRunInterrupted: installing.initiatorRunInterrupted
        }
      }
    } catch (error) {
      if (!(error instanceof YachiyoAppNotRunningError)) {
        throw error
      }
    }
    await wait(pollIntervalMs)
  }

  throw new Error(
    `Yachiyo did not restart on target version ${prepared.targetVersion}. Last running version: ${lastRunningVersion}.`
  )
}
