import type { RunModeId } from '../../../../../shared/yachiyo/protocol.ts'

const COMPOSER_PLACEHOLDERS = [
  "What's on your mind?",
  'Ask, vent, or throw words at me.',
  "I've seen worse. Try me.",
  'No topic too weird, no thought too half-baked.',
  'What are we solving, making, or overthinking today?',
  'Eight thousand years of patience. Use it.',
  "Say the thing you're not sure is worth saying.",
  'Stuck? Bored? Curious? All valid.',
  'Type first, coherence later.',
  'The cursor is blinking. So am I.',
  'Your train of thought has no brakes here.',
  "Let's make something, break something, or just talk.",
  "What's the thing you're pretending you don't want to ask?",
  "Nothing's too small. I've got time."
] as const

const COMPOSER_PLACEHOLDERS_PLAN = [
  "What's the goal, and what's in the way?",
  'Break it down. I will draft the steps.',
  'Start with the problem. We will plan the fix.',
  'What are we building or changing?',
  'Describe the outcome you want, and I will map the path.',
  'Big task? Let me cut it into pieces.',
  'State the objective. I will sketch the approach.',
  'What constraints should the plan respect?',
  'Walk me through the situation. I will outline the moves.',
  'Need a strategy before the work begins?',
  'What does done look like?',
  'Throw me the puzzle. I will sort the edges first.',
  'Ready when you are. What are we planning?',
  'Start messy. The plan will clean it up.'
] as const

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
  const resolvedCandidates =
    candidates ?? (seed.runMode === 'plan' ? COMPOSER_PLACEHOLDERS_PLAN : COMPOSER_PLACEHOLDERS)
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
