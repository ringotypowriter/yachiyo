import type { ModelMessage } from '../../runtime/models/types.ts'
import type { RunModeId } from '@yachiyo/shared/protocol'

export interface PluginContext {
  runId: string
  threadId: string
  workspacePath: string
  runMode: RunModeId
}

export interface PluginToolCall {
  toolName: string
  toolCallId: string
  input: unknown
}

export type PluginToolResult = PluginToolCall &
  ({ status: 'success'; output: unknown } | { status: 'error'; error: string })

export interface PluginHooks {
  beforeModel?: (event: {
    context: PluginContext
    messages: ModelMessage[]
    stepNumber: number
  }) => { messages: ModelMessage[] } | void | Promise<{ messages: ModelMessage[] } | void>
  beforeTool?: (
    event: PluginToolCall & { context: PluginContext }
  ) => { block: string } | void | Promise<{ block: string } | void>
  afterTool?: (event: PluginToolResult & { context: PluginContext }) => void | Promise<void>
}

/** Version 1 exposes hooks only. Plugins cannot register or replace tools. */
export interface PluginDefinition {
  apiVersion: 1
  hooks: PluginHooks
}

export interface PluginSource {
  name: string
  source: string
  revision: string
}

/** Shared by execution legs so edits take effect on the next run. */
export interface PluginRunSnapshot {
  sources?: PluginSource[]
}

export interface PluginDescriptor {
  name: string
  revision: string
  hooks: Array<keyof PluginHooks>
}
