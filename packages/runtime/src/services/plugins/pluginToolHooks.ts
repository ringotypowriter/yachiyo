import type { ToolSet } from 'ai'
import type { PluginContext, PluginToolCall } from './pluginTypes.ts'
import type { PluginSession } from './pluginSession.ts'

/** Mutate the existing set so REPL tool lookups also see the hooks. */
export function applyPluginToolHooks(
  tools: ToolSet | undefined,
  plugins: PluginSession,
  context: PluginContext,
  signal: AbortSignal
): void {
  if (!tools) return
  for (const [toolName, tool] of Object.entries(tools)) {
    const execute = tool.execute
    if (!execute) continue
    tools[toolName] = {
      ...tool,
      execute: async function* (input, options) {
        const call: PluginToolCall = { toolName, input, toolCallId: options.toolCallId }
        await plugins.beforeTool(context, call, signal)
        let output: unknown
        try {
          const result: unknown = await execute(input, options)
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
          await plugins.afterTool(
            context,
            {
              ...call,
              status: 'error',
              error: error instanceof Error ? error.message : String(error)
            },
            signal
          )
          throw error
        }
        await plugins.afterTool(context, { ...call, status: 'success', output }, signal)
      }
    }
  }
}
