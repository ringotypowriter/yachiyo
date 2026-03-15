export interface ModelChip {
  provider: string
  model: string
}

function parseClaudeModel(modelId: string): ModelChip | null {
  // claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5-20251001
  const match = modelId.match(/^claude-(\w+)-(\d+)-(\d+)/)
  if (!match) return null
  const [, variant, major, minor] = match
  const name = variant.charAt(0).toUpperCase() + variant.slice(1)
  return { provider: 'Anthropic', model: `Claude ${name} ${major}.${minor}` }
}

function parseOpenAIModel(modelId: string): ModelChip | null {
  if (!modelId.startsWith('gpt-') && !/^o\d/.test(modelId)) return null

  if (modelId.startsWith('gpt-')) {
    // gpt-4o → GPT-4o, gpt-4o-mini → GPT-4o Mini
    const withoutPrefix = modelId.slice(4)
    const parts = withoutPrefix.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    return { provider: 'OpenAI', model: `GPT-${parts.join(' ')}` }
  }

  // o1, o3, o3-mini → O1, O3, O3 Mini
  const parts = modelId.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  return { provider: 'OpenAI', model: parts.join(' ') }
}

export function formatModelChip(modelId: string): ModelChip {
  return parseClaudeModel(modelId) ?? parseOpenAIModel(modelId) ?? { provider: '', model: modelId }
}

export function formatStoredModelChip(modelId: string, providerName?: string): ModelChip {
  const chip = formatModelChip(modelId)

  if (!providerName) {
    return chip
  }

  return {
    ...chip,
    provider: providerName
  }
}
