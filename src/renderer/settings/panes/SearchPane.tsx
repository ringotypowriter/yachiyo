import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { theme } from '@renderer/theme/theme'

import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  type SettingsConfig,
  type WebSearchBrowserImportSource
} from '../../../shared/yachiyo/protocol.ts'
import { SettingLabel, SettingRow, SettingSection, SimpleSelect } from '../components/primitives'
import { inputStyle } from '../components/styles'

interface SearchPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function SearchPane({ draft, onChange }: SearchPaneProps): React.ReactNode {
  const defaultProvider = draft.webSearch?.defaultProvider ?? DEFAULT_WEB_SEARCH_PROVIDER
  const browserSession = draft.webSearch?.browserSession
  const exaApiKey = draft.webSearch?.exa?.apiKey ?? ''
  const [importSources, setImportSources] = useState<WebSearchBrowserImportSource[]>([])
  const [selectedProfileName, setSelectedProfileName] = useState('')
  const [loadingSources, setLoadingSources] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

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
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Search Provider
            </div>
          </div>

          <SimpleSelect
            value={defaultProvider}
            options={[
              { value: 'google-browser', label: 'Google' },
              { value: 'exa', label: 'Exa' }
            ]}
            onChange={(v) =>
              onChange({
                ...draft,
                webSearch: { ...draft.webSearch, defaultProvider: v as typeof defaultProvider }
              })
            }
          />
        </SettingRow>
      </SettingSection>

      {defaultProvider === 'exa' && (
        <SettingSection>
          <SettingLabel>Exa</SettingLabel>

          <SettingRow>
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              API Key
            </div>
            <div className="relative flex items-center" style={{ width: 240 }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={exaApiKey}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    webSearch: {
                      ...draft.webSearch,
                      exa: { ...draft.webSearch?.exa, apiKey: e.target.value }
                    }
                  })
                }
                className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                style={inputStyle()}
                placeholder="your-exa-api-key"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2.5 shrink-0 opacity-40 hover:opacity-80 transition-opacity"
                aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
              >
                {showApiKey ? (
                  <EyeOff size={14} color={theme.icon.muted} />
                ) : (
                  <Eye size={14} color={theme.icon.muted} />
                )}
              </button>
            </div>
          </SettingRow>
        </SettingSection>
      )}

      <SettingSection>
        <div className="px-7 pt-5 pb-3">
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.12em] mb-2"
            style={{ color: theme.text.secondary }}
          >
            Browser Session
          </div>
          <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
            Hidden browser search keeps its own session. Import from Chrome to bootstrap cookies and
            consent state.
          </div>
        </div>

        <SettingRow>
          <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
            Chrome profile
          </div>
          <SimpleSelect
            value={selectedProfileName}
            options={
              profileOptions.length === 0
                ? [{ value: '', label: 'No Chrome profiles found' }]
                : profileOptions.map((p) => ({ value: p.profileName, label: p.profileName }))
            }
            onChange={setSelectedProfileName}
            width={180}
          />
        </SettingRow>

        <div className="px-7 py-3.5" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs" style={{ color: theme.text.tertiary }}>
              {browserSession?.importedAt
                ? `Last import: ${browserSession.sourceBrowser} / ${browserSession.sourceProfileName}`
                : 'No session imported yet.'}
            </span>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={!selectedProfileName || importing || loadingSources}
              className="inline-flex shrink-0 items-center gap-2 text-sm font-medium transition-opacity opacity-60 hover:opacity-100 disabled:opacity-20"
              style={{ color: theme.text.accent }}
            >
              {importing ? <Loader2 size={14} className="animate-spin" /> : null}
              Import from Chrome
            </button>
          </div>

          {error ? (
            <div className="mt-2 text-sm leading-5" style={{ color: theme.text.warning }}>
              {error}
            </div>
          ) : null}
        </div>
      </SettingSection>
    </div>
  )
}
