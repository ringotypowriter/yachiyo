import { randomUUID } from 'node:crypto'
import type { SubagentProfile, SubagentRuntimeMode } from '@yachiyo/shared/protocol'
import { namespaceHelp } from '../core/help.ts'
import { outputJson } from '../core/output.ts'
import type { CliConfigService } from '../core/types.ts'

function findAgentByRef(profiles: SubagentProfile[], ref: string): SubagentProfile | undefined {
  return profiles.find((p) => p.id === ref) ?? profiles.find((p) => p.name === ref)
}

export async function handleAgentCommand(
  positionals: string[],
  flags: Map<string, string>,
  configService: CliConfigService,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('agent')}\n`)
    return
  }

  const action = positionals[0]

  if (action === 'list') {
    const config = await configService.getConfig()
    const mode = config.subagents?.mode ?? 'worker'
    outputJson(stdout, {
      mode,
      deprecatedAcpProfiles: config.subagentProfiles ?? [],
      note:
        mode === 'worker'
          ? 'ACP profiles are deprecated. Worker named subagents are active.'
          : undefined
    })
    return
  }

  if (action === 'mode') {
    const requestedMode = positionals[1]
    if (!requestedMode || (requestedMode !== 'worker' && requestedMode !== 'acp')) {
      throw new Error('Mode must be "worker" or "acp": agent mode <worker|acp>')
    }
    const mode = requestedMode as SubagentRuntimeMode
    const config = await configService.getConfig()
    const updatedConfig = {
      ...config,
      subagents: { ...(config.subagents ?? { enabledNamedAgents: [] }), mode }
    }
    await configService.saveConfig(updatedConfig)
    outputJson(stdout, { mode: requestedMode })
    return
  }

  if (action === 'show') {
    const ref = positionals[1]
    if (!ref) throw new Error('Agent id or name is required: agent show <id-or-name>')
    const config = await configService.getConfig()
    const agent = findAgentByRef(config.subagentProfiles ?? [], ref)
    if (!agent) throw new Error(`Unknown agent: ${ref}`)
    outputJson(stdout, agent)
    return
  }

  if (action === 'add') {
    const payloadRaw = flags.get('--payload')
    if (!payloadRaw) throw new Error('Payload is required: agent add --payload <json>')
    const patch = JSON.parse(payloadRaw) as Partial<SubagentProfile>
    if (!patch.name?.trim()) throw new Error('Agent name is required in payload')
    if (!patch.command?.trim()) throw new Error('Agent command is required in payload')
    const newAgent: SubagentProfile = {
      id: patch.id ?? randomUUID(),
      name: patch.name,
      enabled: patch.enabled ?? true,
      description: patch.description ?? '',
      command: patch.command,
      args: patch.args ?? [],
      env: patch.env ?? {}
    }
    const config = await configService.getConfig()
    const updatedConfig = {
      ...config,
      subagentProfiles: [...(config.subagentProfiles ?? []), newAgent]
    }
    await configService.saveConfig(updatedConfig)
    outputJson(stdout, { added: newAgent, agents: updatedConfig.subagentProfiles })
    return
  }

  if (action === 'update') {
    const ref = positionals[1]
    if (!ref) throw new Error('Agent id or name is required: agent update <id-or-name>')
    const payloadRaw = flags.get('--payload')
    const patch = payloadRaw ? (JSON.parse(payloadRaw) as Partial<SubagentProfile>) : {}
    const config = await configService.getConfig()
    const existing = findAgentByRef(config.subagentProfiles ?? [], ref)
    if (!existing) throw new Error(`Unknown agent: ${ref}`)
    const updated: SubagentProfile = { ...existing, ...patch, id: existing.id }
    const newProfiles = (config.subagentProfiles ?? []).map((p) =>
      p.id === existing.id ? updated : p
    )
    await configService.saveConfig({ ...config, subagentProfiles: newProfiles })
    outputJson(stdout, updated)
    return
  }

  if (action === 'remove') {
    const ref = positionals[1]
    if (!ref) throw new Error('Agent id or name is required: agent remove <id-or-name>')
    const config = await configService.getConfig()
    const existing = findAgentByRef(config.subagentProfiles ?? [], ref)
    if (!existing) throw new Error(`Unknown agent: ${ref}`)
    const newProfiles = (config.subagentProfiles ?? []).filter((p) => p.id !== existing.id)
    await configService.saveConfig({ ...config, subagentProfiles: newProfiles })
    outputJson(stdout, { removed: existing.id, agents: newProfiles })
    return
  }

  if (action === 'enable' || action === 'disable') {
    const ref = positionals[1]
    if (!ref) throw new Error(`Agent id or name is required: agent ${action} <id-or-name>`)
    const config = await configService.getConfig()
    const existing = findAgentByRef(config.subagentProfiles ?? [], ref)
    if (!existing) throw new Error(`Unknown agent: ${ref}`)
    const updated: SubagentProfile = { ...existing, enabled: action === 'enable' }
    const newProfiles = (config.subagentProfiles ?? []).map((p) =>
      p.id === existing.id ? updated : p
    )
    await configService.saveConfig({ ...config, subagentProfiles: newProfiles })
    outputJson(stdout, updated)
    return
  }

  throw new Error(
    `Unknown agent action: ${action ?? '(none)'}. Expected: list, show, add, update, remove, enable, disable`
  )
}
