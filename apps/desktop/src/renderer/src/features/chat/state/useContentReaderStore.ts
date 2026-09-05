import { create } from 'zustand'
import type { ReaderTarget } from '../lib/contentReader.ts'

interface ContentReaderState {
  target: ReaderTarget | null
  referenceEnabled: boolean
  open: (target: ReaderTarget) => void
  close: () => void
  clearReference: () => void
  selectDiffFile: (runId: string, relativePath: string | undefined) => void
}

export const useContentReaderStore = create<ContentReaderState>((set) => ({
  target: null,
  referenceEnabled: true,
  open: (target) => set({ target, referenceEnabled: true }),
  close: () => set({ target: null }),
  clearReference: () => set({ referenceEnabled: false }),
  selectDiffFile: (runId, relativePath) =>
    set((state) =>
      state.target?.kind === 'diff' && state.target.runId === runId
        ? { target: { ...state.target, relativePath } }
        : {}
    )
}))
