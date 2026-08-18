import type { Plugin, PluggableList } from 'unified'
import { defaultRehypePlugins } from 'streamdown'
import { rehypeImageSrcTransform } from './imageRehypePlugin.ts'
import { YACHIYO_ASSET_SCHEME, type TransformImageSrcOptions } from './imageUrl.ts'
import {
  rehypeWorkspaceFileLinkTransform,
  WORKSPACE_FILE_REFERENCE_PROPERTY
} from './workspaceFileLinkRehypePlugin.ts'

type SanitizerSchema = Record<string, unknown> & {
  attributes?: Record<string, unknown[]>
  protocols?: Record<string, string[]>
}
type SanitizerPlugin = Plugin<[SanitizerSchema]>

export function createMarkdownRehypePlugins(
  imageOptions: TransformImageSrcOptions | null,
  workspaceFileReferences: readonly string[] = []
): PluggableList {
  const [sanitizeFn, sanitizeSchema] = defaultRehypePlugins.sanitize as [
    SanitizerPlugin,
    SanitizerSchema
  ]
  const extendedSchema = {
    ...sanitizeSchema,
    attributes:
      workspaceFileReferences.length > 0
        ? {
            ...sanitizeSchema.attributes,
            span: [...(sanitizeSchema.attributes?.span ?? []), WORKSPACE_FILE_REFERENCE_PROPERTY]
          }
        : sanitizeSchema.attributes,
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
  const workspaceFileLinkPlugins: PluggableList =
    workspaceFileReferences.length > 0
      ? [[rehypeWorkspaceFileLinkTransform, workspaceFileReferences]]
      : []
  const imagePlugins: PluggableList = imageOptions ? [[rehypeImageSrcTransform, imageOptions]] : []
  return [
    defaultRehypePlugins.raw,
    ...workspaceFileLinkPlugins,
    ...imagePlugins,
    [sanitizeFn, extendedSchema],
    defaultRehypePlugins.harden
  ]
}
