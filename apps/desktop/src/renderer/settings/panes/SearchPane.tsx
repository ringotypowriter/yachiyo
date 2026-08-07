import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { theme } from '@renderer/theme/theme'

import type { SettingsConfig, WebSearchBrowserImportSource } from '@yachiyo/shared/protocol'
import { useT } from '@yachiyo/i18n/react'
import { SettingItem, SettingLabel, SettingSection, SimpleSelect } from '../components/primitives'
import { inputStyle } from '../components/styles'

interface SearchPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function SearchPane({ draft, onChange }: SearchPaneProps): React.ReactNode {
  const t = useT()
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

        setError(reason instanceof Error ? reason.message : t('settings.search.loadSourcesFailed'))
        setLoadingSources(false)
      })

    return () => {
      cancelled = true
    }
  }, [browserSession?.sourceProfileName, t])

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
      setError(reason instanceof Error ? reason.message : t('settings.search.importFailed'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>Exa</SettingLabel>

        <SettingItem
          label={t('settings.search.apiKey')}
          control={
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
                placeholder={t('settings.search.apiKeyPlaceholder')}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2.5 shrink-0 opacity-40 hover:opacity-80 transition-opacity"
                aria-label={
                  showApiKey ? t('settings.search.hideApiKey') : t('settings.search.showApiKey')
                }
              >
                {showApiKey ? (
                  <EyeOff size={14} color={theme.icon.muted} />
                ) : (
                  <Eye size={14} color={theme.icon.muted} />
                )}
              </button>
            </div>
          }
        />
      </SettingSection>

      <SettingSection>
        <SettingLabel description={t('settings.search.browserSessionDescription')}>
          {t('settings.search.browserSession')}
        </SettingLabel>

        <SettingItem
          label={t('settings.search.chromeProfile')}
          control={
            <SimpleSelect
              value={selectedProfileName}
              options={
                profileOptions.length === 0
                  ? [{ value: '', label: t('settings.search.noChromeProfiles') }]
                  : profileOptions.map((p) => ({ value: p.profileName, label: p.profileName }))
              }
              onChange={setSelectedProfileName}
              width={180}
            />
          }
        />

        <div className="px-7 py-3.5" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs" style={{ color: theme.text.tertiary }}>
              {browserSession?.importedAt
                ? t('settings.search.lastImport', {
                    browser: browserSession.sourceBrowser ?? '',
                    profile: browserSession.sourceProfileName ?? ''
                  })
                : t('settings.search.noSessionImported')}
            </span>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={!selectedProfileName || importing || loadingSources}
              className="inline-flex shrink-0 items-center gap-2 text-sm font-medium transition-opacity opacity-60 hover:opacity-100 disabled:opacity-20"
              style={{ color: theme.text.accent }}
            >
              {importing ? <Loader2 size={14} className="animate-spin" /> : null}
              {t('settings.search.importFromChrome')}
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
