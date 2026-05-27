import type { ProviderConfig } from '@yachiyo/shared/protocol'
import { providerMatchesReference } from '@yachiyo/shared/providerConfig'
import { namespaceHelp } from '../core/help.ts'
import { outputJson, sanitizeForOutput } from '../core/output.ts'
import type { CliConfigService } from '../core/types.ts'

function findProviderByRef(providers: ProviderConfig[], ref: string): ProviderConfig | undefined {
  return (
    providers.find((p) => providerMatchesReference(p, { id: ref })) ??
    providers.find((p) => providerMatchesReference(p, { name: ref }))
  )
}

export async function handleProviderCommand(
  positionals: string[],
  flags: Map<string, string>,
  configService: CliConfigService,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('provider')}\n`)
    return
  }

  const action = positionals[0]

  if (action === 'list') {
    const config = await configService.getConfig()
    outputJson(
      stdout,
      config.providers.map((p) => sanitizeForOutput(p))
    )
    return
  }

  if (action === 'show') {
    const ref = positionals[1]
    if (!ref) throw new Error('Provider id or name is required: provider show <id-or-name>')
    const config = await configService.getConfig()
    const provider = findProviderByRef(config.providers, ref)
    if (!provider) throw new Error(`Unknown provider: ${ref}`)
    outputJson(stdout, sanitizeForOutput(provider))
    return
  }

  if (action === 'update') {
    const ref = positionals[1]
    if (!ref) throw new Error('Provider id or name is required: provider update <id-or-name>')
    const payloadRaw = flags.get('--payload')
    const patch = payloadRaw ? (JSON.parse(payloadRaw) as Partial<ProviderConfig>) : {}
    const config = await configService.getConfig()
    const existing = findProviderByRef(config.providers, ref)
    if (!existing) throw new Error(`Unknown provider: ${ref}`)
    const updated: ProviderConfig = {
      ...existing,
      ...patch,
      id: existing.id,
      name: patch.name ?? existing.name,
      modelList: patch.modelList
        ? {
            enabled: patch.modelList.enabled ?? existing.modelList.enabled,
            disabled: patch.modelList.disabled ?? existing.modelList.disabled
          }
        : existing.modelList
    }
    const provider = await configService.upsertProvider(updated)
    outputJson(stdout, sanitizeForOutput(provider))
    return
  }

  if (action === 'set-default') {
    const ref = positionals[1]
    if (!ref) throw new Error('Provider id or name is required: provider set-default <id-or-name>')
    const model = flags.get('--model')
    const config = await configService.setDefaultProvider({ id: ref, name: ref, model })
    outputJson(stdout, {
      defaultProvider: config.providers[0] ? sanitizeForOutput(config.providers[0]) : null,
      defaultModel: config.defaultModel ?? null,
      providers: config.providers.map((p) => sanitizeForOutput(p))
    })
    return
  }

  if (action === 'models') {
    const ref = positionals[1]
    const config = await configService.getConfig()

    if (!ref) {
      const enabled = config.providers.flatMap((p) =>
        p.modelList.enabled.map((model) => ({ provider: p.name, model }))
      )
      outputJson(stdout, enabled)
      return
    }

    const provider = findProviderByRef(config.providers, ref)
    if (!provider) throw new Error(`Unknown provider: ${ref}`)
    const models = await configService.fetchProviderModels(provider)
    outputJson(stdout, { provider: provider.name, models })
    return
  }

  throw new Error(
    `Unknown provider action: ${action ?? '(none)'}. Expected: list, show, update, set-default, models`
  )
}
