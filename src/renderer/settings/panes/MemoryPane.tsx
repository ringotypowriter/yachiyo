import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { theme } from '@renderer/theme/theme'
import { settingsPanelStyle } from '../components/styles'

export interface MemoryPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function MemoryPane({ draft, onChange }: MemoryPaneProps): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const memory = draft.memory ?? {
    enabled: false,
    provider: 'nowledge-mem',
    baseUrl: 'http://127.0.0.1:14242'
  }
  const provider = memory.provider ?? 'nowledge-mem'
  const showsNowledgeSettings = provider === 'nowledge-mem'

  useEffect(() => {
    setTestResult(null)
  }, [draft])

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

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8">
      <div className="max-w-3xl space-y-6">
        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: theme.text.muted }}
          >
            Memory
          </div>

          <div className="mt-3 space-y-3">
            <div
              className="flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
              style={{
                background: theme.background.surfaceLight,
                border: `1px solid ${theme.border.default}`
              }}
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                  Enable memory
                </div>
                <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                  Pull recalled context into runs and allow explicit thread saves.
                </div>
              </div>

              <label
                className="flex items-center gap-2 text-sm shrink-0"
                style={{ color: theme.text.primary }}
              >
                <input
                  type="checkbox"
                  checked={memory.enabled === true}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      memory: {
                        ...memory,
                        enabled: event.target.checked
                      }
                    })
                  }
                />
                Enabled
              </label>
            </div>

            <div
              className="flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
              style={{
                background: theme.background.surfaceLight,
                border: `1px solid ${theme.border.default}`
              }}
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                  Provider
                </div>
                <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                  Memory backend used for recall, distillation, and explicit thread save.
                </div>
              </div>

              <select
                value={memory.provider ?? 'nowledge-mem'}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    memory: {
                      ...memory,
                      provider: event.target.value as 'nowledge-mem'
                    }
                  })
                }
                className="rounded-xl px-3 py-2 text-sm shrink-0"
                style={{
                  background: theme.background.surfaceSoft,
                  border: `1px solid ${theme.border.panel}`,
                  color: theme.text.primary
                }}
              >
                <option value="nowledge-mem">Nowledge Mem</option>
              </select>
            </div>

            {showsNowledgeSettings ? (
              <div
                className="rounded-2xl px-4 py-3 space-y-3"
                style={{
                  background: theme.background.surfaceLight,
                  border: `1px solid ${theme.border.default}`
                }}
              >
                <div className="space-y-1">
                  <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                    Nowledge Mem
                  </div>
                  <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                    Install the `nmem` CLI on this Mac. Yachiyo uses it to talk to the memory
                    backend.
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                    Backend URL
                  </div>
                  <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                    Address passed to `nmem` as `NMEM_API_URL`.
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    value={memory.baseUrl ?? ''}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        memory: {
                          ...memory,
                          baseUrl: event.target.value
                        }
                      })
                    }
                    className="min-w-0 flex-1 rounded-xl px-3 py-2 text-sm outline-none"
                    style={{
                      background: theme.background.surfaceSoft,
                      border: `1px solid ${theme.border.panel}`,
                      color: theme.text.primary
                    }}
                    placeholder="http://127.0.0.1:14242"
                  />

                  <button
                    type="button"
                    onClick={() => void handleTest()}
                    disabled={testing || !memory.baseUrl?.trim()}
                    className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium shrink-0 disabled:opacity-40"
                    style={{
                      background: theme.background.accentSurface,
                      color: theme.text.accent
                    }}
                  >
                    {testing ? <Loader2 size={14} className="animate-spin" /> : null}
                    Test
                  </button>
                </div>

                {testResult ? (
                  <div
                    className="text-sm leading-5"
                    style={{
                      color: testResult.ok ? theme.text.secondary : theme.text.warning
                    }}
                  >
                    {testResult.message}
                  </div>
                ) : null}

                <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                  Auto-recall and post-run distillation also rely on the tool model configured in
                  Chat settings.
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
