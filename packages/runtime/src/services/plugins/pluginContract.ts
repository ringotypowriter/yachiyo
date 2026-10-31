import { modelMessageSchema } from 'ai'
import { z } from 'zod'
import type { PluginHooks } from './pluginTypes.ts'

const messages = z.array(modelMessageSchema)
const summary = z.string().trim().min(1)
export const pluginModelOptionsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    stopSequences: z.array(z.string().min(1)).optional(),
    seed: z.number().int().optional(),
    reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
  })
  .strict()

export const pluginResultSchemas = {
  runStart: z.object({ maxSteps: z.number().int().positive().max(999).optional() }).strict(),
  beforeInput: z.object({ text: z.string() }).strict(),
  beforeModel: z
    .object({
      messages: messages.optional(),
      model: z
        .object({ providerName: z.string().min(1), model: z.string().min(1) })
        .strict()
        .optional(),
      options: pluginModelOptionsSchema.optional()
    })
    .strict(),
  afterStep: z
    .object({
      stop: z.boolean().optional(),
      messages: messages.optional(),
      compact: z.boolean().optional()
    })
    .strict(),
  textDelta: z.object({ text: z.string() }).strict(),
  beforeCompact: z
    .object({
      messages: messages.optional(),
      thresholdTokens: z.number().int().positive().optional(),
      summary: summary.optional(),
      skip: z.boolean().optional()
    })
    .strict(),
  afterCompact: z.object({ messages: messages.optional(), summary: summary.optional() }).strict(),
  beforeTool: z.object({ block: z.string().trim().min(1) }).strict(),
  afterTool: z.void(),
  runEnd: z.void()
} satisfies Record<keyof PluginHooks, z.ZodType>

export const PLUGIN_HOOK_NAMES = Object.keys(pluginResultSchemas) as Array<keyof PluginHooks>
