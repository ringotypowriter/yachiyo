import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { defaultRehypePlugins, Streamdown, type Components } from 'streamdown'
import { rehypeImageSrcTransform } from './imageRehypePlugin.ts'
import { YACHIYO_ASSET_SCHEME } from './imageUrl.ts'
import { createMarkdownRehypePlugins } from './markdownRehypePlugins.ts'
import {
  rehypeWorkspaceFileLinkTransform,
  WORKSPACE_FILE_REFERENCE_PROPERTY
} from './workspaceFileLinkRehypePlugin.ts'

type PluginTuple = readonly [unknown, ...unknown[]]

function isPluginTuple(plugin: unknown): plugin is PluginTuple {
  return Array.isArray(plugin)
}

const defaultSanitizePlugin = isPluginTuple(defaultRehypePlugins.sanitize)
  ? defaultRehypePlugins.sanitize[0]
  : defaultRehypePlugins.sanitize
const defaultRawPlugin = isPluginTuple(defaultRehypePlugins.raw)
  ? defaultRehypePlugins.raw[0]
  : defaultRehypePlugins.raw

describe('createMarkdownRehypePlugins', () => {
  it('rewrites image sources before sanitize strips unsupported protocols', () => {
    const plugins = createMarkdownRehypePlugins({ basePath: '/Users/alice/project' })
    const imageTransformIndex = plugins.findIndex(
      (plugin) => isPluginTuple(plugin) && plugin[0] === rehypeImageSrcTransform
    )
    const sanitizeIndex = plugins.findIndex(
      (plugin) => isPluginTuple(plugin) && plugin[0] === defaultSanitizePlugin
    )

    assert.notEqual(imageTransformIndex, -1)
    assert.notEqual(sanitizeIndex, -1)
    assert.equal(imageTransformIndex < sanitizeIndex, true)
  })

  it('allows rewritten local image and inline image protocols through sanitize', () => {
    const plugins = createMarkdownRehypePlugins({ basePath: '/Users/alice/project' })
    const sanitizeEntry = plugins.find(
      (plugin) => isPluginTuple(plugin) && plugin[0] === defaultSanitizePlugin
    )

    assert.ok(isPluginTuple(sanitizeEntry))
    const schema = sanitizeEntry[1] as { protocols?: Record<string, string[]> }
    assert.equal(schema.protocols?.src?.includes(YACHIYO_ASSET_SCHEME), true)
    assert.equal(schema.protocols?.src?.includes('data'), true)
    assert.equal(schema.protocols?.href?.includes('magnet'), true)
  })

  it('protects resolved workspace links before harden and preserves their marker', () => {
    const plugins = createMarkdownRehypePlugins({ basePath: '/Users/alice/project' }, [
      'artifact.md'
    ])
    const workspaceLinkIndex = plugins.findIndex(
      (plugin) => isPluginTuple(plugin) && plugin[0] === rehypeWorkspaceFileLinkTransform
    )
    const rawIndex = plugins.findIndex((plugin) =>
      isPluginTuple(plugin) ? plugin[0] === defaultRawPlugin : plugin === defaultRawPlugin
    )
    const sanitizeIndex = plugins.findIndex(
      (plugin) => isPluginTuple(plugin) && plugin[0] === defaultSanitizePlugin
    )
    const sanitizeEntry = plugins[sanitizeIndex]

    assert.notEqual(workspaceLinkIndex, -1)
    assert.notEqual(rawIndex, -1)
    assert.notEqual(sanitizeIndex, -1)
    assert.equal(rawIndex < workspaceLinkIndex, true)
    assert.equal(workspaceLinkIndex < sanitizeIndex, true)
    assert.ok(isPluginTuple(sanitizeEntry))
    const schema = sanitizeEntry[1] as { attributes?: Record<string, unknown[]> }
    assert.equal(schema.attributes?.span?.includes(WORKSPACE_FILE_REFERENCE_PROPERTY), true)
  })

  it('replaces the exact blocked artifact output after workspace resolution', () => {
    const markdown = '[下载 pi-agent-compact-prompt.md](<pi-agent-compact-prompt.md>)'
    const unresolvedHtml = renderToStaticMarkup(
      React.createElement(
        Streamdown,
        { mode: 'static', rehypePlugins: createMarkdownRehypePlugins(null) },
        markdown
      )
    )
    const passthroughSpan: Components['span'] = ({ node, ...props }) => {
      void node
      return React.createElement('span', props)
    }
    const resolvedHtml = renderToStaticMarkup(
      React.createElement(
        Streamdown,
        {
          mode: 'static',
          rehypePlugins: createMarkdownRehypePlugins(null, ['pi-agent-compact-prompt.md']),
          components: { span: passthroughSpan }
        },
        markdown
      )
    )

    assert.match(unresolvedHtml, /\[blocked\]/)
    assert.doesNotMatch(resolvedHtml, /\[blocked\]/)
    assert.match(
      resolvedHtml,
      /data-yachiyo-workspace-file-reference="pi-agent-compact-prompt\.md"/
    )
  })

  it('protects resolved workspace links whose href is percent-encoded by rehype', () => {
    const markdown = ['[中文工件](提示词.md)', '[spaced artifact](<my file.md>)'].join('\n')
    const passthroughSpan: Components['span'] = ({ node, ...props }) => {
      void node
      return React.createElement('span', props)
    }
    const resolvedHtml = renderToStaticMarkup(
      React.createElement(
        Streamdown,
        {
          mode: 'static',
          rehypePlugins: createMarkdownRehypePlugins(null, ['提示词.md', 'my file.md']),
          components: { span: passthroughSpan }
        },
        markdown
      )
    )

    assert.doesNotMatch(resolvedHtml, /\[blocked\]/)
    assert.match(resolvedHtml, /data-yachiyo-workspace-file-reference="提示词\.md"/)
    assert.match(resolvedHtml, /data-yachiyo-workspace-file-reference="my file\.md"/)
  })

  it('preserves reserved filename characters and nested separators through Streamdown', () => {
    const markdown = [
      '[hash](<notes#1.md>)',
      '[query](<notes?1.md>)',
      '[nested](docs/guide.md)'
    ].join('\n')
    const passthroughSpan: Components['span'] = ({ node, ...props }) => {
      void node
      return React.createElement('span', props)
    }
    const resolvedHtml = renderToStaticMarkup(
      React.createElement(
        Streamdown,
        {
          mode: 'static',
          rehypePlugins: createMarkdownRehypePlugins(null, [
            'notes#1.md',
            'notes?1.md',
            'docs/guide.md'
          ]),
          components: { span: passthroughSpan }
        },
        markdown
      )
    )

    assert.doesNotMatch(resolvedHtml, /\[blocked\]/)
    assert.match(resolvedHtml, /data-yachiyo-workspace-file-reference="notes#1\.md"/)
    assert.match(resolvedHtml, /data-yachiyo-workspace-file-reference="notes\?1\.md"/)
    assert.match(resolvedHtml, /data-yachiyo-workspace-file-reference="docs\/guide\.md"/)
  })
})
