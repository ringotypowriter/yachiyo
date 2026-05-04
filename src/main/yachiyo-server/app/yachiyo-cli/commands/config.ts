import type { SettingsConfig } from '../../../../../shared/yachiyo/protocol.ts'
import { namespaceHelp } from '../core/help.ts'
import { outputJson, sanitizeForOutput } from '../core/output.ts'
import type { CliConfigService } from '../core/types.ts'

function getByPath(obj: unknown, segments: string[]): unknown {
  if (segments.length === 0) return obj
  if (obj === null || obj === undefined) return undefined

  const [head, ...rest] = segments
  const numericHead = /^\d+$/u.test(head) ? parseInt(head, 10) : NaN

  if (Array.isArray(obj) && !isNaN(numericHead)) {
    return getByPath(obj[numericHead], rest)
  }

  if (typeof obj === 'object' && !Array.isArray(obj)) {
    return getByPath((obj as Record<string, unknown>)[head], rest)
  }

  return undefined
}

function setByPath(obj: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return value

  const [head, ...rest] = segments
  const numericHead = /^\d+$/u.test(head) ? parseInt(head, 10) : NaN

  if (Array.isArray(obj) && !isNaN(numericHead)) {
    const arr = [...obj]
    arr[numericHead] = setByPath(arr[numericHead], rest, value)
    return arr
  }

  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>
    return { ...record, [head]: setByPath(record[head], rest, value) }
  }

  if (!isNaN(numericHead)) {
    const arr: unknown[] = []
    arr[numericHead] = setByPath(undefined, rest, value)
    return arr
  }

  return { [head]: setByPath(undefined, rest, value) }
}

function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export async function handleConfigCommand(
  positionals: string[],
  flags: Map<string, string>,
  configService: CliConfigService,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('config')}\n`)
    return
  }

  const action = positionals[0]

  if (action === 'get') {
    const path = positionals[1]
    const config = await configService.getConfig()
    const value = path ? getByPath(config, path.split('.')) : config
    outputJson(stdout, sanitizeForOutput(value))
    return
  }

  if (action === 'set') {
    const path = positionals[1]
    const rawValue = positionals[2]
    if (!path) throw new Error('Path is required: config set <path> <value>')
    if (rawValue === undefined) throw new Error('Value is required: config set <path> <value>')
    const value = parseConfigValue(rawValue)
    const config = await configService.getConfig()
    const updated = setByPath(
      config as unknown as Record<string, unknown>,
      path.split('.'),
      value
    ) as unknown as SettingsConfig
    const saved = await configService.saveConfig(updated)
    outputJson(stdout, {
      path,
      value: sanitizeForOutput(getByPath(saved, path.split('.'))),
      ok: true
    })
    return
  }

  throw new Error(`Unknown config action: ${action ?? '(none)'}. Expected: get, set`)
}
