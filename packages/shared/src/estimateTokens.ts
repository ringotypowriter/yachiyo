/** CJK ideographs, Hangul, Hiragana, Katakana, and full-width forms. */
const CJK_RE =
  /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/gu

/**
 * Conservative (lower-bound) token count for a piece of text.
 * CJK chars are counted as 1 token each (most tokenizers use 1 per char).
 * Latin / ascii chars are counted as 1 token per 4 characters.
 */
export function estimateTextTokens(text: string): number {
  const cjkChars = text.match(CJK_RE)?.length ?? 0
  const otherChars = text.length - cjkChars
  return cjkChars + otherChars / 4
}
