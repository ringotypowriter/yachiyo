import type { BrowserSearchDiagnosticEvent } from '@yachiyo/runtime/services/webSearch/electronBrowserSearchSession'

export function logBrowserSearchDiagnostic(event: BrowserSearchDiagnosticEvent): void {
  const details = {
    profilePath: event.profilePath,
    ...(event.url ? { url: event.url } : {}),
    ...(event.code !== undefined ? { code: String(event.code) } : {}),
    ...(event.details ?? {})
  }
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

  console.warn(`[web-search] ${event.event}${suffix ? ` ${suffix}` : ''}`)
}
