import { connect } from 'node:net'

import type {
  AppUpdateAction,
  AppUpdateApplyResult,
  AppUpdateCommandResponse,
  AppUpdatePrepareResult,
  AppUpdateSnapshot,
  AppUpdateStatusResult
} from '@yachiyo/shared/appUpdate'

const STATUS_REQUEST_TIMEOUT_MS = 2 * 60 * 1_000
const APPLY_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000
const RESTART_TIMEOUT_MS = 5 * 60 * 1_000
const RESTART_POLL_INTERVAL_MS = 1_000

class YachiyoAppNotRunningError extends Error {}

interface ApplyAppUpdateOptions {
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
  const interruptedRunCount = value.interruptedRunCount
  if (!Number.isInteger(interruptedRunCount) || (interruptedRunCount as number) < 0) {
    throw new Error('Invalid app update apply response: interruptedRunCount is missing.')
  }
  return {
    state,
    runningVersion,
    targetVersion: readString(value, 'targetVersion'),
    interruptedRunCount: interruptedRunCount as number
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
  action: AppUpdateAction,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let response = ''
    let settled = false
    const client = connect(socketPath, () => {
      client.end(JSON.stringify({ type: 'app-update', action }))
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
  return parseStatusResult(await requestAppUpdate(socketPath, 'status', STATUS_REQUEST_TIMEOUT_MS))
}

export async function defaultApplyAppUpdate(
  socketPath: string,
  options: ApplyAppUpdateOptions = {}
): Promise<AppUpdateApplyResult> {
  const prepared = parsePrepareResult(
    await requestAppUpdate(socketPath, 'apply', APPLY_REQUEST_TIMEOUT_MS)
  )
  if (prepared.state === 'up-to-date') {
    return prepared
  }

  const restartTimeoutMs = options.restartTimeoutMs ?? RESTART_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? RESTART_POLL_INTERVAL_MS
  const deadline = Date.now() + restartTimeoutMs
  let lastRunningVersion = prepared.runningVersion

  while (Date.now() <= deadline) {
    try {
      const snapshot = parseSnapshot(await requestAppUpdate(socketPath, 'snapshot', 5_000))
      lastRunningVersion = snapshot.runningVersion
      if (snapshot.runningVersion === prepared.targetVersion) {
        return {
          state: 'updated',
          previousVersion: prepared.runningVersion,
          targetVersion: prepared.targetVersion,
          runningVersion: snapshot.runningVersion,
          interruptedRunCount: prepared.interruptedRunCount
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
