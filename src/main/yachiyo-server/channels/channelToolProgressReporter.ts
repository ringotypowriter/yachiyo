/**
 * Periodic tool-call progress reporter for DM channel runs.
 *
 * Subscribes to `tool.updated` events and sends a summary message
 * to the channel at a fixed interval (e.g. every 15 seconds) while
 * the run is active.
 */

import type { YachiyoServerEvent } from '../../../shared/yachiyo/protocol.ts'

const DEFAULT_INTERVAL_MS = 15_000

export interface ToolProgressReporterOptions {
  /** Server event subscription. */
  subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
  /** Thread ID to filter events. */
  threadId: string
  /** Run ID to filter events. */
  runId: string
  /** Callback to send a message to the channel. */
  sendMessage: (text: string) => Promise<void>
  /** Reporting interval in milliseconds. Defaults to 15 000. */
  intervalMs?: number
  /** Label for log messages. */
  logLabel?: string
}

export interface ToolProgressReporter {
  /** Stop the reporter and clean up. Call when the run ends. */
  stop(): void
}

export function createToolProgressReporter(
  options: ToolProgressReporterOptions
): ToolProgressReporter {
  const {
    subscribe,
    threadId,
    runId,
    sendMessage,
    intervalMs = DEFAULT_INTERVAL_MS,
    logLabel = 'tool-progress'
  } = options

  /** All tool calls seen so far, keyed by tool call ID. */
  const allTools = new Map<string, { toolName: string; status: string }>()
  /** Tool call IDs that have not yet been reported. */
  const newSinceLastReport = new Set<string>()
  /** Tool call IDs whose terminal status arrived since last report. */
  const completedSinceLastReport = new Set<string>()

  const unsubscribe = subscribe((event: YachiyoServerEvent) => {
    if (!('threadId' in event) || event.threadId !== threadId) return
    if (event.type !== 'tool.updated') return
    if (!('runId' in event) || event.runId !== runId) return

    const toolCall = (
      event as YachiyoServerEvent & {
        toolCall?: { id?: string; status?: string; toolName?: string }
      }
    ).toolCall
    if (!toolCall?.id) return

    const existing = allTools.get(toolCall.id)

    if (toolCall.status === 'running' && !existing) {
      // First time seeing this tool call
      allTools.set(toolCall.id, {
        toolName: toolCall.toolName ?? 'unknown',
        status: 'running'
      })
      newSinceLastReport.add(toolCall.id)
    } else if (toolCall.status === 'completed' || toolCall.status === 'failed') {
      if (existing) existing.status = toolCall.status
      completedSinceLastReport.add(toolCall.id)
    }
  })

  const timer = setInterval(() => {
    void flush()
  }, intervalMs)

  async function flush(): Promise<void> {
    const stillRunning = [...allTools.values()].filter((t) => t.status === 'running')
    const justCompleted = completedSinceLastReport.size
    const justStarted = newSinceLastReport.size

    // Nothing new and nothing still running — skip
    if (justStarted === 0 && justCompleted === 0 && stillRunning.length === 0) return

    const reportedNew = newSinceLastReport.size
    newSinceLastReport.clear()
    completedSinceLastReport.clear()

    const parts: string[] = []
    if (justCompleted > 0) {
      parts.push(`completed ${justCompleted} tool${justCompleted > 1 ? 's' : ''}`)
    }
    if (stillRunning.length > 0) {
      parts.push(`${stillRunning.length} still running`)
    }
    if (reportedNew > 0) {
      parts.push(`${reportedNew} new`)
    }

    const activeNames = [...new Set(stillRunning.map((t) => t.toolName))]
    const toolList = activeNames.length > 0 ? ` (${activeNames.join(', ')})` : ''
    const message = `🔧 ${parts.join(', ')}${toolList}`

    console.log(`[${logLabel}] progress report: ${message}`)
    await sendMessage(message).catch((err) => {
      console.error(`[${logLabel}] failed to send progress report`, err)
    })
  }

  return {
    stop(): void {
      clearInterval(timer)
      unsubscribe()
    }
  }
}
