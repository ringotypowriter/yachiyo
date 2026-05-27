import type { UserDocument } from '@yachiyo/shared/protocol'

export async function loadUserDocument(): Promise<UserDocument> {
  return window.api.yachiyo.getUserDocument()
}

export async function persistUserDocument(content: string): Promise<UserDocument> {
  return window.api.yachiyo.saveUserDocument({ content })
}

export function hasPendingUserDocumentChanges(savedContent: string, draftContent: string): boolean {
  return savedContent !== draftContent
}
