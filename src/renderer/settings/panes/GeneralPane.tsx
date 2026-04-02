import { useEffect, useRef, useState } from 'react'

import { DEFAULT_SIDEBAR_VISIBILITY } from '../../../shared/yachiyo/protocol.ts'
import type {
  SettingsConfig,
  SoulDocument,
  UpdateChannel,
  UserDocument
} from '../../../shared/yachiyo/protocol.ts'
import { theme, alpha } from '@renderer/theme/theme'
import { imeSafeEnter } from '../components/imeUtils'
import {
  SettingLabel,
  SettingRow,
  SettingSection,
  SettingSwitch,
  SimpleSelect
} from '../components/primitives'
import {
  hasPendingUserDocumentChanges,
  loadUserDocument,
  persistUserDocument
} from './userDocumentEditorModel'
import { loadSoulDocument, addSoulTrait, deleteSoulTrait } from './soulDocumentEditorModel'

interface GeneralPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function GeneralPane({ draft, onChange }: GeneralPaneProps): React.ReactNode {
  const sidebarVisibility = draft.general?.sidebarVisibility ?? DEFAULT_SIDEBAR_VISIBILITY
  const [view, setView] = useState<'overview' | 'user-document' | 'soul-document'>('overview')

  // USER.md state
  const [userDocument, setUserDocument] = useState<UserDocument | null>(null)
  const [userDraft, setUserDraft] = useState('')
  const [isLoadingUserDocument, setIsLoadingUserDocument] = useState(false)
  const [isSavingUserDocument, setIsSavingUserDocument] = useState(false)
  const [hasAttemptedUserDocumentLoad, setHasAttemptedUserDocumentLoad] = useState(false)
  const [userDocumentError, setUserDocumentError] = useState<string | null>(null)

  // SOUL.md state
  const [soulDocument, setSoulDocument] = useState<SoulDocument | null>(null)
  const [isLoadingSoul, setIsLoadingSoul] = useState(false)
  const [hasAttemptedSoulLoad, setHasAttemptedSoulLoad] = useState(false)
  const [soulError, setSoulError] = useState<string | null>(null)
  const [newTrait, setNewTrait] = useState('')
  const [isAddingTrait, setIsAddingTrait] = useState(false)
  const [deletingTrait, setDeletingTrait] = useState<string | null>(null)
  const newTraitInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (
      view !== 'user-document' ||
      userDocument ||
      isLoadingUserDocument ||
      hasAttemptedUserDocumentLoad
    ) {
      return
    }

    let cancelled = false
    setIsLoadingUserDocument(true)
    setHasAttemptedUserDocumentLoad(true)
    setUserDocumentError(null)

    void loadUserDocument()
      .then((document) => {
        if (cancelled) {
          return
        }

        setUserDocument(document)
        setUserDraft(document.content)
      })
      .catch((reason) => {
        if (cancelled) {
          return
        }

        setUserDocumentError(reason instanceof Error ? reason.message : 'Failed to load USER.md.')
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingUserDocument(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [hasAttemptedUserDocumentLoad, isLoadingUserDocument, userDocument, view])

  useEffect(() => {
    if (view !== 'soul-document' || soulDocument || isLoadingSoul || hasAttemptedSoulLoad) {
      return
    }

    let cancelled = false
    setIsLoadingSoul(true)
    setHasAttemptedSoulLoad(true)
    setSoulError(null)

    void loadSoulDocument()
      .then((doc) => {
        if (!cancelled) {
          setSoulDocument(doc)
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setSoulError(reason instanceof Error ? reason.message : 'Failed to load SOUL.md.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSoul(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [hasAttemptedSoulLoad, isLoadingSoul, soulDocument, view])

  const hasPendingUserChanges = hasPendingUserDocumentChanges(
    userDocument?.content ?? '',
    userDraft
  )

  const handleSaveUserDocument = async (): Promise<void> => {
    if (isSavingUserDocument) {
      return
    }

    setIsSavingUserDocument(true)
    setUserDocumentError(null)

    try {
      const saved = await persistUserDocument(userDraft)
      setUserDocument(saved)
      setUserDraft(saved.content)
    } catch (reason) {
      setUserDocumentError(reason instanceof Error ? reason.message : 'Failed to save USER.md.')
    } finally {
      setIsSavingUserDocument(false)
    }
  }

  const handleAddTrait = async (): Promise<void> => {
    const trait = newTrait.trim()
    if (!trait || isAddingTrait) {
      return
    }

    setIsAddingTrait(true)
    setSoulError(null)

    try {
      const updated = await addSoulTrait(trait)
      setSoulDocument(updated)
      setNewTrait('')
      newTraitInputRef.current?.focus()
    } catch (reason) {
      setSoulError(reason instanceof Error ? reason.message : 'Failed to add trait.')
    } finally {
      setIsAddingTrait(false)
    }
  }

  const handleDeleteTrait = async (trait: string): Promise<void> => {
    if (deletingTrait) {
      return
    }

    setDeletingTrait(trait)
    setSoulError(null)

    try {
      const updated = await deleteSoulTrait(trait)
      setSoulDocument(updated)
    } catch (reason) {
      setSoulError(reason instanceof Error ? reason.message : 'Failed to remove trait.')
    } finally {
      setDeletingTrait(null)
    }
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
                setHasAttemptedUserDocumentLoad(false)
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
              disabled={!hasPendingUserChanges || isSavingUserDocument}
              onClick={() => setUserDraft(userDocument?.content ?? '')}
            >
              Revert
            </button>
            <button
              type="button"
              className="text-sm font-medium transition-opacity"
              style={{
                color: theme.text.accent,
                opacity: !hasPendingUserChanges || isSavingUserDocument ? 0.4 : 1
              }}
              disabled={!hasPendingUserChanges || isSavingUserDocument}
              onClick={() => void handleSaveUserDocument()}
            >
              {isSavingUserDocument ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        <div className="px-7 pb-4">
          <textarea
            value={userDraft}
            onChange={(e) => setUserDraft(e.target.value)}
            className="min-h-120 w-full resize-y rounded-xl px-4 py-3 text-sm leading-6 outline-none"
            style={{
              color: theme.text.primary,
              background: alpha('ink', 0.04),
              border: 'none'
            }}
            spellCheck={false}
            disabled={isLoadingUserDocument}
            aria-label="USER.md editor"
          />

          <div className="mt-2 text-sm leading-5" style={{ color: theme.text.tertiary }}>
            Avoid temporary task notes, chat transcripts, or raw memory recall dumps here.
          </div>

          {isLoadingUserDocument ? (
            <div className="mt-2 text-sm" style={{ color: theme.text.muted }}>
              Loading USER.md...
            </div>
          ) : null}

          {userDocumentError ? (
            <div className="mt-2 text-sm" style={{ color: '#c25151' }}>
              {userDocumentError}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  if (view === 'soul-document') {
    const traits = soulDocument?.evolvedTraits ?? []

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-7 pt-5 pb-4">
          <button
            type="button"
            className="text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => {
              setView('overview')
              setHasAttemptedSoulLoad(false)
              setSoulDocument(null)
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

        {isLoadingSoul ? (
          <div className="px-7 text-sm" style={{ color: theme.text.muted }}>
            Loading SOUL.md...
          </div>
        ) : (
          <>
            {traits.length > 0 ? (
              <div style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
                {traits.map((trait) => (
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
                      disabled={deletingTrait === trait}
                      onClick={() => void handleDeleteTrait(trait)}
                      aria-label={`Remove trait: ${trait}`}
                    >
                      {deletingTrait === trait ? '...' : '×'}
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
                ref={newTraitInputRef}
                type="text"
                value={newTrait}
                onChange={(e) => setNewTrait(e.target.value)}
                onKeyDown={imeSafeEnter(() => void handleAddTrait())}
                placeholder="Add a trait..."
                className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                style={{
                  background: alpha('ink', 0.04),
                  border: 'none',
                  color: theme.text.primary
                }}
                disabled={isAddingTrait}
              />
              <button
                type="button"
                className="shrink-0 text-sm font-medium transition-opacity"
                style={{
                  color: theme.text.accent,
                  opacity: !newTrait.trim() || isAddingTrait ? 0.35 : 1
                }}
                disabled={!newTrait.trim() || isAddingTrait}
                onClick={() => void handleAddTrait()}
              >
                {isAddingTrait ? 'Adding...' : 'Add'}
              </button>
            </div>

            {soulError ? (
              <div className="px-7 pb-3 text-sm" style={{ color: '#c25151' }}>
                {soulError}
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
        <SettingLabel>Notifications</SettingLabel>

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
        <SettingLabel>Window layout</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Show sidebar on launch
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Off starts focused on the conversation.
            </div>
          </div>

          <div className="shrink-0">
            <SettingSwitch
              checked={sidebarVisibility === 'expanded'}
              onChange={() =>
                onChange({
                  ...draft,
                  general: {
                    ...draft.general,
                    sidebarVisibility: sidebarVisibility === 'expanded' ? 'collapsed' : 'expanded'
                  }
                })
              }
              ariaLabel="Toggle sidebar visibility on launch"
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
