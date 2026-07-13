import { Check, ChevronDown, Folder, MonitorStop, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { theme, alpha } from '@renderer/theme/theme'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import { SettingLabel, SettingSection } from '../components/primitives'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { imeSafeEnter } from '@renderer/lib/imeUtils'
import { useFloatingPanelLayout } from '@renderer/lib/useFloatingPanelLayout'

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
  const t = useT()

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
        <span style={{ fontSize: 13, color: theme.text.muted, lineHeight: 1 }}>
          {t('common.none')}
        </span>
      </div>
    </div>
  )
}

function AppPicker({ value, options, placeholder, onChange }: AppPickerProps): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [triggerHovered, setTriggerHovered] = useState(false)
  const estimatedHeight = (options.length + 1) * 36 + 24
  const {
    floatingRef: dropdownRef,
    layout: dropdownLayout,
    style: dropdownPositionStyle
  } = useFloatingPanelLayout({
    open,
    referenceRef: triggerRef,
    width: 'anchor',
    maxHeight: estimatedHeight,
    preferredPlacement: 'bottom',
    gap: 6,
    margin: 16
  })

  useRestoreFocusOnUnmount(open)

  function handleOpen(): void {
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
  }, [dropdownRef, open])

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
              ? dropdownLayout?.placement === 'top'
                ? 'rotate(0deg)'
                : 'rotate(180deg)'
              : 'rotate(0deg)',
            transition: 'transform 150ms ease'
          }}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            role="listbox"
            style={{
              ...dropdownPositionStyle,
              zIndex: 9999,
              background: theme.background.surface,
              borderRadius: 14,
              border: `1px solid ${theme.border.subtle}`,
              boxShadow: theme.shadow.menu,
              padding: '4px 0',
              overflowY: 'auto',
              overscrollBehavior: 'contain'
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
                {t('settings.workspace.noAppsFound')}
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
  const t = useT()
  const dialog = useAppDialog()

  return (
    <button
      type="button"
      onClick={() => {
        void (async () => {
          const confirmed = await dialog.confirm({
            title: t('settings.workspace.pruneConfirmTitle'),
            message: t('settings.workspace.pruneConfirmMessage'),
            confirmLabel: t('common.delete'),
            tone: 'danger'
          })
          if (!confirmed) return

          try {
            const count = await window.api.yachiyo.pruneEmptyTemporaryWorkspaces()
            await dialog.alert({
              title: tPlural('settings.workspace.prunedResult', count)
            })
          } catch (error) {
            await dialog.alert({
              title: t('settings.workspace.pruneFailed'),
              message: error instanceof Error ? error.message : String(error)
            })
          }
        })()
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="inline-flex items-center gap-2 text-sm font-medium shrink-0 rounded-lg px-3 py-1.5 transition-colors"
      style={{
        color: theme.text.danger,
        background: hovered ? alpha('danger', 0.1) : alpha('danger', 0.06)
      }}
    >
      {t('settings.workspace.pruneButton')}
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
  const t = useT()
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
      placeholder={t('settings.workspace.labelPlaceholder')}
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
  const t = useT()
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
        <SettingLabel>{t('settings.workspace.savedFolders')}</SettingLabel>

        {savedPaths.length === 0 ? (
          <div
            className="px-7 pb-4 text-sm leading-6"
            style={{
              color: theme.text.tertiary,
              borderTop: `1px solid ${theme.border.subtle}`
            }}
          >
            {t('settings.workspace.noSavedFolders')}
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
                  className="content-selectable text-xs truncate"
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
                aria-label={t('settings.workspace.removeFolderAria', { path: workspacePath })}
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
            {t('settings.workspace.selectDirectory')}
          </button>
        </div>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.workspace.openWith')}</SettingLabel>

        <div
          className="flex items-center justify-between gap-4 px-7 py-3"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
            {t('settings.workspace.editor')}
          </div>
          <div style={{ width: 220 }}>
            <AppPicker
              value={draft.workspace?.editorApp ?? ''}
              options={discoveredApps.editors}
              placeholder={t('settings.workspace.selectEditorPlaceholder')}
              onChange={(v) => updateWorkspace({ editorApp: v })}
            />
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-4 px-7 py-3"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
            {t('settings.workspace.terminal')}
          </div>
          <div style={{ width: 220 }}>
            <AppPicker
              value={draft.workspace?.terminalApp ?? ''}
              options={discoveredApps.terminals}
              placeholder={t('settings.workspace.selectTerminalPlaceholder')}
              onChange={(v) => updateWorkspace({ terminalApp: v })}
            />
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-4 px-7 py-3"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
            {t('settings.workspace.markdownDocument')}
          </div>
          <div style={{ width: 220 }}>
            <AppPicker
              value={draft.workspace?.markdownApp ?? ''}
              options={discoveredApps.markdownEditors}
              placeholder={t('settings.workspace.selectMarkdownEditorPlaceholder')}
              onChange={(v) => updateWorkspace({ markdownApp: v })}
            />
          </div>
        </div>
      </SettingSection>

      <SettingSection>
        <SettingLabel action={<PruneButton />}>{t('settings.workspace.maintenance')}</SettingLabel>
      </SettingSection>
    </div>
  )
}
