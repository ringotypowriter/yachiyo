import type { BrowserActivitySession } from './browserActivity'

export function getBrowserSessionLabel(session: BrowserActivitySession): string {
  return session.title?.trim() || session.session
}
