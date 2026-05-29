import {
  DEFAULT_ENABLED_TOOL_NAMES,
  USER_MANAGED_TOOL_NAMES,
  normalizeUserEnabledTools,
  type RunModeId,
  type SelectableRunModeId,
  type ToolCallName
} from './protocol.ts'

export interface RunModeDefinition {
  id: SelectableRunModeId
  label: string
  shortLabel: string
  description: string
  enabledTools: readonly ToolCallName[]
  seasoningKey: SelectableRunModeId
  iconName: string
}

export const EXPLORE_MODE_TOOL_NAMES: readonly ToolCallName[] = [
  'read',
  'grep',
  'glob',
  'webRead',
  'webSearch'
]

export const PLAN_MODE_TOOL_NAMES: readonly ToolCallName[] = [
  'read',
  'grep',
  'glob',
  'webRead',
  'webSearch',
  'write',
  'bash'
]

export const RUN_MODE_DEFINITIONS: Record<SelectableRunModeId, RunModeDefinition> = {
  auto: {
    id: 'auto',
    label: 'Auto Mode',
    shortLabel: 'Auto',
    description: 'Full tool access — workspace, shell, search, and web.',
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    seasoningKey: 'auto',
    iconName: 'Zap'
  },
  explore: {
    id: 'explore',
    label: 'Explore Mode',
    shortLabel: 'Explore',
    description: 'Read and search only. Nothing gets changed.',
    enabledTools: EXPLORE_MODE_TOOL_NAMES,
    seasoningKey: 'explore',
    iconName: 'Telescope'
  },
  plan: {
    id: 'plan',
    label: 'Plan Mode',
    shortLabel: 'Plan',
    description: 'Draft a plan first. Accept to run it, or reject to revise.',
    enabledTools: PLAN_MODE_TOOL_NAMES,
    seasoningKey: 'plan',
    iconName: 'Map'
  },
  chat: {
    id: 'chat',
    label: 'Chat Mode',
    shortLabel: 'Chat',
    description: 'No tools. Replies from existing context only.',
    enabledTools: [],
    seasoningKey: 'chat',
    iconName: 'MessageSquare'
  }
}

export const SELECTABLE_RUN_MODE_IDS: readonly SelectableRunModeId[] = [
  'auto',
  'explore',
  'plan',
  'chat'
]

function sameToolSet(left: readonly ToolCallName[], right: readonly ToolCallName[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((toolName) => rightSet.has(toolName))
}

export function resolveRunModeEnabledTools(runMode: SelectableRunModeId): ToolCallName[] {
  return [...RUN_MODE_DEFINITIONS[runMode].enabledTools]
}

export function deriveRunModeId(enabledTools: unknown): SelectableRunModeId {
  const normalizedTools = normalizeUserEnabledTools(enabledTools, [])

  for (const runMode of SELECTABLE_RUN_MODE_IDS) {
    if (sameToolSet(normalizedTools, RUN_MODE_DEFINITIONS[runMode].enabledTools)) {
      return runMode
    }
  }

  return 'auto'
}

export function normalizeRunModeId(
  value: unknown,
  fallback: SelectableRunModeId = 'auto'
): SelectableRunModeId {
  return value === 'auto' || value === 'explore' || value === 'plan' || value === 'chat'
    ? value
    : fallback
}

export function resolveRunModeId(input: {
  enabledTools?: unknown
  runMode?: unknown
  fallbackEnabledTools?: readonly ToolCallName[]
  fallbackRunMode?: RunModeId
}): RunModeId {
  if (
    input.runMode === 'auto' ||
    input.runMode === 'explore' ||
    input.runMode === 'plan' ||
    input.runMode === 'chat'
  ) {
    return input.runMode
  }

  if (input.runMode === 'custom') {
    return normalizeRunModeId(input.fallbackRunMode)
  }

  if (Array.isArray(input.enabledTools)) {
    return deriveRunModeId(input.enabledTools)
  }

  if (input.fallbackRunMode) {
    return normalizeRunModeId(input.fallbackRunMode)
  }

  return deriveRunModeId(input.fallbackEnabledTools ?? USER_MANAGED_TOOL_NAMES)
}
