import type { ProviderSettings } from '@yachiyo/shared/protocol'

export type MissingCredentialIssue =
  | 'missing-api-key'
  | 'missing-codex-session'
  | 'missing-vertex-project'

/**
 * Single source of truth for "can this provider authenticate at all".
 *
 * Not every provider uses an API key: Codex OAuth authenticates through the
 * Codex `auth.json` session, and Vertex through a project plus service account
 * or ADC. Checking `apiKey` alone rejects working providers, so every caller
 * that gates on credentials must go through here.
 */
export function resolveMissingCredentialIssue(
  settings: ProviderSettings
): MissingCredentialIssue | null {
  if (settings.provider === 'vertex') {
    return settings.project?.trim() ? null : 'missing-vertex-project'
  }

  if (settings.provider === 'openai-codex') {
    if (settings.apiKey.trim() || settings.codexSessionPath?.trim()) return null
    return 'missing-codex-session'
  }

  return settings.apiKey.trim() ? null : 'missing-api-key'
}

/** True when the provider has usable credentials and a model to run. */
export function hasUsableProviderSettings(settings: ProviderSettings): boolean {
  return Boolean(
    settings.providerName.trim() &&
    settings.model.trim() &&
    resolveMissingCredentialIssue(settings) === null
  )
}
