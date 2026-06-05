import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  CheckCircle,
  CircleCheck,
  ChevronDown,
  Loader,
  Plus,
  Trash2,
  XCircle
} from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import type {
  NamedSubagentId,
  SettingsConfig,
  SubagentProfile,
  SubagentRuntimeMode
} from '@yachiyo/shared/protocol'
import { SettingLabel, SettingSection, SettingSwitch, SimpleSelect } from '../components/primitives'
import { inputStyle } from '../components/styles'
import { ModelSelectorPopup } from '../../src/features/chat/components/ModelSelectorPopup'
import { formatStoredModelChip } from '../../src/lib/model/modelLabel'

interface EnvEntry {
  key: string
  value: string
}

interface ProfileDraft {
  id: string
  name: string
  enabled: boolean
  showInChatPicker: boolean
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
    env: [{ key: '', value: '' }]
  }
]

const BUILT_IN_WORKER_AGENTS: Array<{
  id: NamedSubagentId
  label: string
  description: string
}> = [
  {
    id: 'explore',
    label: 'Explore',
    description: 'Read-only codebase inspection with path and line references.'
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Read-only planning that can use saved context and preferences.'
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Review-only inspection with bash access for relevant tests or checks.'
  },
  {
    id: 'general',
    label: 'General',
    description:
      'Ordinary read/write worker without memory, browser, sentinel, user prompts, or todos.'
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
    showInChatPicker: p.showInChatPicker ?? false,
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
    showInChatPicker: d.showInChatPicker,
    description: d.description,
    command: d.command.trim(),
    args,
    env
  }
}

export function CodingAgentsPane({ draft, onChange }: CodingAgentsPaneProps): React.ReactNode {
  const propsKey = useMemo(
    () => JSON.stringify(draft.subagentProfiles ?? []),
    [draft.subagentProfiles]
  )
  const [rows, setRows] = useState<ProfileDraft[]>(() =>
    (draft.subagentProfiles ?? []).map(toProfileDraft)
  )
  const [prevKey, setPrevKey] = useState(propsKey)
  if (propsKey !== prevKey) {
    setPrevKey(propsKey)
    setRows((draft.subagentProfiles ?? []).map(toProfileDraft))
  }

  const [testStates, setTestStates] = useState<Record<number, TestState>>({})
  const [showPresetMenu, setShowPresetMenu] = useState(false)
  const presetMenuRef = useRef<HTMLDivElement>(null)

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

  function commitRows(nextRows: ProfileDraft[]): void {
    setRows(nextRows)
    const profiles = nextRows.filter((r) => r.name.trim() && r.command.trim()).map(toProfile)
    onChange({ ...draft, subagentProfiles: profiles })
  }

  function updateRow(index: number, patch: Partial<ProfileDraft>): void {
    commitRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
    setTestStates((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
  }

  function removeRow(index: number): void {
    commitRows(rows.filter((_, i) => i !== index))
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
    commitRows([
      ...rows,
      preset
        ? {
            id,
            enabled: true,
            showInChatPicker: false,
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
            showInChatPicker: false,
            description: '',
            command: '',
            argsString: '[]',
            env: []
          }
    ])
    setShowPresetMenu(false)
  }

  function updateEnvEntry(rowIndex: number, ei: number, field: 'key' | 'value', val: string): void {
    commitRows(
      rows.map((row, i) =>
        i !== rowIndex
          ? row
          : { ...row, env: row.env.map((e, j) => (j === ei ? { ...e, [field]: val } : e)) }
      )
    )
  }

  function removeEnvEntry(rowIndex: number, ei: number): void {
    commitRows(
      rows.map((row, i) =>
        i !== rowIndex ? row : { ...row, env: row.env.filter((_, j) => j !== ei) }
      )
    )
  }

  function addEnvEntry(rowIndex: number): void {
    commitRows(
      rows.map((row, i) =>
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

  function updateSubagentMode(mode: SubagentRuntimeMode): void {
    onChange({
      ...draft,
      subagents: {
        ...(draft.subagents ?? {
          enabledNamedAgents: BUILT_IN_WORKER_AGENTS.map((agent) => agent.id)
        }),
        mode
      }
    })
  }

  function toggleWorkerAgent(id: NamedSubagentId): void {
    const current =
      draft.subagents?.enabledNamedAgents ?? BUILT_IN_WORKER_AGENTS.map((agent) => agent.id)
    const next = current.includes(id)
      ? current.filter((agentId) => agentId !== id)
      : [...current, id]
    onChange({
      ...draft,
      subagents: {
        ...(draft.subagents ?? { mode: 'worker' }),
        enabledNamedAgents: next
      }
    })
  }

  const subagentMode = draft.subagents?.mode ?? 'worker'

  const hasEnabledModels = draft.providers.some((p) => p.modelList.enabled.length > 0)
  const [workerModelSelectorOpen, setWorkerModelSelectorOpen] = useState<NamedSubagentId | null>(
    null
  )
  const workerAnchorRectRefs = useRef<Record<string, React.RefObject<HTMLDivElement | null>>>({})
  const workerTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [workerAnchorRect, setWorkerAnchorRect] = useState<DOMRect | null>(null)

  function getWorkerTriggerRef(agentId: NamedSubagentId): React.RefObject<HTMLDivElement | null> {
    const refs = workerAnchorRectRefs.current
    if (!refs[agentId]) {
      refs[agentId] = { current: null }
    }
    return refs[agentId]
  }

  function updateWorkerAnchorRect(agentId: NamedSubagentId): void {
    const el = workerTriggerRefs.current[agentId]
    setWorkerAnchorRect(el?.getBoundingClientRect() ?? null)
  }

  function getWorkerModelLabel(agentId: NamedSubagentId): string {
    const preferred = draft.subagents?.preferredModels?.[agentId]
    if (!preferred?.providerName || !preferred?.model) {
      return 'Default (same as calling model)'
    }
    const chip = formatStoredModelChip(preferred.model, preferred.providerName)
    return `${chip.provider} - ${chip.model}`
  }

  function getWorkerCurrentProviderName(agentId: NamedSubagentId): string {
    return draft.subagents?.preferredModels?.[agentId]?.providerName ?? ''
  }

  function getWorkerCurrentModel(agentId: NamedSubagentId): string {
    return draft.subagents?.preferredModels?.[agentId]?.model ?? ''
  }

  function isWorkerPreferredModelResolvable(agentId: NamedSubagentId): boolean {
    const preferred = draft.subagents?.preferredModels?.[agentId]
    if (!preferred?.providerName || !preferred?.model) return false
    const provider = draft.providers.find((p) => p.name === preferred.providerName)
    if (!provider) return false
    return provider.modelList.enabled.includes(preferred.model)
  }

  function setWorkerPreferredModel(
    agentId: NamedSubagentId,
    providerName: string,
    model: string
  ): void {
    const current = draft.subagents ?? {
      mode: 'worker' as const,
      enabledNamedAgents: BUILT_IN_WORKER_AGENTS.map((a) => a.id)
    }
    const currentPreferred = current.preferredModels ?? {}
    onChange({
      ...draft,
      subagents: {
        ...current,
        preferredModels: { ...currentPreferred, [agentId]: { providerName, model } }
      }
    })
  }
  function clearWorkerPreferredModel(agentId: NamedSubagentId): void {
    const current = draft.subagents ?? {
      mode: 'worker' as const,
      enabledNamedAgents: BUILT_IN_WORKER_AGENTS.map((a) => a.id)
    }
    const currentPreferred = { ...(current.preferredModels ?? {}) }
    delete currentPreferred[agentId]
    const hasRemaining = Object.keys(currentPreferred).length > 0
    onChange({
      ...draft,
      subagents: {
        mode: current.mode,
        enabledNamedAgents: current.enabledNamedAgents,
        ...(hasRemaining ? { preferredModels: currentPreferred } : {})
      }
    })
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>Subagents</SettingLabel>
        <div
          className="px-7 pb-4 space-y-3"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <div className="flex items-center justify-between gap-4 pt-4">
            <div>
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                Runtime mode
              </div>
              <div className="text-xs mt-1" style={{ color: theme.text.tertiary }}>
                Worker mode exposes Explore, Plan, Review, and General through delegateTask.
              </div>
            </div>
            <SimpleSelect<SubagentRuntimeMode>
              value={subagentMode}
              options={[
                { value: 'worker', label: 'Worker Mode' },
                { value: 'acp', label: 'ACP Mode (Deprecated)' }
              ]}
              onChange={updateSubagentMode}
              width={190}
            />
          </div>

          {subagentMode === 'worker' ? (
            <div className="grid gap-2">
              {BUILT_IN_WORKER_AGENTS.map((agent) => {
                const enabled = (
                  draft.subagents?.enabledNamedAgents ??
                  BUILT_IN_WORKER_AGENTS.map((item) => item.id)
                ).includes(agent.id)
                const isPopupOpen = workerModelSelectorOpen === agent.id
                return (
                  <div
                    key={agent.id}
                    className="rounded-xl px-3 py-2"
                    style={{
                      background: theme.background.surface,
                      border: `1px solid ${theme.border.subtle}`
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                          {agent.label}
                        </div>
                        <div className="text-xs mt-1" style={{ color: theme.text.tertiary }}>
                          {agent.description}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <div ref={getWorkerTriggerRef(agent.id)} className="relative">
                          <button
                            ref={(el) => {
                              workerTriggerRefs.current[agent.id] = el
                            }}
                            type="button"
                            disabled={!hasEnabledModels}
                            onClick={() => {
                              if (!hasEnabledModels) return
                              if (isPopupOpen) {
                                setWorkerModelSelectorOpen(null)
                                return
                              }
                              updateWorkerAnchorRect(agent.id)
                              setWorkerModelSelectorOpen(agent.id)
                            }}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-opacity"
                            style={{
                              color: theme.text.primary,
                              opacity: isPopupOpen ? 1 : 0.72
                            }}
                            aria-label={`Model for ${agent.label} worker`}
                          >
                            <CircleCheck
                              size={12}
                              strokeWidth={1.5}
                              color={
                                isWorkerPreferredModelResolvable(agent.id)
                                  ? theme.icon.success
                                  : theme.icon.muted
                              }
                            />
                            {getWorkerModelLabel(agent.id)}
                            {hasEnabledModels ? (
                              <ChevronDown
                                size={10}
                                strokeWidth={1.5}
                                color={theme.icon.muted}
                                style={{
                                  transform: isPopupOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                                  transition: 'transform 0.15s ease'
                                }}
                              />
                            ) : null}
                          </button>

                          {isPopupOpen ? (
                            <ModelSelectorPopup
                              config={draft}
                              triggerRef={
                                getWorkerTriggerRef(agent.id) as React.RefObject<HTMLElement | null>
                              }
                              onRequestAnchorUpdate={() => {
                                const el = workerTriggerRefs.current[agent.id]
                                setWorkerAnchorRect(el?.getBoundingClientRect() ?? null)
                              }}
                              currentProviderName={getWorkerCurrentProviderName(agent.id)}
                              currentModel={getWorkerCurrentModel(agent.id)}
                              leadingOptions={[
                                {
                                  label: 'Default (same as calling model)',
                                  isSelected: !draft.subagents?.preferredModels?.[agent.id],
                                  onSelect: () => {
                                    clearWorkerPreferredModel(agent.id)
                                    setWorkerModelSelectorOpen(null)
                                  }
                                }
                              ]}
                              onSelect={(providerName, model) => {
                                setWorkerPreferredModel(agent.id, providerName, model)
                                setWorkerModelSelectorOpen(null)
                              }}
                              onClose={() => setWorkerModelSelectorOpen(null)}
                              align="right"
                              anchorRect={workerAnchorRect}
                              placement="bottom"
                              portal
                              width={280}
                            />
                          ) : null}
                        </div>
                        <SettingSwitch
                          ariaLabel={`Enable ${agent.label} worker`}
                          checked={enabled}
                          onChange={() => toggleWorkerAgent(agent.id)}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-xs" style={{ color: theme.text.tertiary }}>
              ACP agents are deprecated. Existing profiles remain below for compatibility.
            </div>
          )}
        </div>
      </SettingSection>

      {subagentMode === 'acp' && (
        <SettingSection>
          <SettingLabel
            action={
              <div className="relative" ref={presetMenuRef}>
                <button
                  type="button"
                  onClick={() => setShowPresetMenu((v) => !v)}
                  className="flex items-center gap-1 text-xs font-medium transition-opacity opacity-60 hover:opacity-100"
                  style={{ color: theme.text.accent }}
                >
                  <Plus size={13} strokeWidth={1.8} />
                  Add agent
                  <ChevronDown size={11} strokeWidth={2} style={{ opacity: 0.6 }} />
                </button>

                {showPresetMenu && (
                  <div
                    className="absolute top-full mt-1 right-0 rounded-xl overflow-hidden z-10"
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
            }
          >
            Agent Profiles
          </SettingLabel>

          {rows.length === 0 ? (
            <div
              className="px-7 pb-4 text-sm leading-5"
              style={{
                color: theme.text.tertiary,
                borderTop: `1px solid ${theme.border.subtle}`
              }}
            >
              No agent profiles configured. Add one to enable the{' '}
              <code
                className="rounded px-1 py-0.5 text-xs font-mono"
                style={{ background: theme.background.code }}
              >
                delegateTask
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
                  className="px-7 py-4 space-y-3"
                  style={{ borderTop: `1px solid ${theme.border.subtle}` }}
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
                      onClick={() => updateRow(index, { showInChatPicker: !row.showInChatPicker })}
                      className="shrink-0 flex items-center gap-1.5 text-xs font-medium transition-opacity"
                      style={{
                        color: row.showInChatPicker ? theme.text.accent : theme.text.tertiary,
                        opacity: row.showInChatPicker ? 1 : 0.5
                      }}
                      aria-label={`Show ${row.name || 'agent'} in chat picker`}
                    >
                      <span
                        className="inline-flex items-center justify-center rounded-full transition-colors"
                        style={{
                          width: 14,
                          height: 14,
                          border: `1.5px solid currentColor`,
                          background: row.showInChatPicker ? 'currentColor' : 'transparent'
                        }}
                      >
                        {row.showInChatPicker && (
                          <Check size={8} strokeWidth={3} color={theme.text.inverse} />
                        )}
                      </span>
                      Picker
                    </button>
                    <button
                      type="button"
                      disabled={!canTest || test.status === 'running'}
                      onClick={() => void testRow(index)}
                      className="shrink-0 text-xs font-medium transition-opacity opacity-50 hover:opacity-90 disabled:opacity-20"
                      style={{ color: theme.text.secondary }}
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

                  {/* Description */}
                  <textarea
                    value={row.description}
                    placeholder="Describe what this agent does. Yachiyo will include this in its context when deciding which agent to delegate to."
                    rows={2}
                    className="w-full rounded-lg px-3 py-2 text-sm resize-none outline-none leading-relaxed"
                    style={inputStyle()}
                    onChange={(e) => updateRow(index, { description: e.target.value })}
                  />

                  {/* Command + args */}
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium" style={{ color: theme.text.muted }}>
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
                            ? { outline: `1.5px solid ${theme.text.danger}` }
                            : {})
                        }}
                        onChange={(e) => updateRow(index, { argsString: e.target.value })}
                        spellCheck={false}
                      />
                    </div>
                    {parseArgs(row.argsString) === null && (
                      <p className="text-xs" style={{ color: theme.text.danger }}>
                        {`Invalid JSON — expected an array like ["-y", "@pkg"]`}
                      </p>
                    )}
                  </div>

                  {/* Env KV pairs */}
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium" style={{ color: theme.text.muted }}>
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
                      className="flex items-center gap-1 text-xs opacity-40 hover:opacity-70 transition-opacity"
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
        </SettingSection>
      )}
    </div>
  )
}
