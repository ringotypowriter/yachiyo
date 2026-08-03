import { resolveYachiyoSocketPath } from '@yachiyo/runtime/config/paths'
import type { AppUpdateApplyResult, AppUpdateStatusResult } from '@yachiyo/shared/appUpdate'

import { namespaceHelp } from '../core/help.ts'
import type { RunYachiyoCliOptions } from '../core/types.ts'
import { defaultApplyAppUpdate, defaultGetAppUpdateStatus } from '../services/appUpdate.ts'

function writeJson(stdout: Pick<typeof process.stdout, 'write'>, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function formatInterruptedRuns(count: number, includesInitiator: boolean): string {
  const noun = count === 1 ? 'run' : 'runs'
  const initiator = includesInitiator ? ' (including the initiating run)' : ''
  return `${count} active Yachiyo ${noun}${initiator}`
}

function writeStatus(
  stdout: Pick<typeof process.stdout, 'write'>,
  status: AppUpdateStatusResult
): void {
  if (status.state === 'up-to-date') {
    stdout.write(`Yachiyo ${status.runningVersion} is up to date.\n`)
    return
  }
  if (status.state === 'ready') {
    stdout.write(
      `Update ${status.targetVersion} is downloaded and ready to restart. Running version: ${status.runningVersion}.\n`
    )
    return
  }
  stdout.write(
    `Update ${status.targetVersion} is available. Running version: ${status.runningVersion}.\n`
  )
}

function writeApplyResult(
  stdout: Pick<typeof process.stdout, 'write'>,
  result: AppUpdateApplyResult
): void {
  if (result.state === 'up-to-date') {
    stdout.write(`Yachiyo ${result.runningVersion} is up to date.\n`)
    return
  }
  if (result.state === 'restart-started') {
    stdout.write(
      `Installation triggered for Yachiyo ${result.targetVersion}; the restarted version is not yet verified by this run. The restart will interrupt ${formatInterruptedRuns(result.interruptedRunCount, result.initiatorRunInterrupted)}.\n`
    )
    return
  }
  stdout.write(
    `Updated Yachiyo from ${result.previousVersion} to ${result.targetVersion}. Running process: ${result.runningVersion}.\n`
  )
  stdout.write(
    `Interrupted ${formatInterruptedRuns(result.interruptedRunCount, result.initiatorRunInterrupted)}.\n`
  )
}

export async function handleUpdateCommand(
  positionals: string[],
  flags: Map<string, string>,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('update')}\n`)
    return
  }

  const action = positionals[0]
  const socketPath = resolveYachiyoSocketPath()
  const json = flags.has('--json')

  if (action === 'status') {
    const getStatus = options.getAppUpdateStatus ?? defaultGetAppUpdateStatus
    const status = await getStatus(socketPath)
    if (json) writeJson(stdout, status)
    else writeStatus(stdout, status)
    return
  }

  if (action === 'apply') {
    if (!json) {
      stdout.write('Yachiyo will restart to install the update; active work may be interrupted.\n')
    }
    const applyUpdate = options.applyAppUpdate ?? defaultApplyAppUpdate
    const env = options.env ?? process.env
    const result = await applyUpdate(socketPath, {
      force: flags.has('--force'),
      ...(env.YACHIYO_RUN_ID ? { initiatorRunId: env.YACHIYO_RUN_ID } : {}),
      ...(!json
        ? {
            onBeforeInstall: (prepared) => {
              if (!prepared.initiatorRunActive) return
              stdout.write(
                `Update ${prepared.targetVersion} is prepared. Yachiyo is about to restart; after restart it will verify the running version and report back.\n`
              )
            }
          }
        : {})
    })
    if (json) writeJson(stdout, result)
    else writeApplyResult(stdout, result)
    return
  }

  throw new Error(`Unknown update subcommand: ${action ?? '(none)'}. Expected: status, apply`)
}
