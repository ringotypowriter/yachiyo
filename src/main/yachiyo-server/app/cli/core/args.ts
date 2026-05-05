const VALUE_FLAGS = new Set([
  '--settings',
  '--soul',
  '--payload',
  '--db',
  '--limit',
  '--title',
  '--model'
])

export function parseArgs(rawArgs: string[]): {
  positionals: string[]
  flags: Map<string, string>
} {
  const positionals: string[] = []
  const flags = new Map<string, string>()

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) {
        const value = rawArgs[i + 1]
        if (value !== undefined && !value.startsWith('--')) {
          flags.set(arg, value)
          i++
        }
      } else {
        flags.set(arg, 'true')
      }
    } else {
      positionals.push(arg)
    }
  }

  return { positionals, flags }
}
