import type { GroupMessageEntry, MessageImageRecord } from '@yachiyo/shared/protocol'

export function hasPendingGroupContent(entry: GroupMessageEntry): boolean {
  return entry.enrichmentPending === true
}

export function getDescribedImages(entry: GroupMessageEntry): MessageImageRecord[] {
  return (entry.images ?? []).filter((image) => image.altText?.trim())
}

export function hasGroupProbeVisibleContent(entry: GroupMessageEntry): boolean {
  return (
    entry.text.trim().length > 0 ||
    getDescribedImages(entry).length > 0 ||
    (entry.imageDescriptionDeferred === true && (entry.images?.length ?? 0) > 0)
  )
}
