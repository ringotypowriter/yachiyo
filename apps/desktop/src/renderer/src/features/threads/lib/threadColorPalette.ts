import { t } from '@yachiyo/i18n/index'
import type { ThreadColorTag } from '@yachiyo/shared/protocol'

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

export function threadColorFilterLabel(colorTag: ThreadColorTag): string {
  return t(`threads.colors.${colorTag}`)
}

export function threadColorMarkLabel(colorTag: ThreadColorTag | null): string {
  return t('threads.colors.markIt', {
    color: colorTag === null ? t('common.default') : threadColorFilterLabel(colorTag)
  })
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
