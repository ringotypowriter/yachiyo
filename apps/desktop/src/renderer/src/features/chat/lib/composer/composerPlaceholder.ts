import { t } from '@yachiyo/i18n/index'
import type { RunModeId } from '@yachiyo/shared/protocol'

const PLACEHOLDER_INDEXES = [
  'p1',
  'p2',
  'p3',
  'p4',
  'p5',
  'p6',
  'p7',
  'p8',
  'p9',
  'p10',
  'p11',
  'p12',
  'p13',
  'p14'
] as const

function getComposerPlaceholders(runMode: RunModeId | undefined): string[] {
  const namespace =
    runMode === 'plan' ? 'chat.composer.placeholdersPlan' : 'chat.composer.placeholdersCasual'
  return PLACEHOLDER_INDEXES.map((index) => t(`${namespace}.${index}`))
}

export interface ComposerPlaceholderSeed {
  threadId: string | null | undefined
  runId?: string | null | undefined
  runIndex?: number | null | undefined
  runMode?: RunModeId
}

export function selectComposerPlaceholder(
  seed: ComposerPlaceholderSeed,
  candidates?: readonly string[]
): string {
  const resolvedCandidates = candidates ?? getComposerPlaceholders(seed.runMode)
  if (resolvedCandidates.length === 0) {
    throw new Error('selectComposerPlaceholder requires at least one candidate')
  }

  if (!seed.threadId) {
    return resolvedCandidates[0]
  }

  if (seed.runIndex !== null && seed.runIndex !== undefined && seed.runIndex >= 0) {
    const threadIndex = hashString(seed.threadId) % resolvedCandidates.length
    return resolvedCandidates[(threadIndex + seed.runIndex + 1) % resolvedCandidates.length]
  }

  const seedValue = seed.runId ? `${seed.threadId}\0${seed.runId}` : seed.threadId
  return resolvedCandidates[hashString(seedValue) % resolvedCandidates.length]
}

function hashString(value: string): number {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}
