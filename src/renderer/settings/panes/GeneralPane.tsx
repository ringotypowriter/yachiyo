import { useEffect, useState } from 'react'

import { DEFAULT_SIDEBAR_VISIBILITY } from '../../../shared/yachiyo/protocol.ts'
import type { SettingsConfig, UserDocument } from '../../../shared/yachiyo/protocol.ts'
import { theme } from '@renderer/theme/theme'
import { SettingSwitch } from '../components/primitives'
import { settingsPanelStyle } from '../components/styles'
import {
  hasPendingUserDocumentChanges,
  loadUserDocument,
  persistUserDocument
} from './userDocumentEditorModel'

interface GeneralPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function GeneralPane({ draft, onChange }: GeneralPaneProps): React.ReactNode {
  const sidebarVisibility = draft.general?.sidebarVisibility ?? DEFAULT_SIDEBAR_VISIBILITY
  const [view, setView] = useState<'overview' | 'user-document'>('overview')
  const [userDocument, setUserDocument] = useState<UserDocument | null>(null)
  const [userDraft, setUserDraft] = useState('')
  const [isLoadingUserDocument, setIsLoadingUserDocument] = useState(false)
  const [isSavingUserDocument, setIsSavingUserDocument] = useState(false)
  const [hasAttemptedUserDocumentLoad, setHasAttemptedUserDocumentLoad] = useState(false)
  const [userDocumentError, setUserDocumentError] = useState<string | null>(null)

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

  if (view === 'user-document') {
    return (
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-4xl">
          <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <button
                  type="button"
                  className="text-[11px] font-semibold uppercase tracking-[0.18em]"
                  style={{ color: theme.text.muted }}
                  onClick={() => {
                    setView('overview')
                    setHasAttemptedUserDocumentLoad(false)
                  }}
                >
                  Back to General
                </button>
                <div className="text-lg font-semibold" style={{ color: theme.text.primary }}>
                  USER.md
                </div>
                <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                  Durable understanding of the user. Keep stable preferences, communication style,
                  work style, and long-term background here.
                </div>
                {userDocument?.filePath ? (
                  <div className="text-xs leading-5 break-all" style={{ color: theme.text.muted }}>
                    {userDocument.filePath}
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="rounded-full px-3 py-1.5 text-sm font-medium transition-opacity"
                  style={{
                    color: theme.text.secondary,
                    border: `1px solid ${theme.border.default}`,
                    opacity: hasPendingUserChanges ? 1 : 0.5
                  }}
                  disabled={!hasPendingUserChanges || isSavingUserDocument}
                  onClick={() => setUserDraft(userDocument?.content ?? '')}
                >
                  Revert
                </button>
                <button
                  type="button"
                  className="rounded-full px-3 py-1.5 text-sm font-medium"
                  style={{
                    background: theme.text.primary,
                    color: theme.background.app,
                    opacity: !hasPendingUserChanges || isSavingUserDocument ? 0.6 : 1
                  }}
                  disabled={!hasPendingUserChanges || isSavingUserDocument}
                  onClick={() => void handleSaveUserDocument()}
                >
                  {isSavingUserDocument ? 'Saving...' : 'Save USER.md'}
                </button>
              </div>
            </div>

            <div className="mt-4">
              <textarea
                value={userDraft}
                onChange={(event) => setUserDraft(event.target.value)}
                className="min-h-120 w-full resize-y rounded-3xl px-4 py-4 text-sm leading-6 outline-none"
                style={{
                  color: theme.text.primary,
                  background: theme.background.surfaceLight,
                  border: `1px solid ${theme.border.default}`
                }}
                spellCheck={false}
                disabled={isLoadingUserDocument}
                aria-label="USER.md editor"
              />
            </div>

            <div className="mt-3 text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Avoid temporary task notes, chat transcripts, or raw memory recall dumps here.
            </div>

            {isLoadingUserDocument ? (
              <div className="mt-3 text-sm" style={{ color: theme.text.muted }}>
                Loading USER.md...
              </div>
            ) : null}

            {userDocumentError ? (
              <div className="mt-3 text-sm" style={{ color: '#c25151' }}>
                {userDocumentError}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl">
        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: theme.text.muted }}
          >
            Window layout
          </div>

          <div
            className="mt-3 flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
            style={{
              background: theme.background.surfaceLight,
              border: `1px solid ${theme.border.default}`
            }}
          >
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
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
          </div>

          <div
            className="mt-3 flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
            style={{
              background: theme.background.surfaceLight,
              border: `1px solid ${theme.border.default}`
            }}
          >
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                USER.md
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                Edit Yachiyo&apos;s durable understanding of you in a dedicated file.
              </div>
            </div>

            <button
              type="button"
              className="shrink-0 rounded-full px-3 py-1.5 text-sm font-medium"
              style={{
                color: theme.text.primary,
                border: `1px solid ${theme.border.default}`,
                background: theme.background.app
              }}
              onClick={() => setView('user-document')}
            >
              Open editor
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
