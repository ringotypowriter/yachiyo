import { findAutolinkCandidates, splitAutolinkCandidate } from './autolinkTextBoundary'
import { LinkSpan } from './LinkSpan'

/**
 * Splits plain text into an array of strings and clickable link elements
 * for every `http://` or `https://` URL found in the text.
 * Each link triggers the link safety modal before opening.
 */
export function linkifyText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let lastIndex = 0

  for (const match of findAutolinkCandidates(text)) {
    const split = splitAutolinkCandidate(match[0])
    if (!split) continue

    const url = split.url
    const start = match.index!

    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start))
    }

    parts.push(<LinkSpan key={start} url={url} />)

    lastIndex = start + url.length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}
