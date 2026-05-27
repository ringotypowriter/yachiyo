export interface JotdownMeta {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
}

export interface JotdownFull extends JotdownMeta {
  content: string
}

export interface JotdownSaveInput {
  id: string
  content: string
}

// ── Performance Statistics ────────────────────────────────────────────
