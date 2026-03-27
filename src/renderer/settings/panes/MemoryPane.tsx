import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { theme } from '@renderer/theme/theme'
import { SettingRow, SettingSection, SettingSwitch, SimpleSelect } from '../components/primitives'
import { inputStyle } from '../components/styles'

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
            options={[{ value: 'nowledge-mem', label: 'Nowledge Mem' }]}
            onChange={(v) => onChange({ ...draft, memory: { ...memory, provider: v } })}
          />
        </SettingRow>
      </SettingSection>

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
                onChange={(event) =>
                  onChange({ ...draft, memory: { ...memory, baseUrl: event.target.value } })
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
