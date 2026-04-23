import { Check, ChevronDown, Folder, MonitorStop, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { theme, alpha } from '@renderer/theme/theme'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { SettingLabel, SettingSection } from '../components/primitives'
import { imeSafeEnter } from '@renderer/lib/imeUtils'

interface DiscoveredApp {
  name: string
  iconDataUrl?: string
}

interface AppPickerProps {
  value: string
  options: DiscoveredApp[]
  placeholder: string
  onChange: (value: string) => void
}

function AppPickerOption({
  app,
  selected,
  onSelect
}: {
  app: DiscoveredApp
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      role="option"
      aria-selected={selected}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(e) => {
        e.preventDefault()
        onSelect()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 12px',
        cursor: 'default',
        borderRadius: 8,
        margin: '0 4px',
        background: hovered ? theme.background.surfaceLight : 'transparent',
        transition: 'background 80ms'
      }}
    >
      {app.iconDataUrl ? (
        <img
          src={app.iconDataUrl}
          width={18}
          height={18}
          style={{ borderRadius: 4, flexShrink: 0 }}
          alt=""
        />
      ) : (
        <div
          style={{
            width: 18,
            height: 18,
            flexShrink: 0,
            borderRadius: 4,
            background: theme.background.surface,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <MonitorStop size={11} color={theme.icon.muted} />
        </div>
      )}
      <span
        style={{
          flex: 1,
          fontSize: 13,
          fontWeight: selected ? 600 : 400,
          color: theme.text.primary,
          lineHeight: 1
        }}
      >
        {app.name}
      </span>
      {selected && <Check size={13} strokeWidth={2.5} color={theme.text.accent} />}
    </div>
  )
}

function NoneOption({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  return (
    <div style={{ margin: '4px 4px 0', borderTop: `1px solid ${theme.border.subtle}` }}>
      <div
        role="option"
        aria-selected={false}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={(e) => {
          e.preventDefault()
          onSelect()
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 12px',
          cursor: 'default',
          borderRadius: 8,
          margin: '0 0',
          background: hovered ? theme.background.surfaceLight : 'transparent',
          transition: 'background 80ms'
        }}
      >
        <div
          style={{
            width: 18,
            height: 18,
            flexShrink: 0,
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <X size={12} strokeWidth={2} color={theme.icon.muted} />
        </div>
        <span style={{ fontSize: 13, color: theme.text.muted, lineHeight: 1 }}>None</span>
      </div>
    </div>
  )
}

function AppPicker({ value, options, placeholder, onChange }: AppPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null)
  const [openUpward, setOpenUpward] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [triggerHovered, setTriggerHovered] = useState(false)

  function handleOpen(): void {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setTriggerRect(rect)
      const estimatedHeight = (options.length + 1) * 36 + 24
      setOpenUpward(rect.bottom + estimatedHeight > window.innerHeight - 16)
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent): void {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const selectedApp = options.find((o) => o.name === value)

  const triggerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 10px 7px 12px',
    borderRadius: 10,
    border: 'none',
    background: open || triggerHovered ? theme.background.hover : alpha('ink', 0.04),
    cursor: 'default',
    textAlign: 'left',
    transition: 'background 120ms',
    outline: 'none'
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        style={triggerStyle}
        onPointerEnter={() => setTriggerHovered(true)}
        onPointerLeave={() => setTriggerHovered(false)}
        onClick={() => (open ? setOpen(false) : handleOpen())}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedApp?.iconDataUrl ? (
          <img
            src={selectedApp.iconDataUrl}
            width={16}
            height={16}
            style={{ borderRadius: 3, flexShrink: 0 }}
            alt=""
          />
        ) : null}
        <span
          style={{
            flex: 1,
            fontSize: 13,
            color: value ? theme.text.primary : theme.text.muted,
            lineHeight: 1
          }}
        >
          {value || placeholder}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          color={theme.icon.muted}
          style={{
            flexShrink: 0,
            transform: open
              ? openUpward
                ? 'rotate(0deg)'
                : 'rotate(180deg)'
              : openUpward
                ? 'rotate(180deg)'
                : 'rotate(0deg)',
            transition: 'transform 150ms ease'
          }}
        />
      </button>

      {open &&
        triggerRect &&
        createPortal(
          <div
            ref={dropdownRef}
            role="listbox"
            style={{
              position: 'fixed',
              ...(openUpward
                ? { bottom: window.innerHeight - triggerRect.top + 6 }
                : { top: triggerRect.bottom + 6 }),
              left: triggerRect.left,
              width: triggerRect.width,
              zIndex: 9999,
              background: theme.background.surface,
              borderRadius: 14,
              border: `1px solid ${theme.border.subtle}`,
              boxShadow: '0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.06)',
              padding: '4px 0',
              overflow: 'hidden'
            }}
          >
            {options.length === 0 ? (
              <div
                style={{
                  padding: '10px 16px',
                  fontSize: 12,
                  color: theme.text.muted,
                  textAlign: 'center'
                }}
              >
                No apps found on your system
              </div>
            ) : (
              options.map((app) => (
                <AppPickerOption
                  key={app.name}
                  app={app}
                  selected={app.name === value}
                  onSelect={() => {
                    onChange(app.name)
                    setOpen(false)
                  }}
                />
              ))
            )}
            {value ? (
              <NoneOption
                onSelect={() => {
                  onChange('')
                  setOpen(false)
                }}
              />
            ) : null}
          </div>,
          document.body
        )}
    </>
  )
}

function PruneButton(): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="button"
      onClick={() => {
        if (!window.confirm('Delete empty temporary workspaces? This cannot be undone.')) {
          return
        }
        void window.api.yachiyo
          .pruneEmptyTemporaryWorkspaces()
          .then((count) => {
            window.alert(`Pruned ${count} empty temporary workspace${count === 1 ? '' : 's'}.`)
          })
          .catch((error) => {
            window.alert(
              `Failed to prune temporary workspaces: ${error instanceof Error ? error.message : String(error)}`
            )
          })
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="inline-flex items-center gap-2 text-sm font-medium shrink-0 rounded-lg px-3 py-1.5 transition-colors"
      style={{
        color: theme.text.danger,
        background: hovered ? alpha('danger', 0.1) : alpha('danger', 0.06)
      }}
    >
      Prune empty temporary workspaces
    </button>
  )
}

function WorkspaceLabel({
  value,
  onChange
}: {
  value: string
  onChange: (label: string) => void
}): React.ReactNode {
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed !== value) onChange(trimmed)
  }

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={imeSafeEnter(commit)}
      placeholder="Add label for agent context..."
      className="mt-1 w-full text-xs bg-transparent outline-none"
      style={{ color: theme.text.secondary }}
    />
  )
}

interface WorkspacePaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function WorkspacePane({ draft, onChange }: WorkspacePaneProps): React.ReactNode {
  const savedPaths = draft.workspace?.savedPaths ?? []
  const [discoveredApps, setDiscoveredApps] = useState<{
    editors: DiscoveredApp[]
    terminals: DiscoveredApp[]
    markdownEditors: DiscoveredApp[]
  }>({ editors: [], terminals: [], markdownEditors: [] })

  useEffect(() => {
    void window.api.yachiyo
      .listDiscoveredApps()
      .then(setDiscoveredApps)
      .catch(() => {
        // Discovery failed — pickers remain empty, no crash
      })
  }, [])

  function updateWorkspace(patch: Partial<NonNullable<SettingsConfig['workspace']>>): void {
    onChange({ ...draft, workspace: { ...draft.workspace, ...patch } })
  }

  const removePath = (workspacePath: string): void => {
    const pathLabels = { ...draft.workspace?.pathLabels }
    delete pathLabels[workspacePath]
    onChange({
      ...draft,
      workspace: {
        ...draft.workspace,
        savedPaths: savedPaths.filter((entry) => entry !== workspacePath),
        pathLabels: Object.keys(pathLabels).length > 0 ? pathLabels : undefined
      }
    })
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>Saved Folders</SettingLabel>

        {savedPaths.length === 0 ? (
          <div
            className="px-7 pb-4 text-sm leading-6"
            style={{
              color: theme.text.tertiary,
              borderTop: `1px solid ${theme.border.subtle}`
            }}
          >
            No saved folders yet. When you pick a specific workspace from Composer, it will show up
            here.
          </div>
        ) : (
          savedPaths.map((workspacePath) => (
            <div
              key={workspacePath}
              className="flex items-center gap-3 px-7 py-3"
              style={{ borderTop: `1px solid ${theme.border.subtle}` }}
            >
              <div
                className="shrink-0 rounded-lg flex items-center justify-center"
                style={{ width: 30, height: 30, background: theme.background.surfaceLight }}
              >
                <Folder size={14} strokeWidth={1.7} color={theme.icon.muted} />
              </div>

              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                  {workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath}
                </div>
                <div
                  className="text-xs truncate"
                  style={{ color: theme.text.tertiary, lineHeight: 1.5 }}
                >
                  {workspacePath}
                </div>
                <WorkspaceLabel
                  value={draft.workspace?.pathLabels?.[workspacePath] ?? ''}
                  onChange={(label) => {
                    const pathLabels = { ...draft.workspace?.pathLabels }
                    if (label) {
                      pathLabels[workspacePath] = label
                    } else {
                      delete pathLabels[workspacePath]
                    }
                    updateWorkspace({ pathLabels })
                  }}
                />
              </div>

              <button
                type="button"
                onClick={() => removePath(workspacePath)}
                className="shrink-0 rounded-lg p-2 transition-opacity opacity-60 hover:opacity-100"
                aria-label={`Remove ${workspacePath}`}
              >
                <Trash2 size={14} strokeWidth={1.7} color={theme.icon.muted} />
              </button>
            </div>
          ))
        )}

        <div className="px-7 py-3" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const pickedPath = await window.api.yachiyo.pickWorkspaceDirectory()
                if (!pickedPath) {
                  return
                }

                onChange({
                  ...draft,
                  workspace: {
                    ...draft.workspace,
                    savedPaths: [...new Set([...savedPaths, pickedPath])]
                  }
                })
              })()
            }}
            className="flex items-center gap-1.5 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
          >
            <Plus size={14} strokeWidth={2} />
            Select directory...
          </button>
        </div>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Open With</SettingLabel>

        <div
          className="flex items-center justify-between gap-4 px-7 py-3"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
            Editor
          </div>
          <div style={{ width: 220 }}>
            <AppPicker
              value={draft.workspace?.editorApp ?? ''}
              options={discoveredApps.editors}
              placeholder="Select an editor…"
              onChange={(v) => updateWorkspace({ editorApp: v })}
            />
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-4 px-7 py-3"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
            Terminal
          </div>
          <div style={{ width: 220 }}>
            <AppPicker
              value={draft.workspace?.terminalApp ?? ''}
              options={discoveredApps.terminals}
              placeholder="Select a terminal…"
              onChange={(v) => updateWorkspace({ terminalApp: v })}
            />
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-4 px-7 py-3"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
            Markdown document
          </div>
          <div style={{ width: 220 }}>
            <AppPicker
              value={draft.workspace?.markdownApp ?? ''}
              options={discoveredApps.markdownEditors}
              placeholder="Select a markdown editor…"
              onChange={(v) => updateWorkspace({ markdownApp: v })}
            />
          </div>
        </div>
      </SettingSection>

      <SettingSection>
        <SettingLabel action={<PruneButton />}>Maintenance</SettingLabel>
      </SettingSection>
    </div>
  )
}
