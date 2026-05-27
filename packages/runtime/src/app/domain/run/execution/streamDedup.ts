export function consumeDuplicatePrefix(input: { prefix: string; pending: string; delta: string }): {
  prefix: string
  pending: string
  delta: string
} {
  if (!input.prefix || !input.delta) {
    return input
  }

  const candidate = input.pending + input.delta
  if (!candidate) {
    return input
  }

  if (candidate.length <= input.prefix.length && input.prefix.startsWith(candidate)) {
    return {
      prefix: candidate === input.prefix ? '' : input.prefix,
      pending: candidate === input.prefix ? '' : candidate,
      delta: ''
    }
  }

  if (candidate.startsWith(input.prefix)) {
    return {
      prefix: '',
      pending: '',
      delta: candidate.slice(input.prefix.length)
    }
  }

  return {
    prefix: '',
    pending: '',
    delta: candidate
  }
}
