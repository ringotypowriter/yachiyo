import { LinkSpan } from './LinkSpan'

const URL_RE = /https?:\/\/[^\s<>'")\]]+/g

/**
 * Splits plain text into an array of strings and clickable link elements
 * for every `http://` or `https://` URL found in the text.
 * Each link triggers the link safety modal before opening.
 */
export function linkifyText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(URL_RE)) {
    const url = match[0]
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
