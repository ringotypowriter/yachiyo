import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { applyStripCompact } from '../../runtime/context/contextStripCompact.ts'
import { PluginExecutionError } from '../../runtime/models/runtimeErrors.ts'
import type { ModelMessage, ModelStreamRequest } from '../../runtime/models/types.ts'
import { toResolvedProviderSettings } from '../../settings/settingsProviderNormalization.ts'
import { PluginSession } from './pluginSession.ts'
import { PluginState } from './pluginState.ts'
import { PluginVersions } from './pluginVersions.ts'
import { recordPluginDiagnostics } from './pluginDiagnostics.ts'
import type { PluginCompactInput, PluginContext, PluginRunSnapshot } from './pluginTypes.ts'

export async function startPluginRun(input: {
  snapshot: PluginRunSnapshot
  config: SettingsConfig
  context: PluginContext
  maxSteps: number
  signal: AbortSignal
  directory?: string
}): Promise<PluginSession | undefined> {
  const { snapshot, config, context, signal } = input
  const directory = input.directory ?? snapshot.directory
  snapshot.directory = directory
  snapshot.context = context
  try {
    snapshot.sources ??= await new PluginVersions(directory).readEnabled(
      config.plugins?.enabled ?? []
    )
    if (snapshot.sources.length === 0) return undefined
    if (!snapshot.session || snapshot.session.closed) {
      if (snapshot.session) (snapshot.diagnostics ??= []).push(...snapshot.session.getDiagnostics())
      snapshot.state ??= new Map()
      snapshot.session = await PluginSession.create(snapshot.sources, {
        signal,
        state: new PluginState({ directory, memory: snapshot.state })
      })
    }
    if (!snapshot.started) {
      const result = await snapshot.session.dispatch(
        'runStart',
        context,
        { maxSteps: input.maxSteps },
        signal
      )
      if (result?.maxSteps !== undefined && result.maxSteps > input.maxSteps) {
        throw new PluginExecutionError(
          `Plugin maxSteps cannot exceed the host limit (${input.maxSteps})`
        )
      }
      snapshot.maxSteps = result?.maxSteps ?? input.maxSteps
      snapshot.started = true
    }
    return snapshot.session
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : String(error)
    if (error instanceof PluginExecutionError) throw error
    throw new PluginExecutionError(`Could not start plugins: ${snapshot.error}`, { cause: error })
  }
}

/** End observers run after the outcome is persisted; errors are reported without rewriting it. */
export async function finishPluginRun(snapshot: PluginRunSnapshot, status: string): Promise<void> {
  const { session, context } = snapshot
  try {
    if (session && !session.closed && context) await session.dispatch('runEnd', context, { status })
  } catch (error) {
    console.error('[yachiyo][plugins] runEnd failed', error)
  } finally {
    try {
      await recordPluginDiagnostics(snapshot, status)
    } catch (error) {
      console.error('[yachiyo][plugins] could not save diagnostics', error)
    }
    await session?.dispose()
    snapshot.session = undefined
  }
}

export async function compactWithPlugins(input: {
  session: PluginSession
  context: PluginContext
  event: PluginCompactInput
  signal: AbortSignal
  compact: (event: PluginCompactInput) => ModelMessage[] | Promise<ModelMessage[]>
}): Promise<PluginCompactInput> {
  const before = await input.session.dispatch(
    'beforeCompact',
    input.context,
    input.event,
    input.signal
  )
  let event = { ...input.event, ...before }
  if (event.kind === 'strip' && event.summary !== undefined) {
    throw new PluginExecutionError(
      'Strip compaction accepts messages; summary is only valid for handoff compaction'
    )
  }
  if (!event.skip) event = { ...event, messages: await input.compact(event) }
  const after = await input.session.dispatch('afterCompact', input.context, event, input.signal)
  return { ...event, ...after }
}

/** Resolves model choices on the host. Plugins receive names, never credentials or tool objects. */
export function createPluginModelHooks(input: {
  session: PluginSession
  context: PluginContext
  config: SettingsConfig
  signal: AbortSignal
  toolCount: number
}): Pick<ModelStreamRequest, 'prepareStep' | 'onStepEnd' | 'transformText' | 'compactMessages'> {
  const { session, context, config, signal } = input
  const availableModels = config.providers.flatMap((provider) =>
    provider.modelList.enabled.map((model) => ({
      providerName: provider.name,
      model
    }))
  )
  return {
    prepareStep: async ({ messages, stepNumber, settings, options }) => {
      const result = await session.dispatch(
        'beforeModel',
        context,
        {
          messages,
          stepNumber,
          options,
          model: { providerName: settings.providerName, model: settings.model },
          availableModels
        },
        signal
      )
      if (!result) return {}
      let selected = settings
      if (result.model) {
        const provider = config.providers.find(
          (provider) => provider.name === result.model!.providerName
        )
        if (!provider || !provider.modelList.enabled.includes(result.model.model)) {
          throw new PluginExecutionError(
            `Plugin selected a model that is not enabled: ${result.model.providerName}/${result.model.model}`
          )
        }
        selected = toResolvedProviderSettings(provider, result.model.model)!
      }
      return {
        messages: result.messages ?? messages,
        settings: selected,
        options: result.options ?? options
      }
    },
    onStepEnd: (event) => session.dispatch('afterStep', context, event, signal),
    transformText: async (text, stepNumber) => {
      const result = await session.dispatch('textDelta', context, { text, stepNumber }, signal)
      return result?.text ?? text
    },
    compactMessages: async (messages, thresholdTokens) => {
      const result = await compactWithPlugins({
        session,
        context,
        event: { kind: 'strip', messages, thresholdTokens },
        signal,
        compact: (event) =>
          applyStripCompact(event.messages, input.toolCount, undefined, event.thresholdTokens)
      })
      return result.messages
    }
  }
}
