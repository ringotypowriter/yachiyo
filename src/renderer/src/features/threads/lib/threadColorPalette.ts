import type { ThreadColorTag } from '../../../../../shared/yachiyo/protocol.ts'

export const THREAD_COLOR_TAGS: ThreadColorTag[] = [
  'coral',
  'azure',
  'emerald',
  'amethyst',
  'slate'
]

export const THREAD_COLOR_VALUES: Record<ThreadColorTag, string> = {
  coral: '#E25D5D',
  azure: '#4A90D9',
  emerald: '#3CB371',
  amethyst: '#9B72CF',
  slate: '#708090'
}

export const THREAD_COLOR_LABELS: Record<ThreadColorTag, string> = {
  coral: 'Mark it Coral',
  azure: 'Mark it Azure',
  emerald: 'Mark it Emerald',
  amethyst: 'Mark it Amethyst',
  slate: 'Mark it Slate'
}

export function resolveThreadColor(
  colorTag: ThreadColorTag | null | undefined,
  fallback: string
): string {
  return colorTag ? THREAD_COLOR_VALUES[colorTag] : fallback
}

export function resolveThreadTitleColor(input: {
  colorTag: ThreadColorTag | null | undefined
  fallback: string
  isInFolder: boolean
}): string {
  return input.isInFolder ? input.fallback : resolveThreadColor(input.colorTag, input.fallback)
}
