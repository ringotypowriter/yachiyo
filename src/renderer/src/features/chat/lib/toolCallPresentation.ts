import type {
  BashToolCallDetails,
  EditToolCallDetails,
  ReadToolCallDetails,
  ToolCall,
  WriteToolCallDetails
} from '../../../app/types.ts'

type ToolCallDetailTone = 'danger'

export interface ToolCallDetailField {
  label: string
  value: string
  tone?: ToolCallDetailTone
}

export interface ToolCallDetailCodeBlock {
  label: string
  value: string
  tone?: ToolCallDetailTone
}

export interface ToolCallDetailsPresentation {
  fields: ToolCallDetailField[]
  codeBlocks: ToolCallDetailCodeBlock[]
}

const OUTPUT_TAIL_MAX_LINES = 12
const OUTPUT_TAIL_MAX_CHARS = 1200

function pushField(
  fields: ToolCallDetailField[],
  label: string,
  value: string | number | undefined,
  tone?: ToolCallDetailTone
): void {
  if (value === undefined) {
    return
  }

  fields.push({
    label,
    value: String(value),
    ...(tone ? { tone } : {})
  })
}

function pushCodeBlock(
  codeBlocks: ToolCallDetailCodeBlock[],
  label: string,
  value: string | undefined,
  tone?: ToolCallDetailTone
): void {
  const normalizedValue = value?.trimEnd()
  if (!normalizedValue) {
    return
  }

  codeBlocks.push({
    label,
    value: normalizedValue,
    ...(tone ? { tone } : {})
  })
}

function toYesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function takeTextTail(
  value: string,
  options: { maxLines?: number; maxChars?: number } = {}
): { text: string; truncated: boolean } {
  const trimmedValue = value.trimEnd()
  if (!trimmedValue) {
    return { text: '', truncated: false }
  }

  const maxLines = options.maxLines ?? OUTPUT_TAIL_MAX_LINES
  const maxChars = options.maxChars ?? OUTPUT_TAIL_MAX_CHARS

  const lines = trimmedValue.split(/\r?\n/)
  const lineTail = lines.slice(-maxLines)
  let text = lineTail.join('\n')
  let truncated = lineTail.length !== lines.length

  if (text.length > maxChars) {
    text = text.slice(-maxChars)
    truncated = true

    const firstNewlineIndex = text.indexOf('\n')
    if (firstNewlineIndex > 0 && firstNewlineIndex < text.length - 1) {
      text = text.slice(firstNewlineIndex + 1)
    }
  }

  return { text, truncated }
}

function pushOutputTail(
  codeBlocks: ToolCallDetailCodeBlock[],
  label: string,
  value: string,
  tone?: ToolCallDetailTone
): void {
  const tail = takeTextTail(value)
  if (!tail.text) {
    return
  }

  pushCodeBlock(codeBlocks, tail.truncated ? `${label} tail` : label, tail.text, tone)
}

export function buildToolCallDetailsPresentation(toolCall: ToolCall): ToolCallDetailsPresentation {
  const fields: ToolCallDetailField[] = []
  const codeBlocks: ToolCallDetailCodeBlock[] = []

  pushCodeBlock(codeBlocks, 'error', toolCall.error, 'danger')

  if (toolCall.toolName === 'read') {
    const details = toolCall.details as ReadToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'start line', details.startLine)
    pushField(fields, 'end line', details.endLine)
    pushField(fields, 'truncated', toYesNo(details.truncated))
    pushField(fields, 'next offset', details.nextOffset)
    pushField(fields, 'remaining lines', details.remainingLines)
    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'edit') {
    const details = toolCall.details as EditToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'replacements', details.replacements)
    pushField(fields, 'first changed line', details.firstChangedLine)
    pushCodeBlock(codeBlocks, 'diff', details.diff)
    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'write') {
    const details = toolCall.details as WriteToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'bytes written', details.bytesWritten)
    pushField(fields, 'created', toYesNo(details.created))
    pushField(fields, 'overwritten', toYesNo(details.overwritten))
    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'bash') {
    const details = toolCall.details as BashToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'exit code', details.exitCode)

    if (details.timedOut !== undefined) {
      pushField(fields, 'timed out', toYesNo(details.timedOut))
    }

    if (details.blocked !== undefined) {
      pushField(fields, 'blocked', toYesNo(details.blocked))
    }

    if (details.truncated !== undefined) {
      pushField(fields, 'output truncated', toYesNo(details.truncated))
    }

    pushField(fields, 'output file', details.outputFilePath)
    pushOutputTail(
      codeBlocks,
      'stderr',
      details.stderr,
      toolCall.status === 'failed' || details.blocked ? 'danger' : undefined
    )
    pushOutputTail(codeBlocks, 'stdout', details.stdout)
  }

  return { fields, codeBlocks }
}
