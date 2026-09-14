import { CheckCircle2, CirclePause, CircleX, Wrench } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'
import {
  buildToolCallDetailsPresentation,
  buildToolCallRowSummary
} from '../../lib/tool-calls/toolCallPresentation'

const BINARY_OMITTED = '[Binary payload omitted]'

function readablePayload(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /data:[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*;base64,[A-Za-z0-9+/=\s]+/gi,
      BINARY_OMITTED
    )
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return BINARY_OMITTED
  if (Array.isArray(value)) return value.map(readablePayload)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.type === 'Buffer' && Array.isArray(record.data)) return BINARY_OMITTED
    const binary =
      record.type === 'image' ||
      record.type === 'audio' ||
      record.type === 'binary' ||
      record.encoding === 'base64' ||
      typeof record.mimeType === 'string' ||
      typeof record.mediaType === 'string'
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        /^(?:base64|b64_json|imageBase64|audioBase64|pngData|bytes)$/i.test(key) ||
        (binary && /^(?:data|image|audio)$/i.test(key))
          ? BINARY_OMITTED
          : readablePayload(entry)
      ])
    )
  }
  return value
}

function readableText(value: unknown): string {
  if (typeof value === 'string') {
    if (/^\s*[[{]/.test(value)) {
      try {
        return JSON.stringify(readablePayload(JSON.parse(value)), null, 2)
      } catch {
        /* Plain tool text that happens to start with a bracket. */
      }
    }
    return readablePayload(value) as string
  }
  return JSON.stringify(readablePayload(value), null, 2) ?? ''
}

function storedField(value: unknown, field: string): string | undefined {
  if (typeof value === 'string') {
    try {
      return storedField(JSON.parse(value), field)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const entry = (value as Record<string, unknown>)[field]
  return typeof entry === 'string' && entry ? readableText(entry) : undefined
}

export function ShareToolView({
  toolCall,
  details
}: {
  toolCall: ToolCall
  details: boolean
}): React.JSX.Element {
  const presentation = buildToolCallDetailsPresentation(toolCall)
  const summary = buildToolCallRowSummary(toolCall)
  // Keep the complete stored payload, including fields omitted by live-row summaries.
  const rawOutput = 'rawOutput' in toolCall ? toolCall.rawOutput : undefined
  const completeOutput =
    rawOutput === undefined
      ? presentation.output
      : {
          value: readableText(rawOutput)
        }
  const inputSummary =
    toolCall.toolName === 'askUser'
      ? (storedField(presentation.input?.value, 'question') ?? summary.inputSummary)
      : summary.inputSummary
  const outputSummary =
    toolCall.toolName === 'askUser'
      ? (storedField(completeOutput?.value, 'answer') ?? summary.outputSummary)
      : summary.outputSummary
  const Icon =
    toolCall.status === 'failed'
      ? CircleX
      : toolCall.status === 'completed'
        ? CheckCircle2
        : CirclePause
  return (
    <div className="response-share-tool" data-status={toolCall.status}>
      <div className="response-share-tool-heading">
        <Wrench size={16} aria-hidden="true" />
        <strong>{toolCall.toolName}</strong>
        <span className="response-share-tool-status">
          <Icon size={14} aria-hidden="true" />
          {toolCall.status}
        </span>
        {inputSummary ? (
          <span className="response-share-tool-summary">{readableText(inputSummary)}</span>
        ) : null}
      </div>
      {outputSummary && outputSummary !== inputSummary ? (
        <p className="response-share-muted">{readableText(outputSummary)}</p>
      ) : null}
      {details ? (
        <div className="response-share-tool-details">
          {(
            [
              ['Input', presentation.input],
              [
                'Details',
                toolCall.details ? { value: readableText(toolCall.details) } : presentation.metadata
              ],
              ['Output', completeOutput],
              ['Error', toolCall.error ? { value: toolCall.error } : undefined]
            ] as const
          ).map(([label, block]) =>
            block ? (
              <section key={label} data-share-tool-detail>
                <h4>{label}</h4>
                <pre>{readableText(block.value)}</pre>
              </section>
            ) : null
          )}
        </div>
      ) : null}
    </div>
  )
}
