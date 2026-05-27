import {
  readSoulDocument as defaultReadSoulDocument,
  upsertDailySoulTrait as defaultUpsertDailySoulTrait,
  removeSoulTrait as defaultRemoveSoulTrait
} from '@yachiyo/runtime/runtime/profiles/soul'
import { namespaceHelp } from '../core/help.ts'
import { outputJson } from '../core/output.ts'
import type { RemoveSoulTraitInput, RunYachiyoCliOptions } from '../core/types.ts'

function formatTraitList(traits: string[]): Array<{ index: number; trait: string }> {
  return traits.map((trait, index) => ({ index, trait }))
}

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
    outputJson(stdout, formatTraitList(doc?.evolvedTraits ?? []))
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
      traits: formatTraitList(doc?.evolvedTraits ?? [])
    })
    return
  }

  if (action === 'remove') {
    const ref = positionals[2]
    if (ref === undefined) {
      throw new Error('Index or trait text is required: soul traits remove <index-or-text>')
    }
    const numericIndex = /^\d+$/u.test(ref) ? parseInt(ref, 10) : NaN
    const input: RemoveSoulTraitInput = { filePath: soulPath }
    if (!isNaN(numericIndex)) {
      input.index = numericIndex
    } else {
      input.trait = ref
    }
    const doc = await removeTrait(input)
    outputJson(stdout, {
      removed: ref,
      traits: formatTraitList(doc?.evolvedTraits ?? [])
    })
    return
  }

  throw new Error(`Unknown soul traits action: ${action ?? '(none)'}. Expected: list, add, remove`)
}
