import { createContext, useContext } from 'react'

export interface ReaderActions {
  openFile: (path: string) => boolean
  openImage: (src: string, alt?: string, path?: string) => void
  openDiff: (input: { runId: string; threadId: string; workspacePath: string }) => void
}
export const ReaderContext = createContext<ReaderActions | null>(null)

export function useContentReader(): ReaderActions | null {
  return useContext(ReaderContext)
}
