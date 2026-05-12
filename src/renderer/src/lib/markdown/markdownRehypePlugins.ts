import type { Plugin, PluggableList } from 'unified'
import { defaultRehypePlugins } from 'streamdown'
import { rehypeImageSrcTransform } from './imageRehypePlugin.ts'
import { YACHIYO_ASSET_SCHEME, type TransformImageSrcOptions } from './imageUrl.ts'

type SanitizerSchema = Record<string, unknown> & { protocols?: Record<string, string[]> }
type SanitizerPlugin = Plugin<[SanitizerSchema]>

export function createMarkdownRehypePlugins(
  imageOptions: TransformImageSrcOptions | null
): PluggableList {
  const [sanitizeFn, sanitizeSchema] = defaultRehypePlugins.sanitize as [
    SanitizerPlugin,
    SanitizerSchema
  ]
  const extendedSchema = {
    ...sanitizeSchema,
    protocols: {
      ...sanitizeSchema.protocols,
      href: [...(sanitizeSchema.protocols?.href ?? []), 'magnet'],
      ...(imageOptions
        ? {
            src: [...(sanitizeSchema.protocols?.src ?? []), YACHIYO_ASSET_SCHEME, 'data']
          }
        : {})
    }
  }
  const imagePlugins: PluggableList = imageOptions ? [[rehypeImageSrcTransform, imageOptions]] : []
  return [
    defaultRehypePlugins.raw,
    ...imagePlugins,
    [sanitizeFn, extendedSchema],
    defaultRehypePlugins.harden
  ]
}
