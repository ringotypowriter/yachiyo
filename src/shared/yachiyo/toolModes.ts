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
}

const EXPLORE_MODE_TOOL_NAMES: readonly ToolCallName[] = [
  'read',
  'grep',
  'glob',
  'webRead',
  'webSearch'
]

const PLAN_MODE_TOOL_NAMES: readonly ToolCallName[] = [
  'read',
  'grep',
  'glob',
  'webRead',
  'webSearch',
  'write'
]

export const RUN_MODE_DEFINITIONS: Record<SelectableRunModeId, RunModeDefinition> = {
  auto: {
    id: 'auto',
    label: 'Auto Mode',
    shortLabel: 'Auto',
    description: 'Use all workspace, shell, search, and web tools.',
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    seasoningKey: 'auto'
  },
  explore: {
    id: 'explore',
    label: 'Explore Mode',
    shortLabel: 'Explore',
    description: 'Read, search, inspect files, and use web sources without changing work.',
    enabledTools: EXPLORE_MODE_TOOL_NAMES,
    seasoningKey: 'explore'
  },
  plan: {
    id: 'plan',
    label: 'Plan Mode',
    shortLabel: 'Plan',
    description:
      'Draft a concrete plan first. I’ll explore, ask questions, and write it into a plan document you can accept or reject.',
    enabledTools: PLAN_MODE_TOOL_NAMES,
    seasoningKey: 'plan'
  },
  chat: {
    id: 'chat',
    label: 'Chat Mode',
    shortLabel: 'Chat',
    description: 'No user-managed tools; answer conversationally from available context.',
    enabledTools: [],
    seasoningKey: 'chat'
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

export function deriveRunModeId(enabledTools: unknown): RunModeId {
  const normalizedTools = normalizeUserEnabledTools(enabledTools, [])

  for (const runMode of SELECTABLE_RUN_MODE_IDS) {
    if (sameToolSet(normalizedTools, RUN_MODE_DEFINITIONS[runMode].enabledTools)) {
      return runMode
    }
  }

  return 'custom'
}

export function normalizeRunModeId(value: unknown, fallback: RunModeId = 'auto'): RunModeId {
  return value === 'auto' ||
    value === 'explore' ||
    value === 'plan' ||
    value === 'chat' ||
    value === 'custom'
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
    return 'custom'
  }

  if (Array.isArray(input.enabledTools)) {
    return deriveRunModeId(input.enabledTools)
  }

  if (input.fallbackRunMode) {
    return input.fallbackRunMode
  }

  return deriveRunModeId(input.fallbackEnabledTools ?? USER_MANAGED_TOOL_NAMES)
}
