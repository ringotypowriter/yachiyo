import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

import { defaultRehypePlugins } from 'streamdown'
import { rehypeImageSrcTransform } from './imageRehypePlugin.ts'
import { YACHIYO_ASSET_SCHEME } from './imageUrl.ts'
import { createMarkdownRehypePlugins } from './markdownRehypePlugins.ts'

describe('createMarkdownRehypePlugins', () => {
  it('rewrites image sources before sanitize strips unsupported protocols', () => {
    const plugins = createMarkdownRehypePlugins({ basePath: '/Users/alice/project' })
    const imageTransformIndex = plugins.findIndex(
      (plugin) => Array.isArray(plugin) && plugin[0] === rehypeImageSrcTransform
    )
    const sanitizeIndex = plugins.findIndex(
      (plugin) => Array.isArray(plugin) && plugin[0] === defaultRehypePlugins.sanitize[0]
    )

    assert.equal(imageTransformIndex, 1)
    assert.equal(sanitizeIndex, 2)
  })

  it('allows rewritten local image and inline image protocols through sanitize', () => {
    const plugins = createMarkdownRehypePlugins({ basePath: '/Users/alice/project' })
    const sanitizeEntry = plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === defaultRehypePlugins.sanitize[0]
    )

    assert.ok(Array.isArray(sanitizeEntry))
    const schema = sanitizeEntry[1] as { protocols?: Record<string, string[]> }
    assert.equal(schema.protocols?.src?.includes(YACHIYO_ASSET_SCHEME), true)
    assert.equal(schema.protocols?.src?.includes('data'), true)
    assert.equal(schema.protocols?.href?.includes('magnet'), true)
  })
})
