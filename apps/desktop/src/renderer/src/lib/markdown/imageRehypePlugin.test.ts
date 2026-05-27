import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

import { buildAssetUrl } from './imageUrl.ts'
import { rewriteImageSourcesForHarden } from './imageRehypePlugin.ts'

describe('rewriteImageSourcesForHarden', () => {
  it('rewrites direct workspace image sources before rehype-harden runs', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'img',
          properties: {
            src: 'paper-workspace/Figure%201.png',
            alt: 'Figure 1'
          },
          children: []
        }
      ]
    }

    rewriteImageSourcesForHarden(tree, { basePath: '/Users/alice/project' })

    assert.equal(
      tree.children[0].properties.src,
      buildAssetUrl('/Users/alice/project/paper-workspace/Figure 1.png')
    )
  })

  it('rewrites local file image sources before rehype-harden runs', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'img',
          properties: {
            src: 'file:///Users/alice/Figure%201.png',
            alt: 'Figure 1'
          },
          children: []
        }
      ]
    }

    rewriteImageSourcesForHarden(tree)

    assert.equal(tree.children[0].properties.src, buildAssetUrl('/Users/alice/Figure 1.png'))
  })

  it('leaves unsafe image sources unchanged for the security pass to block', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'img',
          properties: {
            src: 'javascript:alert(1)'
          },
          children: []
        }
      ]
    }

    rewriteImageSourcesForHarden(tree)

    assert.equal(tree.children[0].properties.src, 'javascript:alert(1)')
  })

  it('removes rejected direct workspace image sources before hardening can reinterpret them', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'img',
          properties: {
            src: '../../Users/alice/private.png',
            alt: 'Private'
          },
          children: []
        }
      ]
    }

    rewriteImageSourcesForHarden(tree, { basePath: '/Users/alice/project' })

    assert.equal(tree.children[0].properties.src, undefined)
  })
})
