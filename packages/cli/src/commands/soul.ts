import {
  readSoulDocument as defaultReadSoulDocument,
  upsertDailySoulTrait as defaultUpsertDailySoulTrait,
  removeSoulTrait as defaultRemoveSoulTrait
} from '@yachiyo/runtime/runtime/profiles/soul'
import { namespaceHelp } from '../core/help.ts'
import { outputJson } from '../core/output.ts'
import type { RemoveSoulTraitInput, RunYachiyoCliOptions } from '../core/types.ts'

export async function handleSoulCommand(
  positionals: string[],
  flags: Map<string, string>,
  soulPath: string,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('soul')}\n`)
    return
  }

  const subcommand = positionals[0]

  if (subcommand !== 'traits') {
    throw new Error(`Unknown soul subcommand: ${subcommand ?? '(none)'}. Expected: traits`)
  }

  const action = positionals[1]
  const readDoc = options.readSoulDocument ?? defaultReadSoulDocument
  const upsertTrait = options.upsertDailySoulTrait ?? defaultUpsertDailySoulTrait
  const removeTrait = options.removeSoulTrait ?? defaultRemoveSoulTrait

  if (action === 'list') {
    const doc = await readDoc({ filePath: soulPath })
    outputJson(stdout, doc?.evolvedTraits ?? [])
    return
  }

  if (action === 'add') {
    const traitText = positionals[2]
    if (!traitText?.trim()) {
      throw new Error('Trait text is required: soul traits add "<text>"')
    }
    const doc = await upsertTrait({ filePath: soulPath, trait: traitText })
    outputJson(stdout, {
      added: traitText.trim(),
      traits: doc?.evolvedTraits ?? []
    })
    return
  }

  if (action === 'remove') {
    const ref = positionals[2]
    if (ref === undefined) {
      throw new Error('Trait key is required: soul traits remove <key>')
    }
    const input: RemoveSoulTraitInput = { filePath: soulPath, key: ref }
    const doc = await removeTrait(input)
    outputJson(stdout, {
      removed: ref,
      traits: doc?.evolvedTraits ?? []
    })
    return
  }

  throw new Error(`Unknown soul traits action: ${action ?? '(none)'}. Expected: list, add, remove`)
}
