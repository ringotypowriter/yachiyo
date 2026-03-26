import { useEffect, useRef, useState } from 'react'
import { CheckCircle, ChevronDown, Loader, Plus, Trash2, XCircle } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import type { SettingsConfig, SubagentProfile } from '../../../shared/yachiyo/protocol.ts'
import { SettingSwitch } from '../components/primitives'
import { inputStyle, settingsPanelStyle } from '../components/styles'

interface EnvEntry {
  key: string
  value: string
}

interface ProfileDraft {
  id: string
  name: string
  enabled: boolean
  description: string
  command: string
  argsString: string
  env: EnvEntry[]
}

interface TestState {
  status: 'idle' | 'running' | 'ok' | 'error'
  error?: string
}

interface Preset {
  label: string
  name: string
  description: string
  command: string
  argsString: string
  env: EnvEntry[]
}

const PRESETS: Preset[] = [
  {
    label: 'Claude Code',
    name: 'Claude Code',
    description:
      'Anthropic Claude Code agent via ACP. Best for multi-file refactoring and deep reasoning.',
    command: 'npx',
    argsString: JSON.stringify(['-y', '@zed-industries/claude-agent-acp']),
    env: [{ key: 'ACP_PERMISSION_MODE', value: 'acceptEdits' }]
  },
  {
    label: 'Codex',
    name: 'Codex',
    description: 'OpenAI Codex agent via ACP. Excellent for code generation and explanation.',
    command: 'npx',
    argsString: JSON.stringify(['-y', '@zed-industries/codex-acp']),
    env: [{ key: 'OPENAI_API_KEY', value: '' }]
  }
]

interface CodingAgentsPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

function toProfileDraft(p: SubagentProfile): ProfileDraft {
  return {
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    description: p.description,
    command: p.command,
    argsString: JSON.stringify(p.args),
    env: Object.entries(p.env).map(([key, value]) => ({ key, value }))
  }
}

function parseArgs(s: string): string[] | null {
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function toProfile(d: ProfileDraft): SubagentProfile {
  const args = parseArgs(d.argsString) ?? []
  const env = Object.fromEntries(d.env.filter((e) => e.key.trim()).map((e) => [e.key, e.value]))
  return {
    id: d.id,
    name: d.name.trim(),
    enabled: d.enabled,
    description: d.description,
    command: d.command.trim(),
    args,
    env
  }
}

export function CodingAgentsPane({ draft, onChange }: CodingAgentsPaneProps): React.ReactNode {
  const [rows, setRows] = useState<ProfileDraft[]>(() =>
    (draft.subagentProfiles ?? []).map(toProfileDraft)
  )
  const [testStates, setTestStates] = useState<Record<number, TestState>>({})
  const [showPresetMenu, setShowPresetMenu] = useState(false)
  const presetMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const profiles = rows.filter((r) => r.name.trim() && r.command.trim()).map(toProfile)
    onChange({ ...draft, subagentProfiles: profiles })
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showPresetMenu) return
    function handleClickOutside(e: MouseEvent): void {
      if (presetMenuRef.current && !presetMenuRef.current.contains(e.target as Node)) {
        setShowPresetMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showPresetMenu])

  function updateRow(index: number, patch: Partial<ProfileDraft>): void {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
    setTestStates((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
  }

  function removeRow(index: number): void {
    setRows((prev) => prev.filter((_, i) => i !== index))
    setTestStates((prev) => {
      const next: Record<number, TestState> = {}
      for (const [key, val] of Object.entries(prev)) {
        const k = Number(key)
        if (k < index) next[k] = val
        else if (k > index) next[k - 1] = val
      }
      return next
    })
  }

  function addRow(preset?: Preset): void {
    const id = `custom-${Date.now()}`
    setRows((prev) => [
      ...prev,
      preset
        ? {
            id,
            enabled: true,
            name: preset.name,
            description: preset.description,
            command: preset.command,
            argsString: preset.argsString,
            env: preset.env
          }
        : {
            id,
            name: '',
            enabled: true,
            description: '',
            command: '',
            argsString: '[]',
            env: []
          }
    ])
    setShowPresetMenu(false)
  }

  function updateEnvEntry(rowIndex: number, ei: number, field: 'key' | 'value', val: string): void {
    setRows((prev) =>
      prev.map((row, i) =>
        i !== rowIndex
          ? row
          : { ...row, env: row.env.map((e, j) => (j === ei ? { ...e, [field]: val } : e)) }
      )
    )
  }

  function removeEnvEntry(rowIndex: number, ei: number): void {
    setRows((prev) =>
      prev.map((row, i) =>
        i !== rowIndex ? row : { ...row, env: row.env.filter((_, j) => j !== ei) }
      )
    )
  }

  function addEnvEntry(rowIndex: number): void {
    setRows((prev) =>
      prev.map((row, i) =>
        i !== rowIndex ? row : { ...row, env: [...row.env, { key: '', value: '' }] }
      )
    )
  }

  async function testRow(index: number): Promise<void> {
    const row = rows[index]
    if (!row) return

    setTestStates((prev) => ({ ...prev, [index]: { status: 'running' } }))
    try {
      const result = await window.api.yachiyo.testSubagentProfile({ profile: toProfile(row) })
      setTestStates((prev) => ({
        ...prev,
        [index]: result.ok ? { status: 'ok' } : { status: 'error', error: result.error }
      }))
    } catch (err) {
      setTestStates((prev) => ({
        ...prev,
        [index]: {
          status: 'error',
          error: err instanceof Error ? err.message : 'Test failed.'
        }
      }))
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
            Agent Profiles
          </div>

          <div className="mt-3 space-y-3">
            {rows.length === 0 ? (
              <div
                className="rounded-2xl px-4 py-3 text-sm leading-5"
                style={{
                  background: theme.background.surfaceLight,
                  border: `1px solid ${theme.border.default}`,
                  color: theme.text.tertiary
                }}
              >
                No agent profiles configured. Add one to enable the{' '}
                <code
                  className="rounded px-1 py-0.5 text-xs font-mono"
                  style={{ background: theme.background.code }}
                >
                  delegateCodingTask
                </code>{' '}
                tool.
              </div>
            ) : (
              rows.map((row, index) => {
                const test = testStates[index] ?? { status: 'idle' }
                const canTest = row.command.trim().length > 0
                return (
                  <div
                    key={row.id}
                    className="rounded-2xl px-4 py-3 space-y-2.5"
                    style={{
                      background: theme.background.surfaceLight,
                      border: `1px solid ${theme.border.default}`
                    }}
                  >
                    {/* Row 1: toggle + name + test + delete */}
                    <div className="flex items-center gap-3">
                      <SettingSwitch
                        checked={row.enabled}
                        onChange={() => updateRow(index, { enabled: !row.enabled })}
                        ariaLabel={`Toggle ${row.name || 'agent'}`}
                      />
                      <input
                        type="text"
                        value={row.name}
                        placeholder="Agent name"
                        className="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium outline-none"
                        style={inputStyle()}
                        onChange={(e) => updateRow(index, { name: e.target.value })}
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        disabled={!canTest || test.status === 'running'}
                        onClick={() => void testRow(index)}
                        className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-opacity disabled:opacity-30"
                        style={{
                          background: theme.background.surfaceMuted,
                          border: `1px solid ${theme.border.contrast}`,
                          color: theme.text.secondary
                        }}
                      >
                        {test.status === 'running' ? 'Testing…' : 'Test'}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRow(index)}
                        className="p-1 rounded-lg opacity-40 hover:opacity-70 transition-opacity"
                        aria-label="Remove agent profile"
                      >
                        <Trash2 size={14} strokeWidth={1.6} color={theme.icon.muted} />
                      </button>
                    </div>

                    {/* Test result */}
                    {test.status === 'running' && (
                      <div
                        className="flex items-center gap-1.5 text-xs"
                        style={{ color: theme.text.muted }}
                      >
                        <Loader
                          size={12}
                          strokeWidth={2}
                          style={{ animation: 'spin 1s linear infinite' }}
                        />
                        Connecting to agent…
                      </div>
                    )}
                    {test.status === 'ok' && (
                      <div
                        className="flex items-center gap-1.5 text-xs"
                        style={{ color: theme.text.success }}
                      >
                        <CheckCircle size={12} strokeWidth={2} />
                        Agent connected successfully.
                      </div>
                    )}
                    {test.status === 'error' && (
                      <div
                        className="flex items-start gap-1.5 text-xs leading-relaxed"
                        style={{ color: theme.text.danger }}
                      >
                        <XCircle size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
                        <span>{test.error ?? 'Connection failed.'}</span>
                      </div>
                    )}

                    {/* Row 2: description */}
                    <textarea
                      value={row.description}
                      placeholder="Describe what this agent does. Yachiyo will include this in its context when deciding which agent to delegate to."
                      rows={2}
                      className="w-full rounded-lg px-3 py-2 text-sm resize-none outline-none leading-relaxed"
                      style={inputStyle()}
                      onChange={(e) => updateRow(index, { description: e.target.value })}
                    />

                    {/* Row 3: command + args */}
                    <div className="space-y-1">
                      <p className="text-xs px-1 font-medium" style={{ color: theme.text.muted }}>
                        Command
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={row.command}
                          placeholder="npx"
                          className="rounded-lg px-3 py-1.5 text-sm font-mono outline-none"
                          style={{ ...inputStyle(), flexBasis: '120px', flexShrink: 0 }}
                          onChange={(e) => updateRow(index, { command: e.target.value })}
                          spellCheck={false}
                        />
                        <input
                          type="text"
                          value={row.argsString}
                          placeholder='["-y", "@package"]'
                          className="flex-1 rounded-lg px-3 py-1.5 text-sm font-mono outline-none"
                          style={{
                            ...inputStyle(),
                            ...(parseArgs(row.argsString) === null
                              ? { outline: '1.5px solid #e05252' }
                              : {})
                          }}
                          onChange={(e) => updateRow(index, { argsString: e.target.value })}
                          spellCheck={false}
                        />
                      </div>
                      {parseArgs(row.argsString) === null && (
                        <p className="text-xs px-1" style={{ color: '#e05252' }}>
                          {`Invalid JSON — expected an array like ["-y", "@pkg"]`}
                        </p>
                      )}
                    </div>

                    {/* Row 4: env KV pairs */}
                    <div className="space-y-1.5">
                      <p className="text-xs px-1 font-medium" style={{ color: theme.text.muted }}>
                        Environment
                      </p>
                      {row.env.map((entry, ei) => (
                        <div key={ei} className="flex gap-2 items-center">
                          <input
                            type="text"
                            value={entry.key}
                            placeholder="KEY"
                            className="rounded-lg px-3 py-1.5 text-sm font-mono outline-none"
                            style={{ ...inputStyle(), flexBasis: '140px', flexShrink: 0 }}
                            onChange={(e) => updateEnvEntry(index, ei, 'key', e.target.value)}
                            spellCheck={false}
                          />
                          <input
                            type="text"
                            value={entry.value}
                            placeholder="value"
                            className="flex-1 rounded-lg px-3 py-1.5 text-sm font-mono outline-none"
                            style={inputStyle()}
                            onChange={(e) => updateEnvEntry(index, ei, 'value', e.target.value)}
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            onClick={() => removeEnvEntry(index, ei)}
                            className="p-1 rounded-lg opacity-40 hover:opacity-70 transition-opacity shrink-0"
                            aria-label="Remove variable"
                          >
                            <Trash2 size={14} strokeWidth={1.6} color={theme.icon.muted} />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addEnvEntry(index)}
                        className="flex items-center gap-1 text-xs px-1 py-0.5 opacity-40 hover:opacity-70 transition-opacity"
                        style={{ color: theme.text.secondary }}
                      >
                        <Plus size={11} strokeWidth={2} />
                        Add variable
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Add agent button with preset dropdown */}
          <div className="relative mt-3 inline-block" ref={presetMenuRef}>
            <button
              type="button"
              onClick={() => setShowPresetMenu((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-opacity opacity-70 hover:opacity-100"
              style={{
                background: theme.background.surfaceMuted,
                border: `1px solid ${theme.border.default}`,
                color: theme.text.secondary
              }}
            >
              <Plus size={13} strokeWidth={1.8} />
              Add agent
              <ChevronDown size={11} strokeWidth={2} style={{ opacity: 0.6 }} />
            </button>

            {showPresetMenu && (
              <div
                className="absolute bottom-full mb-1 left-0 rounded-xl overflow-hidden z-10"
                style={{
                  minWidth: '160px',
                  background: theme.background.surfaceFrosted,
                  border: `1px solid ${theme.border.panel}`,
                  boxShadow: theme.shadow.overlay
                }}
              >
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => addRow(preset)}
                    className="w-full text-left px-3 py-2 text-xs hover:opacity-80 transition-opacity"
                    style={{ color: theme.text.primary }}
                  >
                    {preset.label}
                  </button>
                ))}
                <div style={{ height: 1, background: theme.border.subtle, margin: '0 8px' }} />
                <button
                  type="button"
                  onClick={() => addRow()}
                  className="w-full text-left px-3 py-2 text-xs hover:opacity-80 transition-opacity"
                  style={{ color: theme.text.secondary }}
                >
                  Custom
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
