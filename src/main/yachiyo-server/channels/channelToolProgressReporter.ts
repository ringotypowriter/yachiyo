/**
 * Periodic tool-call progress reporter for DM channel runs.
 *
 * Subscribes to `tool.updated` events and sends a summary message
 * to the channel at a fixed interval (e.g. every 15 seconds) while
 * the run is active.
 *
 * Design constraints:
 * - Some platforms don't support message editing, so each flush is a
 *   self-contained new message.
 * - Completed tools are reported once then cleared — no repetition.
 * - Web tools (webSearch, webRead) keep individual detail lines because
 *   their query/URL is high-signal. File-oriented tools (read, edit,
 *   write, grep, glob, bash) are aggregated by category.
 * - Failures always get individual lines regardless of category.
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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TrackedToolCall {
  toolName: string
  status: string
  inputSummary: string
  outputSummary?: string
  error?: string
  stepIndex?: number
  stepBudget?: number
}

type FileCategory = 'read' | 'edit' | 'write' | 'grep' | 'glob' | 'bash'

const FILE_CATEGORY_DONE_LABELS: Record<FileCategory, { singular: string; plural: string }> = {
  read: { singular: 'Read 1 file', plural: 'Read %n files' },
  edit: { singular: 'Edited 1 file', plural: 'Edited %n files' },
  write: { singular: 'Wrote 1 file', plural: 'Wrote %n files' },
  grep: { singular: '1 grep search', plural: '%n grep searches' },
  glob: { singular: '1 glob search', plural: '%n glob searches' },
  bash: { singular: 'Ran 1 command', plural: 'Ran %n commands' }
}

const FILE_CATEGORIES = new Set<string>(Object.keys(FILE_CATEGORY_DONE_LABELS))
const WEB_TOOLS = new Set(['webSearch', 'webRead'])

// ---------------------------------------------------------------------------
// Per-tool emoji icons
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<string, string> = {
  read: '📄',
  edit: '✏️',
  write: '📝',
  grep: '🔍',
  glob: '🔍',
  bash: '💻',
  webSearch: '🌐',
  webRead: '📖',
  jsRepl: '⚡',
  askUser: '💬'
}

function toolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? '🔧'
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fileCategoryLabel(category: FileCategory, count: number): string {
  const icon = toolIcon(category)
  const labels = FILE_CATEGORY_DONE_LABELS[category]
  const text = count === 1 ? labels.singular : labels.plural.replace('%n', String(count))
  return `${icon} ${text}`
}

function formatWebLine(tc: TrackedToolCall): string {
  const icon = toolIcon(tc.toolName)
  const summary = tc.inputSummary || tc.toolName
  const suffix = tc.outputSummary ? ` — ${tc.outputSummary}` : ''
  return `${icon} ${tc.toolName === 'webSearch' ? 'Searched' : 'Read'} ${summary}${suffix}`
}

function formatFailedLine(tc: TrackedToolCall): string {
  const detail = tc.error || tc.outputSummary || ''
  const suffix = detail ? ` — ${detail}` : ''
  return `❌ ${tc.toolName}: ${tc.inputSummary}${suffix}`
}

function buildActiveHeader(active: TrackedToolCall[]): string {
  if (active.length === 0) return ''

  // Pick the most interesting active tool to headline
  const webActive = active.find((t) => WEB_TOOLS.has(t.toolName))
  const headline = webActive ?? active[active.length - 1]!
  const icon = toolIcon(headline.toolName)

  // Step progress from latest tool that has it
  const withStep = active.find((t) => t.stepIndex !== undefined && t.stepBudget !== undefined)
  const stepPrefix = withStep !== undefined ? `[${withStep.stepIndex}/${withStep.stepBudget}] ` : ''

  if (headline.toolName === 'webSearch') {
    return `${icon} ${stepPrefix}Searching ${headline.inputSummary}...`
  }
  if (headline.toolName === 'webRead') {
    return `${icon} ${stepPrefix}Reading ${headline.inputSummary}...`
  }
  if (headline.toolName === 'bash') {
    return `${icon} ${stepPrefix}Running ${headline.inputSummary || 'command'}...`
  }

  const toolLabel =
    headline.toolName === 'edit'
      ? 'Editing'
      : headline.toolName === 'write'
        ? 'Writing'
        : headline.toolName === 'read'
          ? 'Reading'
          : headline.toolName === 'grep' || headline.toolName === 'glob'
            ? 'Searching'
            : `Running ${headline.toolName}`

  return `${icon} ${stepPrefix}${toolLabel}${headline.inputSummary ? ` ${headline.inputSummary}` : ''}...`
}

function buildDeltaBody(completed: TrackedToolCall[]): string[] {
  const lines: string[] = []

  // Failures first — always individual
  const failed = completed.filter((tc) => tc.status === 'failed')
  for (const tc of failed) {
    lines.push(formatFailedLine(tc))
  }

  const succeeded = completed.filter((tc) => tc.status !== 'failed')

  // Web tools — individual lines with detail
  for (const tc of succeeded) {
    if (WEB_TOOLS.has(tc.toolName)) {
      lines.push(formatWebLine(tc))
    }
  }

  // File-oriented tools — aggregate by category
  const fileCounts = new Map<FileCategory, number>()
  for (const tc of succeeded) {
    if (FILE_CATEGORIES.has(tc.toolName)) {
      const cat = tc.toolName as FileCategory
      fileCounts.set(cat, (fileCounts.get(cat) ?? 0) + 1)
    }
  }

  if (fileCounts.size > 0) {
    // Stable iteration order matching FILE_CATEGORY_DONE_LABELS
    for (const cat of Object.keys(FILE_CATEGORY_DONE_LABELS) as FileCategory[]) {
      const count = fileCounts.get(cat)
      if (count) {
        lines.push(fileCategoryLabel(cat, count))
      }
    }
  }

  // Any tool not in web or file categories — individual line with icon
  for (const tc of succeeded) {
    if (!WEB_TOOLS.has(tc.toolName) && !FILE_CATEGORIES.has(tc.toolName)) {
      const icon = toolIcon(tc.toolName)
      const suffix = tc.outputSummary ? ` — ${tc.outputSummary}` : ''
      lines.push(`${icon} ${tc.toolName}: ${tc.inputSummary}${suffix}`)
    }
  }

  return lines
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

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
  const allTools = new Map<string, TrackedToolCall>()
  /** Tool call IDs that completed since last report (reported once, then cleared). */
  const completedSinceLastReport = new Map<string, TrackedToolCall>()

  const unsubscribe = subscribe((event: YachiyoServerEvent) => {
    if (!('threadId' in event) || event.threadId !== threadId) return
    if (event.type !== 'tool.updated') return
    if (!('runId' in event) || event.runId !== runId) return

    const toolCall = (
      event as YachiyoServerEvent & {
        toolCall?: {
          id?: string
          status?: string
          toolName?: string
          inputSummary?: string
          outputSummary?: string
          error?: string
          stepIndex?: number
          stepBudget?: number
        }
      }
    ).toolCall
    if (!toolCall?.id) return

    const tracked: TrackedToolCall = {
      toolName: toolCall.toolName ?? 'unknown',
      status: toolCall.status ?? 'running',
      inputSummary: toolCall.inputSummary ?? '',
      outputSummary: toolCall.outputSummary,
      error: toolCall.error,
      stepIndex: toolCall.stepIndex,
      stepBudget: toolCall.stepBudget
    }

    if (toolCall.status === 'preparing' || toolCall.status === 'running') {
      allTools.set(toolCall.id, tracked)
    } else if (toolCall.status === 'completed' || toolCall.status === 'failed') {
      const existing = allTools.get(toolCall.id)
      if (existing) {
        Object.assign(existing, tracked)
      } else {
        allTools.set(toolCall.id, tracked)
      }
      completedSinceLastReport.set(toolCall.id, allTools.get(toolCall.id)!)
    }
  })

  const timer = setInterval(() => {
    void flush()
  }, intervalMs)

  async function flush(): Promise<void> {
    const active = [...allTools.values()].filter(
      (t) => t.status === 'preparing' || t.status === 'running' || t.status === 'background'
    )
    const completed = [...completedSinceLastReport.values()]
    completedSinceLastReport.clear()

    // Nothing new and nothing active — skip
    if (completed.length === 0 && active.length === 0) return

    const header = buildActiveHeader(active)
    const deltaLines = buildDeltaBody(completed)

    let message: string
    if (header && deltaLines.length > 0) {
      message = `${header}\n  ${deltaLines.join('\n  ')}`
    } else if (header) {
      message = header
    } else if (deltaLines.length > 0) {
      message = deltaLines.join('\n')
    } else {
      return
    }

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
