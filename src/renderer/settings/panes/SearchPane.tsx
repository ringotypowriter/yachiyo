import { Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { theme } from '@renderer/theme/theme'

import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  type SettingsConfig,
  type WebSearchBrowserImportSource
} from '../../../shared/yachiyo/protocol.ts'
import { settingsPanelStyle } from '../components/styles'

interface SearchPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function SearchPane({ draft, onChange }: SearchPaneProps): React.ReactNode {
  const defaultProvider = draft.webSearch?.defaultProvider ?? DEFAULT_WEB_SEARCH_PROVIDER
  const browserSession = draft.webSearch?.browserSession
  const [importSources, setImportSources] = useState<WebSearchBrowserImportSource[]>([])
  const [selectedProfileName, setSelectedProfileName] = useState('')
  const [loadingSources, setLoadingSources] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void window.api.yachiyo
      .listWebSearchBrowserImportSources()
      .then((sources) => {
        if (cancelled) {
          return
        }

        setImportSources(sources)
        setSelectedProfileName(
          (current) => current || browserSession?.sourceProfileName || sources[0]?.profileName || ''
        )
        setLoadingSources(false)
      })
      .catch((reason) => {
        if (cancelled) {
          return
        }

        setError(
          reason instanceof Error ? reason.message : 'Failed to load browser import sources.'
        )
        setLoadingSources(false)
      })

    return () => {
      cancelled = true
    }
  }, [browserSession?.sourceProfileName])

  const profileOptions = useMemo(
    () => importSources.filter((source) => source.browserId === 'google-chrome'),
    [importSources]
  )

  const handleImport = async (): Promise<void> => {
    if (!selectedProfileName || importing) {
      return
    }

    setImporting(true)
    setError(null)

    try {
      const nextConfig = await window.api.yachiyo.importWebSearchBrowserSession({
        sourceBrowser: 'google-chrome',
        sourceProfileName: selectedProfileName
      })
      onChange(nextConfig)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to import Chrome session.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl space-y-4">
        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: theme.text.muted }}
          >
            Search
          </div>

          <div
            className="mt-3 flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
            style={{
              background: theme.background.surfaceLight,
              border: `1px solid ${theme.border.default}`
            }}
          >
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                Default search provider
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                Browser-backed now. API-backed providers can join this picker later.
              </div>
            </div>

            <select
              value={defaultProvider}
              onChange={(event) =>
                onChange({
                  ...draft,
                  webSearch: {
                    ...draft.webSearch,
                    defaultProvider: event.target.value as typeof defaultProvider
                  }
                })
              }
              className="rounded-xl px-3 py-2 text-sm"
              style={{
                background: theme.background.surfaceSoft,
                border: `1px solid ${theme.border.panel}`,
                color: theme.text.primary
              }}
            >
              <option value="google-browser">Google (browser-backed)</option>
            </select>
          </div>
        </section>

        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: theme.text.muted }}
          >
            Browser session
          </div>

          <div
            className="mt-3 rounded-2xl px-4 py-3 space-y-3"
            style={{
              background: theme.background.surfaceLight,
              border: `1px solid ${theme.border.default}`
            }}
          >
            <div className="space-y-1">
              <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                Independent retained profile
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                Hidden browser search keeps its own session. Import from Chrome to bootstrap cookies
                and consent state.
              </div>
            </div>

            <div className="flex items-center gap-3">
              <select
                value={selectedProfileName}
                onChange={(event) => setSelectedProfileName(event.target.value)}
                disabled={loadingSources || profileOptions.length === 0}
                className="min-w-45 rounded-xl px-3 py-2 text-sm"
                style={{
                  background: theme.background.surfaceSoft,
                  border: `1px solid ${theme.border.panel}`,
                  color: theme.text.primary
                }}
              >
                {profileOptions.length === 0 ? (
                  <option value="">No Chrome profiles found</option>
                ) : (
                  profileOptions.map((profile) => (
                    <option key={profile.profileName} value={profile.profileName}>
                      {profile.profileName}
                    </option>
                  ))
                )}
              </select>

              <button
                type="button"
                onClick={() => void handleImport()}
                disabled={!selectedProfileName || importing || loadingSources}
                className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium disabled:opacity-40"
                style={{
                  background: theme.background.accentSurface,
                  color: theme.text.accent
                }}
              >
                {importing ? <Loader2 size={14} className="animate-spin" /> : null}
                Import from Chrome
              </button>
            </div>

            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {browserSession?.importedAt
                ? `Last import: ${browserSession.sourceBrowser} / ${browserSession.sourceProfileName} at ${browserSession.importedAt}`
                : 'No browser session imported yet.'}
            </div>

            {error ? (
              <div className="text-sm leading-5" style={{ color: theme.text.warning }}>
                {error}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
