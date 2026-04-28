import { useEffect, useRef, useState } from 'react'

import type {
  SettingsConfig,
  SoulDocument,
  UpdateChannel,
  UserDocument
} from '../../../shared/yachiyo/protocol.ts'
import { theme, alpha } from '@renderer/theme/theme'
import { imeSafeEnter } from '@renderer/lib/imeUtils'
import {
  SettingLabel,
  SettingRow,
  SettingSection,
  SettingSwitch,
  SimpleSelect
} from '../components/primitives'
import { ShortcutRecorder } from '../components/ShortcutRecorder'
import { hasPendingSoulDocumentChanges } from './soulDocumentEditorModel'
import { UserDocumentTableEditor } from './UserDocumentTableEditor'
import { hasPendingUserDocumentChanges } from './userDocumentEditorModel'

interface GeneralPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
  userDocument: UserDocument | null
  userDraft: string | null
  isLoadingUserDocument: boolean
  userDocumentError: string | null
  onLoadUserDocument: () => Promise<void>
  onUserDraftChange: (next: string) => void
  onRevertUserDocument: () => void
  soulDocument: SoulDocument | null
  soulDraftTraits: string[] | null
  isLoadingSoulDocument: boolean
  soulDocumentError: string | null
  onLoadSoulDocument: () => Promise<void>
  onSoulDraftChange: (next: string[]) => void
  onRevertSoulDocument: () => void
}

export function GeneralPane({
  draft,
  onChange,
  userDocument,
  userDraft,
  isLoadingUserDocument,
  userDocumentError,
  onLoadUserDocument,
  onUserDraftChange,
  onRevertUserDocument,
  soulDocument,
  soulDraftTraits,
  isLoadingSoulDocument,
  soulDocumentError,
  onLoadSoulDocument,
  onSoulDraftChange,
  onRevertSoulDocument
}: GeneralPaneProps): React.ReactNode {
  const [view, setView] = useState<'overview' | 'user-document' | 'soul-document'>('overview')

  const hasAttemptedUserDocumentLoadRef = useRef(false)

  // SOUL.md state
  const hasAttemptedSoulLoadRef = useRef(false)
  const [newTrait, setNewTrait] = useState('')
  const hasPendingUserChanges =
    userDraft !== null && hasPendingUserDocumentChanges(userDocument?.content ?? '', userDraft)
  const soulTraits = soulDraftTraits ?? soulDocument?.evolvedTraits ?? []
  const hasPendingSoulChanges =
    soulDraftTraits !== null &&
    hasPendingSoulDocumentChanges(soulDocument?.evolvedTraits ?? [], soulDraftTraits)
  const isMac = window.api.process.platform === 'darwin'
  const activityTracking = draft.general?.activityTracking
  const activityTrackingMode = activityTracking?.mode ?? 'simple'
  const activityTrackingWarning =
    activityTracking?.accessibilityDenied === true
      ? activityTrackingMode === 'full'
        ? 'Full mode is not active yet. Save to ask macOS for Accessibility access.'
        : 'Full mode was not enabled. Grant Accessibility access in System Settings, then choose Full again.'
      : null
  const openAccessibilitySettings = (): void => {
    window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  }

  useEffect(() => {
    if (
      view !== 'user-document' ||
      isLoadingUserDocument ||
      hasAttemptedUserDocumentLoadRef.current ||
      hasPendingUserChanges
    ) {
      return
    }

    hasAttemptedUserDocumentLoadRef.current = true
    void onLoadUserDocument()
  }, [hasPendingUserChanges, isLoadingUserDocument, onLoadUserDocument, view])

  useEffect(() => {
    if (
      view !== 'soul-document' ||
      isLoadingSoulDocument ||
      hasAttemptedSoulLoadRef.current ||
      hasPendingSoulChanges
    ) {
      return
    }

    hasAttemptedSoulLoadRef.current = true
    void onLoadSoulDocument()
  }, [hasPendingSoulChanges, isLoadingSoulDocument, onLoadSoulDocument, view])

  const handleAddTrait = (): void => {
    const trait = newTrait.trim()
    if (!trait || soulTraits.includes(trait)) {
      return
    }

    onSoulDraftChange([...soulTraits, trait])
    setNewTrait('')
  }

  const handleDeleteTrait = (trait: string): void => {
    onSoulDraftChange(soulTraits.filter((entry) => entry !== trait))
  }

  if (view === 'user-document') {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-7 pt-5 pb-3 flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <button
              type="button"
              className="text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity opacity-60 hover:opacity-100"
              style={{ color: theme.text.accent }}
              onClick={() => {
                setView('overview')
                hasAttemptedUserDocumentLoadRef.current = false
              }}
            >
              ← General
            </button>
            <div className="text-lg font-semibold" style={{ color: theme.text.primary }}>
              USER.md
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Durable understanding of the user. Keep stable preferences, communication style, work
              style, and long-term background here.
            </div>
            {userDocument?.filePath ? (
              <div className="text-xs leading-5 break-all" style={{ color: theme.text.muted }}>
                {userDocument.filePath}
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-3 pt-1">
            <button
              type="button"
              className="text-sm font-medium transition-opacity"
              style={{
                color: theme.text.secondary,
                opacity: hasPendingUserChanges ? 0.8 : 0.3
              }}
              disabled={!hasPendingUserChanges}
              onClick={onRevertUserDocument}
            >
              Revert
            </button>
          </div>
        </div>

        <div className="pb-4">
          <UserDocumentTableEditor content={userDraft ?? ''} onChange={onUserDraftChange} />

          {isLoadingUserDocument ? (
            <div className="mt-2 px-7 text-sm" style={{ color: theme.text.muted }}>
              Loading USER.md...
            </div>
          ) : null}

          {userDocumentError ? (
            <div className="mt-2 px-7 text-sm" style={{ color: '#c25151' }}>
              {userDocumentError}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  if (view === 'soul-document') {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-7 pt-5 pb-4">
          <button
            type="button"
            className="text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => {
              setView('overview')
              hasAttemptedSoulLoadRef.current = false
            }}
          >
            ← General
          </button>
          <div className="mt-1 text-lg font-semibold" style={{ color: theme.text.primary }}>
            SOUL.md
          </div>
          <div className="mt-0.5 text-sm leading-5" style={{ color: theme.text.tertiary }}>
            Evolved traits that define Yachiyo&apos;s personality and self-model. Each trait is
            appended under today&apos;s date in the file.
          </div>
          {soulDocument?.filePath ? (
            <div className="mt-0.5 text-xs leading-5 break-all" style={{ color: theme.text.muted }}>
              {soulDocument.filePath}
            </div>
          ) : null}
        </div>

        {isLoadingSoulDocument ? (
          <div className="px-7 text-sm" style={{ color: theme.text.muted }}>
            Loading SOUL.md...
          </div>
        ) : (
          <>
            <div className="px-7 pb-2 flex items-center justify-end">
              <button
                type="button"
                className="text-sm font-medium transition-opacity"
                style={{
                  color: theme.text.secondary,
                  opacity: hasPendingSoulChanges ? 0.8 : 0.3
                }}
                disabled={!hasPendingSoulChanges}
                onClick={onRevertSoulDocument}
              >
                Revert
              </button>
            </div>

            {soulTraits.length > 0 ? (
              <div style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
                {soulTraits.map((trait) => (
                  <div
                    key={trait}
                    className="flex items-start gap-3 px-7 py-3"
                    style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
                  >
                    <div
                      className="mt-1.5 shrink-0 rounded-full"
                      style={{ width: 5, height: 5, background: theme.text.muted }}
                    />
                    <div
                      className="flex-1 min-w-0 text-sm leading-6"
                      style={{ color: theme.text.primary }}
                    >
                      {trait}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-sm transition-opacity opacity-30 hover:opacity-70"
                      style={{ color: theme.text.secondary }}
                      onClick={() => handleDeleteTrait(trait)}
                      aria-label={`Remove trait: ${trait}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-7 py-3 text-sm" style={{ color: theme.text.muted }}>
                No traits yet. Add the first one below.
              </div>
            )}

            <div className="px-7 py-4 flex items-center gap-3">
              <input
                type="text"
                value={newTrait}
                onChange={(e) => setNewTrait(e.target.value)}
                onKeyDown={imeSafeEnter(() => handleAddTrait())}
                placeholder="Add a trait..."
                className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                style={{
                  background: alpha('ink', 0.04),
                  border: 'none',
                  color: theme.text.primary
                }}
              />
              <button
                type="button"
                className="shrink-0 text-sm font-medium transition-opacity"
                style={{
                  color: theme.text.accent,
                  opacity: !newTrait.trim() || soulTraits.includes(newTrait.trim()) ? 0.35 : 1
                }}
                disabled={!newTrait.trim() || soulTraits.includes(newTrait.trim())}
                onClick={handleAddTrait}
              >
                Add
              </button>
            </div>

            {soulDocumentError ? (
              <div className="px-7 pb-3 text-sm" style={{ color: '#c25151' }}>
                {soulDocumentError}
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  }

  const updateChannel: UpdateChannel = draft.general?.updateChannel ?? 'stable'
  const notifyRunCompleted = draft.general?.notifyRunCompleted !== false
  const notifyCodingTaskStarted = draft.general?.notifyCodingTaskStarted !== false
  const notifyCodingTaskFinished = draft.general?.notifyCodingTaskFinished !== false

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>Updates</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Update channel
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {updateChannel === 'beta'
                ? 'Includes pre-releases and stable releases.'
                : 'Only checks for stable releases.'}
            </div>
          </div>

          <div className="shrink-0">
            <SimpleSelect
              value={updateChannel}
              options={[
                { value: 'stable' as const, label: 'Stable' },
                { value: 'beta' as const, label: 'Beta' }
              ]}
              onChange={(channel) => {
                onChange({
                  ...draft,
                  general: { ...draft.general, updateChannel: channel }
                })
                window.api.appUpdate.setChannel(channel)
              }}
              width={120}
            />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel
          action={
            <button
              className="text-[11px] font-medium hover:underline cursor-pointer"
              style={{ color: theme.text.secondary }}
              onClick={() =>
                window.open(
                  'x-apple.systempreferences:com.apple.Notifications-Settings?id=sh.ringo.yachiyo'
                )
              }
            >
              System Settings…
            </button>
          }
        >
          Notifications
        </SettingLabel>

        {(
          [
            {
              key: 'notifyRunCompleted',
              checked: notifyRunCompleted,
              label: 'Run completed',
              description: 'Off to silence when the app is in the background.'
            },
            {
              key: 'notifyCodingTaskStarted',
              checked: notifyCodingTaskStarted,
              label: 'Coding task started',
              description: 'Notifies when a subagent picks up a coding task.'
            },
            {
              key: 'notifyCodingTaskFinished',
              checked: notifyCodingTaskFinished,
              label: 'Coding task finished',
              description: 'Notifies when a subagent completes a coding task.'
            }
          ] as const
        ).map(({ key, checked, label, description }) => (
          <SettingRow key={key}>
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {label}
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                {description}
              </div>
            </div>
            <div className="shrink-0">
              <SettingSwitch
                checked={checked}
                onChange={() =>
                  onChange({
                    ...draft,
                    general: { ...draft.general, [key]: !checked }
                  })
                }
                ariaLabel={`Toggle ${label} notification`}
              />
            </div>
          </SettingRow>
        ))}
      </SettingSection>

      <SettingSection>
        <SettingLabel>Global shortcuts</SettingLabel>

        {(
          [
            {
              key: 'translatorShortcut' as const,
              label: 'Translator shortcut',
              description: 'Global shortcut to open the translator float window.'
            },
            {
              key: 'jotdownShortcut' as const,
              label: 'Jot Down shortcut',
              description: 'Global shortcut to open the jot-down float window.'
            }
          ] as const
        ).map(({ key, label, description }) => (
          <SettingRow key={key}>
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {label}
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                {description}
              </div>
            </div>
            <ShortcutRecorder
              value={draft.general?.[key] ?? ''}
              onChange={(next) =>
                onChange({
                  ...draft,
                  general: { ...draft.general, [key]: next }
                })
              }
            />
          </SettingRow>
        ))}

        <SettingRow>
          <div />
          <button
            type="button"
            className="shrink-0 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() =>
              onChange({
                ...draft,
                general: {
                  ...draft.general,
                  translatorShortcut: 'CommandOrControl+Shift+T',
                  jotdownShortcut: 'CommandOrControl+Shift+J'
                }
              })
            }
          >
            Reset to defaults
          </button>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel
          action={
            isMac ? (
              <button
                className="text-[11px] font-medium hover:underline cursor-pointer"
                style={{ color: theme.text.secondary }}
                onClick={openAccessibilitySettings}
              >
                Accessibility Settings…
              </button>
            ) : undefined
          }
        >
          Activity tracking
        </SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Mode
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {activityTrackingMode === 'full'
                ? 'Records which app and window title you use between LLM runs. Requires Accessibility.'
                : activityTrackingMode === 'simple'
                  ? 'Records which app you use between LLM runs. No extra permissions needed.'
                  : 'No activity tracking.'}
            </div>
            {activityTrackingWarning ? (
              <div className="text-xs leading-4 mt-0.5" style={{ color: '#c25151' }}>
                {activityTrackingWarning}
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <SimpleSelect
              value={activityTrackingMode}
              options={[
                { value: 'off' as const, label: 'Off' },
                { value: 'simple' as const, label: 'Simple' },
                { value: 'full' as const, label: 'Full' }
              ]}
              onChange={(mode) => {
                onChange({
                  ...draft,
                  general: {
                    ...draft.general,
                    activityTracking: { mode }
                  }
                })
              }}
              width={130}
            />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Personalization</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              USER.md
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Edit Yachiyo&apos;s durable understanding of you in a dedicated file.
            </div>
          </div>

          <button
            type="button"
            className="shrink-0 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => setView('user-document')}
          >
            Open editor →
          </button>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              SOUL.md
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Manage the evolved traits that shape Yachiyo&apos;s personality.
            </div>
          </div>

          <button
            type="button"
            className="shrink-0 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => setView('soul-document')}
          >
            Manage traits →
          </button>
        </SettingRow>
      </SettingSection>
    </div>
  )
}
