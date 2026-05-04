export interface TranslateInput {
  text: string
  targetLanguage: string
}

export type TranslateResult =
  | { status: 'success'; translatedText: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string }

// ── Jotdown ──────────────────────────────────────────────────────────
