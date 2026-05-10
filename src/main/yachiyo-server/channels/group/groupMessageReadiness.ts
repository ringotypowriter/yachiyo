import type { GroupMessageEntry, MessageImageRecord } from '../../../../shared/yachiyo/protocol.ts'

export function hasPendingImageDescription(entry: GroupMessageEntry): boolean {
  return entry.imageDescriptionPending === true
}

export function getDescribedImages(entry: GroupMessageEntry): MessageImageRecord[] {
  return (entry.images ?? []).filter((image) => image.altText?.trim())
}

export function hasGroupProbeVisibleContent(entry: GroupMessageEntry): boolean {
  return entry.text.trim().length > 0 || getDescribedImages(entry).length > 0
}
