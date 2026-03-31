import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MemoryTermDocument, SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { theme } from '@renderer/theme/theme'
import { SettingRow, SettingSection, SettingSwitch, SimpleSelect } from '../components/primitives'
import { inputStyle } from '../components/styles'
import { loadMemoryTermDocument } from './memoryTermDocumentModel'

export interface MemoryPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function MemoryPane({ draft, onChange }: MemoryPaneProps): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [view, setView] = useState<'overview' | 'terms'>('overview')
  const [memoryTermDocument, setMemoryTermDocument] = useState<MemoryTermDocument | null>(null)
  const [isLoadingTerms, setIsLoadingTerms] = useState(false)
  const [hasAttemptedTermsLoad, setHasAttemptedTermsLoad] = useState(false)
  const [termsError, setTermsError] = useState<string | null>(null)
  const memory = draft.memory ?? {
    enabled: false,
    provider: 'nowledge-mem',
    baseUrl: 'http://127.0.0.1:14242'
  }
  const provider = memory.provider ?? 'nowledge-mem'
  const showsBuiltinTerms = provider === 'builtin-memory'
  const showsNowledgeSettings = provider === 'nowledge-mem'

  useEffect(() => {
    setTestResult(null)
  }, [draft])

  useEffect(() => {
    if (provider === 'builtin-memory') {
      return
    }

    setView('overview')
    setMemoryTermDocument(null)
    setHasAttemptedTermsLoad(false)
    setTermsError(null)
  }, [provider])

  useEffect(() => {
    if (
      view !== 'terms' ||
      provider !== 'builtin-memory' ||
      memoryTermDocument ||
      isLoadingTerms ||
      hasAttemptedTermsLoad
    ) {
      return
    }

    let cancelled = false
    setIsLoadingTerms(true)
    setHasAttemptedTermsLoad(true)
    setTermsError(null)

    void loadMemoryTermDocument(draft)
      .then((document) => {
        if (!cancelled) {
          setMemoryTermDocument(document)
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setTermsError(
            reason instanceof Error ? reason.message : 'Failed to load built-in memory terms.'
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTerms(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [draft, hasAttemptedTermsLoad, isLoadingTerms, memoryTermDocument, provider, view])

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)

    try {
      const result = await window.api.yachiyo.testMemoryConnection({ config: draft })
      setTestResult(result)
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Memory connection test failed.'
      })
    } finally {
      setTesting(false)
    }
  }

  if (view === 'terms') {
    const topics = memoryTermDocument?.topics ?? []

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-7 pt-5 pb-4">
          <button
            type="button"
            className="text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => {
              setView('overview')
              setHasAttemptedTermsLoad(false)
              setMemoryTermDocument(null)
            }}
          >
            ← Memory
          </button>
          <div className="mt-1 text-lg font-semibold" style={{ color: theme.text.primary }}>
            Memory terms
          </div>
          <div className="mt-0.5 text-sm leading-5" style={{ color: theme.text.tertiary }}>
            Built-in memory grouped by topic. This is a read-only view of what long-term memory has
            already stored.
          </div>
          {memoryTermDocument ? (
            <div className="mt-0.5 text-xs leading-5" style={{ color: theme.text.muted }}>
              {memoryTermDocument.memoryCount} terms across {memoryTermDocument.topicCount} topics
            </div>
          ) : null}
        </div>

        {isLoadingTerms ? (
          <div className="px-7 text-sm" style={{ color: theme.text.muted }}>
            Loading memory terms...
          </div>
        ) : (
          <>
            {topics.length > 0 ? (
              <div style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
                {topics.map((topic) => (
                  <div
                    key={topic.topic}
                    className="px-7 py-4"
                    style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
                  >
                    <div className="flex items-baseline justify-between gap-4">
                      <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                        {topic.topic}
                      </div>
                      <div className="text-xs" style={{ color: theme.text.muted }}>
                        {topic.entryCount} {topic.entryCount === 1 ? 'term' : 'terms'}
                      </div>
                    </div>

                    <div className="mt-3 space-y-3">
                      {topic.entries.map((entry) => (
                        <div key={entry.id} className="space-y-1">
                          <div
                            className="text-sm font-medium"
                            style={{ color: theme.text.primary }}
                          >
                            {entry.title}
                          </div>
                          <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                            {entry.content}
                          </div>
                          <div className="text-xs leading-5" style={{ color: theme.text.muted }}>
                            {entry.unitType}
                            {typeof entry.importance === 'number'
                              ? ` · importance ${entry.importance}`
                              : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-7 py-3 text-sm" style={{ color: theme.text.muted }}>
                No built-in memory terms yet.
              </div>
            )}

            {termsError ? (
              <div className="px-7 pb-3 text-sm" style={{ color: theme.text.warning }}>
                {termsError}
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Enable memory
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Pull recalled context into runs and allow explicit thread saves.
            </div>
          </div>
          <div className="shrink-0">
            <SettingSwitch
              checked={memory.enabled === true}
              onChange={() =>
                onChange({ ...draft, memory: { ...memory, enabled: !memory.enabled } })
              }
              ariaLabel="Toggle memory"
            />
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Provider
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Memory backend for recall, distillation, and thread saves.
            </div>
          </div>
          <SimpleSelect
            value={memory.provider ?? 'nowledge-mem'}
            options={[
              { value: 'builtin-memory', label: 'Built-in SQLite' },
              { value: 'nowledge-mem', label: 'Nowledge Mem' }
            ]}
            onChange={(v) => onChange({ ...draft, memory: { ...memory, provider: v } })}
          />
        </SettingRow>

        {showsBuiltinTerms ? (
          <SettingRow>
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                Memory terms
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                View the built-in memory hierarchy grouped by stored topic.
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
              style={{ color: theme.text.accent }}
              onClick={() => setView('terms')}
            >
              View terms →
            </button>
          </SettingRow>
        ) : null}
      </SettingSection>

      {showsBuiltinTerms ? (
        <SettingSection>
          <div className="px-7 pt-5 pb-3">
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.12em] mb-2"
              style={{ color: theme.text.secondary }}
            >
              Built-in SQLite
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Stores long-term memory inside Yachiyo&apos;s local sqlite database and searches it
              with FTS5 ranking.
            </div>
          </div>

          <div
            className="px-7 pb-4 space-y-3"
            style={{ borderTop: `1px solid ${theme.border.subtle}` }}
          >
            <div className="flex items-center gap-3 pt-4">
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={testing}
                className="inline-flex items-center gap-2 text-sm font-medium shrink-0 transition-opacity opacity-60 hover:opacity-100 disabled:opacity-20"
                style={{ color: theme.text.accent }}
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : null}
                Test
              </button>
            </div>

            {testResult ? (
              <div
                className="text-sm leading-5"
                style={{ color: testResult.ok ? theme.text.secondary : theme.text.warning }}
              >
                {testResult.message}
              </div>
            ) : null}

            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Auto-recall and post-run distillation still use the tool model configured in Chat
              settings.
            </div>
          </div>
        </SettingSection>
      ) : null}

      {showsNowledgeSettings ? (
        <SettingSection>
          <div className="px-7 pt-5 pb-3">
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.12em] mb-2"
              style={{ color: theme.text.secondary }}
            >
              Nowledge Mem
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Install the{' '}
              <code
                className="rounded px-1 py-0.5 text-xs font-mono"
                style={{ background: theme.background.code }}
              >
                nmem
              </code>{' '}
              CLI on this Mac. Yachiyo uses it to talk to the memory backend.
            </div>
          </div>

          <div
            className="px-7 pb-4 space-y-3"
            style={{ borderTop: `1px solid ${theme.border.subtle}` }}
          >
            <div className="flex items-center gap-3 pt-4">
              <input
                value={memory.baseUrl ?? ''}
                onChange={(e) =>
                  onChange({ ...draft, memory: { ...memory, baseUrl: e.target.value } })
                }
                className="min-w-0 flex-1 rounded-xl px-3 py-2 text-sm outline-none"
                style={inputStyle()}
                placeholder="http://127.0.0.1:14242"
                aria-label="Backend URL"
              />
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={testing || !memory.baseUrl?.trim()}
                className="inline-flex items-center gap-2 text-sm font-medium shrink-0 transition-opacity opacity-60 hover:opacity-100 disabled:opacity-20"
                style={{ color: theme.text.accent }}
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : null}
                Test
              </button>
            </div>

            {testResult ? (
              <div
                className="text-sm leading-5"
                style={{ color: testResult.ok ? theme.text.secondary : theme.text.warning }}
              >
                {testResult.message}
              </div>
            ) : null}

            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Auto-recall and post-run distillation also rely on the tool model configured in Chat
              settings.
            </div>
          </div>
        </SettingSection>
      ) : null}
    </div>
  )
}
