import { stepCountIs } from 'ai'

import { prepareAiSdkMessages } from './messagePrepare.ts'
import type { ModelRuntime } from './types.ts'
import {
  type AiSdkRuntimeDependencies,
  type FetchModelsDependencies,
  resolveAiSdkRuntimeDependencies
} from './providers/dependencies.ts'
import { fetchModels as fetchModelsImpl } from './providers/fetchModels.ts'
import { assertConfigured, createLanguageModel } from './providers/languageModel.ts'
import {
  logGatewayDiagnostics,
  shouldLogGatewayDiagnostics,
  toSerializableError
} from './providers/gateway.ts'
import { createProviderOptions } from './providers/providerOptions.ts'

const DEFAULT_MAX_RETRIES = 3

function readTextDelta(part: { delta?: string; text?: string; textDelta?: string }): string | null {
  return part.delta ?? part.textDelta ?? part.text ?? null
}

export async function fetchModels(
  provider: import('../../../shared/yachiyo/protocol').ProviderConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  dependencies: FetchModelsDependencies = {}
): Promise<string[]> {
  return fetchModelsImpl(provider, fetchImpl, dependencies)
}

export function createAiSdkModelRuntime(dependencies: AiSdkRuntimeDependencies = {}): ModelRuntime {
  const resolvedDependencies = resolveAiSdkRuntimeDependencies(dependencies)

  return {
    async *streamReply(request) {
      assertConfigured(request.settings)

      const preparedMessages = prepareAiSdkMessages(request.messages)
      const providerOptions = createProviderOptions(
        request.settings,
        request.providerOptionsMode ?? 'default'
      )

      if (shouldLogGatewayDiagnostics(request.settings)) {
        logGatewayDiagnostics('streamReply-input', {
          model: request.settings.model,
          providerOptions,
          toolNames: request.tools ? Object.keys(request.tools) : []
        })
      }

      const finishedToolCallIds = new Set<string>()
      const toolCallContextById = new Map<string, { input: unknown; toolName: string }>()
      const toolCallFinishCallback = request.onToolCallFinish
      const emitToolCallFinish = toolCallFinishCallback
        ? (event: Parameters<NonNullable<typeof toolCallFinishCallback>>[0]) => {
            const toolCallId = event.toolCall.toolCallId
            if (finishedToolCallIds.has(toolCallId)) {
              return
            }

            finishedToolCallIds.add(toolCallId)

            try {
              return toolCallFinishCallback(event)
            } catch (error) {
              finishedToolCallIds.delete(toolCallId)
              throw error
            }
          }
        : undefined

      try {
        const result = resolvedDependencies.streamTextImpl({
          abortSignal: request.signal,
          maxRetries: DEFAULT_MAX_RETRIES,
          messages: preparedMessages,
          model: createLanguageModel(
            request.settings,
            resolvedDependencies,
            request.providerOptionsMode
          ),
          providerOptions,
          ...(request.tools ? { tools: request.tools, stopWhen: stepCountIs(100) } : {}),
          ...(request.onToolCallStart
            ? { experimental_onToolCallStart: request.onToolCallStart }
            : {}),
          ...(emitToolCallFinish ? { experimental_onToolCallFinish: emitToolCallFinish } : {})
        })

        if ('fullStream' in result && result.fullStream) {
          for await (const part of result.fullStream as AsyncIterable<{
            errorText?: string
            input?: unknown
            inputTextDelta?: string
            output?: unknown
            error?: unknown
            preliminary?: boolean
            text?: string
            toolCallId?: string
            toolName?: string
            type: string
          }>) {
            if (part.type === 'error') {
              throw part.error instanceof Error
                ? part.error
                : new Error(String(part.error ?? 'Unknown stream error'))
            }

            if (
              (part.type === 'reasoning' ||
                part.type === 'reasoning-delta' ||
                part.type === 'reasoning-part-finish') &&
              readTextDelta(part)
            ) {
              request.onReasoningDelta?.(readTextDelta(part) as string)
              continue
            }

            if (part.type === 'text-delta' && readTextDelta(part)) {
              yield readTextDelta(part) as string
              continue
            }

            if (
              part.type === 'tool-input-available' &&
              typeof part.toolCallId === 'string' &&
              typeof part.toolName === 'string'
            ) {
              toolCallContextById.set(part.toolCallId, {
                input: part.input,
                toolName: part.toolName
              })
              continue
            }

            if (part.type === 'tool-input-error' && typeof part.toolCallId === 'string') {
              toolCallContextById.delete(part.toolCallId)
              continue
            }

            if (
              (part.type === 'tool-output-available' || part.type === 'tool-result') &&
              part.preliminary === true &&
              request.onToolCallUpdate &&
              typeof part.toolCallId === 'string'
            ) {
              const toolCallContext =
                (typeof part.toolName === 'string'
                  ? { input: part.input, toolName: part.toolName }
                  : undefined) ?? toolCallContextById.get(part.toolCallId)

              if (!toolCallContext) {
                continue
              }

              request.onToolCallUpdate({
                output: part.output,
                toolCall: {
                  input: toolCallContext.input,
                  toolCallId: part.toolCallId,
                  toolName: toolCallContext.toolName
                }
              })
              continue
            }

            if (
              (part.type === 'tool-output-available' || part.type === 'tool-result') &&
              part.preliminary !== true &&
              emitToolCallFinish &&
              typeof part.toolCallId === 'string'
            ) {
              const toolCallContext =
                (typeof part.toolName === 'string'
                  ? { input: part.input, toolName: part.toolName }
                  : undefined) ?? toolCallContextById.get(part.toolCallId)

              if (!toolCallContext) {
                continue
              }

              emitToolCallFinish({
                abortSignal: request.signal,
                durationMs: 0,
                experimental_context: undefined,
                functionId: undefined,
                metadata: undefined,
                model: undefined,
                messages: request.messages,
                stepNumber: undefined,
                success: true,
                output: part.output,
                toolCall: {
                  type: 'tool-call',
                  dynamic: true,
                  toolCallId: part.toolCallId,
                  toolName: toolCallContext.toolName,
                  input: toolCallContext.input
                }
              })
              toolCallContextById.delete(part.toolCallId)
              continue
            }

            if (
              (part.type === 'tool-output-error' || part.type === 'tool-error') &&
              emitToolCallFinish &&
              typeof part.toolCallId === 'string'
            ) {
              const toolCallContext =
                (typeof part.toolName === 'string'
                  ? { input: part.input, toolName: part.toolName }
                  : undefined) ?? toolCallContextById.get(part.toolCallId)

              if (!toolCallContext) {
                continue
              }

              emitToolCallFinish({
                abortSignal: request.signal,
                durationMs: 0,
                experimental_context: undefined,
                functionId: undefined,
                metadata: undefined,
                model: undefined,
                messages: request.messages,
                stepNumber: undefined,
                success: false,
                error: part.error ?? part.errorText,
                toolCall: {
                  type: 'tool-call',
                  dynamic: true,
                  toolCallId: part.toolCallId,
                  toolName: toolCallContext.toolName,
                  input: toolCallContext.input
                }
              })
              toolCallContextById.delete(part.toolCallId)
            }
          }

          return
        }

        for await (const textPart of result.textStream) {
          if (textPart) {
            yield textPart
          }
        }
      } catch (error) {
        if (shouldLogGatewayDiagnostics(request.settings)) {
          logGatewayDiagnostics('streamReply-error', {
            error: toSerializableError(error),
            model: request.settings.model,
            providerOptions
          })
        } else if (request.settings.provider === 'vertex') {
          console.error('[yachiyo][vertex] stream error', {
            error: error instanceof Error ? error.message : String(error),
            model: request.settings.model
          })
        }

        throw error
      }
    }
  }
}
