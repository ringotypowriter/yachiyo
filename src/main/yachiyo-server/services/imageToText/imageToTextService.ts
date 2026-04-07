/**
 * Public image-to-text description service.
 *
 * Calls a vision-capable model to generate a short alt-text description
 * of an image. Results are cached by content hash so the same image is
 * never described twice.
 *
 * Default model: aux (tool model). Override via settings.
 */

import { createHash } from 'node:crypto'

import type { ProviderSettings } from '../../../../shared/yachiyo/protocol.ts'
import { extractBase64DataUrlPayload } from '../../../../shared/yachiyo/messageContent.ts'
import type { AuxiliaryGenerationService } from '../../runtime/auxiliaryGeneration.ts'
import type { ModelMessage } from '../../runtime/types.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageToTextResult {
  imageHash: string
  altText: string
}

export interface ImageToTextService {
  /**
   * Describe an image. Returns cached result if available.
   * @param dataUrl - data:image/...;base64,... string
   * @param caption - optional surrounding text for context
   */
  describe(dataUrl: string, caption?: string): Promise<ImageToTextResult | null>
}

export interface ImageToTextServiceDeps {
  auxService: AuxiliaryGenerationService
  /** Resolve model settings for the image-to-text call. */
  resolveSettings: () => ProviderSettings
  /** DB-backed lookup by image hash. */
  lookupByHash?: (imageHash: string) => { imageHash: string; altText: string } | undefined
  /** Persist result to DB. */
  persist?: (imageHash: string, altText: string) => void
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(caption?: string): string {
  const parts = [
    'Describe the image in detail, in under 100 words.',
    '',
    'Rules:',
    '- Only describe what is visually present. Never infer, guess, or fabricate details that are not clearly visible.',
    '- If part of the image is unclear, blurry, or cut off, say so instead of guessing.',
    '- Do not identify real people by name. Describe their appearance instead.',
    '- Do not assume context, intent, or meaning beyond what the image literally shows.',
    '',
    'When describing, consider:',
    '- Category of the image (painting, landscape, portrait, CG, screenshot, meme, etc.)',
    '- How the image is structured and composed.',
    '',
    'If the image contains text, describe the image in the same language as the text. Preserve all text verbatim — do not summarize, paraphrase, or translate it. If text is partially illegible, transcribe only what is readable and mark the rest as unclear.',
    '',
    'If the image is a portrait or human related, include visible characteristics, expression, and activity.',
    '',
    'If this is a screenshot, describe the category and content of elements and texts in detail.'
  ]

  if (caption?.trim()) {
    parts.push('', `The image has the following caption: ${caption.trim()}`)
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Max concurrency for vision model calls. */
const MAX_CONCURRENCY = 3

export function createImageToTextService(deps: ImageToTextServiceDeps): ImageToTextService {
  const cache = new Map<string, ImageToTextResult>()
  const inflight = new Map<string, Promise<ImageToTextResult | null>>()

  let running = 0
  const queue: Array<() => void> = []

  function acquire(): Promise<void> {
    if (running < MAX_CONCURRENCY) {
      running++
      return Promise.resolve()
    }
    return new Promise((resolve) => queue.push(resolve))
  }

  function release(): void {
    running--
    const next = queue.shift()
    if (next) {
      running++
      next()
    }
  }

  async function callVisionModel(
    imageBase64: string,
    mediaType: string,
    caption?: string
  ): Promise<string> {
    const messages: ModelMessage[] = [
      { role: 'system', content: buildSystemPrompt(caption) },
      {
        role: 'user',
        content: [
          { type: 'text' as const, text: 'Describe this image.' },
          { type: 'image' as const, image: imageBase64, mediaType }
        ]
      }
    ]

    const result = await deps.auxService.generateText({
      messages,
      settingsOverride: deps.resolveSettings(),
      purpose: 'image-to-text'
    })

    if (result.status === 'success') {
      return result.text.trim()
    }

    console.warn(
      `[image-to-text] generation ${result.status}:`,
      'error' in result ? result.error : result.status
    )
    return ''
  }

  return {
    async describe(dataUrl, caption) {
      const payload = extractBase64DataUrlPayload(dataUrl)
      if (!payload) return null

      const hash = createHash('sha256').update(payload.base64).digest('hex')

      // L1: in-memory cache
      const cached = cache.get(hash)
      if (cached) return cached

      // L2: DB cache
      const dbCached = deps.lookupByHash?.(hash)
      if (dbCached) {
        const result: ImageToTextResult = {
          imageHash: dbCached.imageHash,
          altText: dbCached.altText
        }
        cache.set(hash, result)
        return result
      }

      // Dedup inflight
      const existing = inflight.get(hash)
      if (existing) return existing

      const task = (async (): Promise<ImageToTextResult | null> => {
        // Re-check caches after potential queue wait
        const memHit = cache.get(hash)
        if (memHit) return memHit
        const dbHit = deps.lookupByHash?.(hash)
        if (dbHit) {
          const r: ImageToTextResult = { imageHash: dbHit.imageHash, altText: dbHit.altText }
          cache.set(hash, r)
          return r
        }

        await acquire()
        try {
          // Re-check after acquiring semaphore
          const recheck = cache.get(hash)
          if (recheck) return recheck

          const altText = await callVisionModel(payload.base64, payload.mediaType, caption)
          if (!altText) return null

          const result: ImageToTextResult = { imageHash: hash, altText }
          cache.set(hash, result)
          deps.persist?.(hash, altText)
          return result
        } finally {
          release()
        }
      })()

      inflight.set(hash, task)
      task.finally(() => inflight.delete(hash))
      return task
    }
  }
}
