import { modelMessageSchema } from 'ai'
import { z } from 'zod'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { PluginSession } from './pluginSession.ts'
import { PluginState } from './pluginState.ts'
import { pluginModelOptionsSchema } from './pluginContract.ts'
import type {
  PluginContext,
  PluginDescriptor,
  PluginEventMap,
  PluginHooks,
  PluginSource
} from './pluginTypes.ts'

const messages = z.array(modelMessageSchema)
const compact = z
  .object({
    kind: z.enum(['strip', 'handoff']),
    messages,
    thresholdTokens: z.number().positive().optional(),
    summary: z.string().optional(),
    skip: z.boolean().optional()
  })
  .strict()
const toolCall = z
  .object({ toolName: z.string(), toolCallId: z.string(), input: z.unknown() })
  .strict()
const eventSchemas = {
  runStart: z.object({ maxSteps: z.number().int().positive().max(999) }).strict(),
  beforeInput: z.object({ text: z.string() }).strict(),
  beforeModel: z
    .object({
      messages,
      stepNumber: z.number().int().nonnegative(),
      options: pluginModelOptionsSchema.optional(),
      model: z.object({ providerName: z.string(), model: z.string() }).optional()
    })
    .strict(),
  afterStep: z
    .object({
      stepNumber: z.number().int().nonnegative(),
      messages,
      text: z.string(),
      finishReason: z.string(),
      usage: z
        .object({
          promptTokens: z.number().nonnegative(),
          completionTokens: z.number().nonnegative()
        })
        .strict()
    })
    .strict(),
  textDelta: z.object({ text: z.string(), stepNumber: z.number().int().nonnegative() }).strict(),
  beforeCompact: compact,
  afterCompact: compact,
  beforeTool: toolCall,
  afterTool: z.discriminatedUnion('status', [
    toolCall.extend({ status: z.literal('success'), output: z.unknown() }),
    toolCall.extend({ status: z.literal('error'), error: z.string() })
  ]),
  runEnd: z.object({ status: z.string() }).strict()
} satisfies Record<keyof PluginHooks, z.ZodType>

const fixtureSchema = z
  .object({
    context: z
      .object({
        runId: z.string(),
        threadId: z.string(),
        workspacePath: z.string(),
        runMode: z.enum(['auto', 'code', 'explore', 'plan', 'chat', 'custom'])
      })
      .strict()
      .optional(),
    events: z
      .array(
        z
          .object({
            hook: z.enum(
              Object.keys(eventSchemas) as [keyof PluginHooks, ...Array<keyof PluginHooks>]
            ),
            event: z.unknown()
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict()

export interface PluginTrialReport {
  plugins: PluginDescriptor[]
  events: Array<{ hook: keyof PluginHooks; result?: unknown; durationMs: number }>
}

/** Runs supplied events without calling providers/tools or writing managed persistent state. */
export async function trialPlugins(
  sources: PluginSource[],
  fixture: unknown,
  config: SettingsConfig
): Promise<PluginTrialReport> {
  const parsed = fixtureSchema.parse(fixture)
  const context: PluginContext = {
    runId: 'trial',
    threadId: 'trial',
    workspacePath: process.cwd(),
    runMode: 'auto',
    ...parsed.context,
    purpose: 'trial'
  }
  const events = parsed.events.map(({ hook, event }) => ({
    hook,
    event: eventSchemas[hook].parse(event)
  }))
  const session = await PluginSession.create(sources, {
    state: new PluginState({ ephemeral: true })
  })
  const report: PluginTrialReport = { plugins: session.descriptors, events: [] }
  const availableModels = config.providers.flatMap((provider) =>
    provider.modelList.enabled.map((model) => ({ providerName: provider.name, model }))
  )
  try {
    for (const { hook, event } of events) {
      const started = performance.now()
      const input =
        hook === 'beforeModel'
          ? {
              ...event,
              availableModels,
              model: ('model' in event ? event.model : undefined) ?? availableModels[0]
            }
          : event
      const result = await session.dispatch(hook, context, input as PluginEventMap[typeof hook])
      if (
        hook === 'runStart' &&
        result &&
        'maxSteps' in result &&
        result.maxSteps !== undefined &&
        'maxSteps' in event &&
        result.maxSteps > event.maxSteps
      ) {
        throw new Error(`Plugin maxSteps cannot exceed the host limit (${event.maxSteps})`)
      }
      if (hook === 'beforeModel' && result && 'model' in result && result.model) {
        const selected = result.model
        if (
          !config.providers.some(
            (provider) =>
              provider.name === selected.providerName &&
              provider.modelList.enabled.includes(selected.model)
          )
        ) {
          throw new Error(
            `Plugin selected a model that is not enabled: ${selected.providerName}/${selected.model}`
          )
        }
      }
      report.events.push({
        hook,
        ...(result !== undefined ? { result } : {}),
        durationMs: Math.round(performance.now() - started)
      })
    }
    return report
  } finally {
    await session.dispose()
  }
}
