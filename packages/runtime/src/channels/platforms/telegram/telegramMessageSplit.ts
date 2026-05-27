export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096

export function splitTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
    const newlineIndex = remaining.lastIndexOf('\n', TELEGRAM_MAX_MESSAGE_LENGTH - 1)
    const splitAt = newlineIndex > 0 ? newlineIndex + 1 : TELEGRAM_MAX_MESSAGE_LENGTH
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  if (remaining) {
    chunks.push(remaining)
  }

  return chunks
}
