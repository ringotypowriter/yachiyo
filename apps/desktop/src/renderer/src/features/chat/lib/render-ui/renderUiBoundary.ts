export type RenderUiOutput =
  | { type: 'height'; height: number }
  | { type: 'openLink'; url: string }
  | { type: 'continueConversation'; text: string }
  | { type: 'error'; message: string }

export const MAX_RENDER_UI_INLINE_HEIGHT = 1600

export function appendConfirmedRenderUiText<T extends { text: string }>(
  drafts: Record<string, T>,
  key: string,
  text: string,
  emptyDraft: T
): Record<string, T> {
  const draft = drafts[key] ?? emptyDraft
  return { ...drafts, [key]: { ...draft, text: [draft.text, text].filter(Boolean).join('\n') } }
}

export function parseRenderUiOutput(value: unknown): RenderUiOutput | null {
  if (!value || typeof value !== 'object' || !('type' in value)) return null
  if (value.type === 'height' && 'height' in value && typeof value.height === 'number') {
    if (!Number.isFinite(value.height)) return null
    return {
      type: 'height',
      height: Math.max(160, Math.min(MAX_RENDER_UI_INLINE_HEIGHT, value.height))
    }
  }
  if (value.type === 'openLink' && 'url' in value && typeof value.url === 'string') {
    if (value.url.length > 2048) return null
    try {
      const url = new URL(value.url)
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? { type: 'openLink', url: value.url }
        : null
    } catch {
      return null
    }
  }
  if (value.type === 'continueConversation' && 'text' in value && typeof value.text === 'string') {
    return value.text.length > 0 && value.text.length <= 8192
      ? { type: 'continueConversation', text: value.text }
      : null
  }
  if (value.type === 'error' && 'message' in value && typeof value.message === 'string') {
    return value.message.length <= 1024 ? { type: 'error', message: value.message } : null
  }
  return null
}
