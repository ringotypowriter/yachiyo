import { createHash } from 'node:crypto'
import type {
  BrowserAutomationSessionRecord,
  OpenBrowserPreviewInput
} from '@yachiyo/shared/protocol'
import type { BrowserAutomationService } from '@yachiyo/runtime/services/browserAutomation/electronBrowserAutomationService'

export async function openBrowserPreview(
  backend: Pick<BrowserAutomationService, 'openPreview' | 'listSessions'>,
  input: OpenBrowserPreviewInput
): Promise<BrowserAutomationSessionRecord> {
  if (!input.threadId?.trim()) throw new Error('A conversation is required for web preview.')
  const url = new URL(input.url)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS pages can be previewed.')
  }
  const session = input.session ?? `preview-${createHash('sha256').update(url.href).digest('hex')}`
  const existing = backend.listSessions(input).find((entry) => entry.session === session)
  if (existing) return existing
  if (!/^preview-[a-f0-9]{64}$/.test(session))
    throw new Error('The shared browser session is no longer available.')
  await backend.openPreview({
    threadId: input.threadId,
    session,
    url: url.href,
    reading: input.reading
  })
  const opened = backend.listSessions(input).find((entry) => entry.session === session)
  if (!opened) throw new Error('Unable to open web preview.')
  return opened
}
