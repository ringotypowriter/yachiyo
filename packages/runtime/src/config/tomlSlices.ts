import { z } from 'zod'

export type TomlDoc = Record<string, unknown>

export interface TomlConfigSlice<Config extends object, Doc extends TomlDoc = TomlDoc> {
  key: string
  read: (doc: Doc) => Partial<Config>
  write: (config: Config) => Partial<Doc>
}

const tomlRecordSchema = z.record(z.string(), z.unknown())
const tomlArraySchema = z.array(z.unknown())

export function readConfigFromTomlSlices<Config extends object, Doc extends TomlDoc = TomlDoc>(
  doc: Doc,
  slices: readonly TomlConfigSlice<Config, Doc>[]
): Partial<Config> {
  const config: Partial<Config> = {}

  for (const slice of slices) {
    Object.assign(config, slice.read(doc))
  }

  return config
}

export function writeTomlDocFromSlices<Config extends object, Doc extends TomlDoc = TomlDoc>(
  config: Config,
  slices: readonly TomlConfigSlice<Config, Doc>[]
): Doc {
  const doc = {} as Doc

  for (const slice of slices) {
    Object.assign(doc, slice.write(config))
  }

  return doc
}

export function readTomlTable(value: unknown): Record<string, unknown> | undefined {
  const result = tomlRecordSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export function readTomlArray(value: unknown): unknown[] | undefined {
  const result = tomlArraySchema.safeParse(value)
  return result.success ? result.data : undefined
}
