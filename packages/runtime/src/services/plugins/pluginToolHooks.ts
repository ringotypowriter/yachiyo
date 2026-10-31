import type { ToolSet } from 'ai'
import type { PluginContext, PluginToolCall } from './pluginTypes.ts'
import type { PluginSession } from './pluginSession.ts'

export interface PluginToolInvocation {
  session: PluginSession
  context: PluginContext
  signal: AbortSignal
}

/** Mutate the existing set so REPL tool lookups also see the hooks. */
export function applyPluginToolHooks(
  tools: ToolSet | undefined,
  getInvocation: () => PluginToolInvocation | undefined
): void {
  if (!tools) return
  for (const [toolName, tool] of Object.entries(tools)) {
    const execute = tool.execute
    if (!execute) continue
    tools[toolName] = {
      ...tool,
      execute: async function* (input, options) {
        const invocation = getInvocation()
        const signal =
          invocation && options.abortSignal
            ? AbortSignal.any([invocation.signal, options.abortSignal])
            : invocation?.signal
        const call: PluginToolCall = { toolName, input, toolCallId: options.toolCallId }
        if (invocation) await invocation.session.beforeTool(invocation.context, call, signal!)
        let output: unknown
        try {
          const result: unknown = await Reflect.apply(execute, tool, [input, options])
          if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
            for await (const item of result as AsyncIterable<unknown>) {
              output = item
              yield item
            }
          } else {
            output = result
            yield result
          }
        } catch (error) {
          if (invocation)
            await invocation.session.afterTool(
              invocation.context,
              {
                ...call,
                status: 'error',
                error: error instanceof Error ? error.message : String(error)
              },
              signal!
            )
          throw error
        }
        if (invocation)
          await invocation.session.afterTool(
            invocation.context,
            { ...call, status: 'success', output },
            signal!
          )
      }
    }
  }
}
