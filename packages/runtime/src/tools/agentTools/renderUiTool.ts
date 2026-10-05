import { tool, type Tool } from 'ai'
import { z } from 'zod'
import { textContent, toToolModelOutput, type RenderUiToolOutput } from './shared.ts'

export const MAX_RENDER_UI_SOURCE_BYTES = 256 * 1024

export const renderUiInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160).describe('Short title for the inline UI.'),
    css: z.string().describe('Self-contained CSS; no external resources. May be empty.'),
    html: z
      .string()
      .refine((value) => value.trim().length > 0, 'HTML must not be blank.')
      .describe('HTML fragment, not a full document. No scripts or event attributes.'),
    js: z.string().describe('Self-contained JavaScript run only after completion. May be empty.')
  })
  .strict()
  .refine(
    ({ css, html, js }) =>
      Buffer.byteLength(css, 'utf8') +
        Buffer.byteLength(html, 'utf8') +
        Buffer.byteLength(js, 'utf8') <=
      MAX_RENDER_UI_SOURCE_BYTES,
    'Combined HTML, CSS and JavaScript must not exceed 256 KiB in UTF-8.'
  )

export type RenderUiToolInput = z.infer<typeof renderUiInputSchema>

export function runRenderUiTool(input: RenderUiToolInput): RenderUiToolOutput {
  const source = renderUiInputSchema.parse(input)
  return {
    content: textContent(`Rendered UI: ${source.title}`),
    details: { kind: 'renderUi', ...source },
    metadata: {}
  }
}

export function createTool(): Tool<RenderUiToolInput, RenderUiToolOutput> {
  return tool({
    description:
      'Render a self-contained interactive UI inline in native desktop chat. Use for requested calculators, visual explanations, charts and small interactive experiences. Supply title, css, html, then js for progressive preview. HTML is a fragment; use JavaScript event listeners rather than inline event attributes. No network, external libraries, Node or host access. Only completed UI runs JavaScript. Other clients show a title/source fallback. Read yachiyo-generative-ui for guidance when available.',
    inputSchema: renderUiInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input): Promise<RenderUiToolOutput> => runRenderUiTool(input)
  })
}
