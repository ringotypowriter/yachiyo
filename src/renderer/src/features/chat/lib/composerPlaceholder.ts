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

export function selectComposerPlaceholder(
  seed: string | null | undefined,
  candidates: readonly string[] = COMPOSER_PLACEHOLDERS
): string {
  if (candidates.length === 0) {
    throw new Error('selectComposerPlaceholder requires at least one candidate')
  }

  if (!seed) {
    return candidates[0]
  }

  return candidates[hashString(seed) % candidates.length]
}

function hashString(value: string): number {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}
