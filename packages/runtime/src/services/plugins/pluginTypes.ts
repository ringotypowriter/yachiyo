import type {
  ModelGenerationOptions,
  ModelMessage,
  ModelStepResult
} from '../../runtime/models/types.ts'
import type { RunModeId } from '@yachiyo/shared/protocol'
import type { PluginStateRecord } from './pluginDataStore.ts'
import type { PluginSession } from './pluginSession.ts'

export interface PluginContext {
  runId: string
  threadId: string
  workspacePath: string
  runMode: RunModeId
  purpose?: 'chat' | 'subagent' | 'compaction' | 'trial'
}

export interface PluginToolCall {
  toolName: string
  toolCallId: string
  input: unknown
}

export type PluginToolResult = PluginToolCall &
  ({ status: 'success'; output: unknown } | { status: 'error'; error: string })

export interface PluginModelSelection {
  providerName: string
  model: string
}

export type PluginModelOptions = ModelGenerationOptions

export type PluginStateScope = 'run' | 'thread' | 'workspace' | 'plugin'

export interface PluginApi {
  state: {
    read: (scope: PluginStateScope, key: string) => Promise<PluginStateRecord>
    write: (
      scope: PluginStateScope,
      key: string,
      expectedVersion: number,
      value: unknown
    ) => Promise<PluginStateRecord>
  }
}

export interface PluginModelInput {
  messages: ModelMessage[]
  stepNumber: number
  model?: PluginModelSelection
  availableModels?: PluginModelSelection[]
  options?: PluginModelOptions
}

export type PluginStepResult = ModelStepResult

export interface PluginCompactInput {
  kind: 'strip' | 'handoff'
  messages: ModelMessage[]
  thresholdTokens?: number
  summary?: string
  skip?: boolean
}

export interface PluginEventMap {
  runStart: { maxSteps: number }
  beforeInput: { text: string }
  beforeModel: PluginModelInput
  afterStep: PluginStepResult
  textDelta: { text: string; stepNumber: number }
  beforeCompact: PluginCompactInput
  afterCompact: PluginCompactInput
  beforeTool: PluginToolCall
  afterTool: PluginToolResult
  runEnd: { status: string }
}

export interface PluginResultMap {
  runStart: { maxSteps?: number }
  beforeInput: { text: string }
  beforeModel: {
    messages?: ModelMessage[]
    model?: PluginModelSelection
    options?: PluginModelOptions
  }
  afterStep: { stop?: boolean; messages?: ModelMessage[]; compact?: boolean }
  textDelta: { text: string }
  beforeCompact: Omit<Partial<PluginCompactInput>, 'kind'>
  afterCompact: { messages?: ModelMessage[]; summary?: string }
  beforeTool: { block: string }
  afterTool: void
  runEnd: void
}

export type PluginHooks = {
  [K in keyof PluginEventMap]?: (
    event: PluginEventMap[K] & { context: PluginContext },
    api: PluginApi
  ) => PluginResultMap[K] | void | Promise<PluginResultMap[K] | void>
}

/** Hooks can change the harness, but cannot register, replace or redefine tools. */
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
  session?: PluginSession
  context?: PluginContext
  started?: boolean
  maxSteps?: number
  state?: Map<string, PluginStateRecord>
  diagnostics?: PluginHookDiagnostic[]
  error?: string
  directory?: string
}

export interface PluginHookDiagnostic {
  name: string
  revision: string
  hook: keyof PluginHooks
  calls: number
  durationMs: number
  error?: string
}

export interface PluginDescriptor {
  name: string
  revision: string
  hooks: Array<keyof PluginHooks>
}
