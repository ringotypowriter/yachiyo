import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  SettingsConfig,
  SoulDocument,
  UpdateChannel,
  UserDocument
} from '@yachiyo/shared/protocol'
import { useT } from '@yachiyo/i18n/react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { useAppDialog } from '@renderer/components/AppDialogContext'
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
import { hasPendingSoulDocumentChanges, toSoulTraitTexts } from './soulDocumentEditorModel'
import { UserDocumentTableEditor } from './UserDocumentTableEditor'
import { hasPendingUserDocumentChanges } from './userDocumentEditorModel'
import { hasEnabledChatModel, LAUNCH_AT_LOGIN_PROMPT } from './behaviorPaneModel'

interface BehaviorPaneProps {
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
  onActivateChat: () => void
  onNavigateToRoute: (route: string) => void
}

export function BehaviorPane({
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
  onRevertSoulDocument,
  onActivateChat,
  onNavigateToRoute
}: BehaviorPaneProps): React.ReactNode {
  const [view, setView] = useState<'overview' | 'user-document' | 'soul-document'>('overview')
  const t = useT()
  const dialog = useAppDialog()
  const config = useAppStore((state) => state.config)
  const createNewThread = useAppStore((state) => state.createNewThread)
  const sendMessage = useAppStore((state) => state.sendMessage)

  const hasAttemptedUserDocumentLoadRef = useRef(false)

  // SOUL.md state
  const hasAttemptedSoulLoadRef = useRef(false)
  const [newTrait, setNewTrait] = useState('')
  const hasPendingUserChanges =
    userDraft !== null && hasPendingUserDocumentChanges(userDocument?.content ?? '', userDraft)
  const savedSoulTraits = toSoulTraitTexts(soulDocument?.evolvedTraits)
  const soulTraits = soulDraftTraits ?? savedSoulTraits
  const hasPendingSoulChanges =
    soulDraftTraits !== null && hasPendingSoulDocumentChanges(savedSoulTraits, soulDraftTraits)

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

  const handleLaunchAtLogin = useCallback(async (): Promise<void> => {
    if (!hasEnabledChatModel(config?.providers ?? [])) {
      const openProviders = await dialog.confirm({
        title: t('settings.behavior.modelFirstDialogTitle'),
        message: t('settings.behavior.modelFirstDialogMessage'),
        confirmLabel: t('settings.behavior.openProvidersButton'),
        cancelLabel: t('settings.behavior.notNowButton')
      })
      if (openProviders) {
        onNavigateToRoute('providers')
      }
      return
    }

    const confirmed = await dialog.confirm({
      title: t('settings.behavior.launchDialogTitle'),
      message: t('settings.behavior.launchDialogMessage'),
      confirmLabel: t('settings.behavior.setUpConfirm'),
      cancelLabel: t('common.cancel')
    })
    if (!confirmed) {
      return
    }

    let threadId: string | null = null
    try {
      await createNewThread()
      threadId = useAppStore.getState().activeThreadId
    } catch {
      threadId = null
    }

    if (!threadId) {
      await dialog.alert({
        title: t('settings.behavior.setupFailedTitle'),
        message: t('settings.behavior.setupFailedCreateThread')
      })
      return
    }

    onActivateChat()
    let sent = false
    try {
      sent = await sendMessage('normal', {
        threadId,
        content: LAUNCH_AT_LOGIN_PROMPT,
        images: [],
        attachments: []
      })
    } catch {
      sent = false
    }
    if (!sent) {
      await dialog.alert({
        title: t('settings.behavior.setupFailedTitle'),
        message: t('settings.behavior.setupFailedSendMessage')
      })
    }
  }, [
    config?.providers,
    createNewThread,
    dialog,
    onActivateChat,
    onNavigateToRoute,
    sendMessage,
    t
  ])

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
              {`← ${t('settings.nav.behavior')}`}
            </button>
            <div className="text-lg font-semibold" style={{ color: theme.text.primary }}>
              USER.md
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.behavior.userDocPageDesc')}
            </div>
            {userDocument?.filePath ? (
              <div
                className="content-selectable text-xs leading-5 break-all"
                style={{ color: theme.text.muted }}
              >
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
              {t('settings.behavior.revert')}
            </button>
          </div>
        </div>

        <div className="pb-4">
          <UserDocumentTableEditor content={userDraft ?? ''} onChange={onUserDraftChange} />

          {isLoadingUserDocument ? (
            <div className="mt-2 px-7 text-sm" style={{ color: theme.text.muted }}>
              {t('settings.behavior.loadingUserDoc')}
            </div>
          ) : null}

          {userDocumentError ? (
            <div className="mt-2 px-7 text-sm" style={{ color: theme.text.dangerStrong }}>
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
            {`← ${t('settings.nav.behavior')}`}
          </button>
          <div className="mt-1 text-lg font-semibold" style={{ color: theme.text.primary }}>
            SOUL.md
          </div>
          <div className="mt-0.5 text-sm leading-5" style={{ color: theme.text.tertiary }}>
            {t('settings.behavior.soulDocPageDesc')}
          </div>
          {soulDocument?.filePath ? (
            <div
              className="content-selectable mt-0.5 text-xs leading-5 break-all"
              style={{ color: theme.text.muted }}
            >
              {soulDocument.filePath}
            </div>
          ) : null}
        </div>

        {isLoadingSoulDocument ? (
          <div className="px-7 text-sm" style={{ color: theme.text.muted }}>
            {t('settings.behavior.loadingSoulDoc')}
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
                {t('settings.behavior.revert')}
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
                      aria-label={t('settings.behavior.removeTraitAria', { trait })}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-7 py-3 text-sm" style={{ color: theme.text.muted }}>
                {t('settings.behavior.noTraits')}
              </div>
            )}

            <div className="px-7 py-4 flex items-center gap-3">
              <input
                type="text"
                value={newTrait}
                onChange={(e) => setNewTrait(e.target.value)}
                onKeyDown={imeSafeEnter(() => handleAddTrait())}
                placeholder={t('settings.behavior.addTraitPlaceholder')}
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
                {t('common.add')}
              </button>
            </div>

            {soulDocumentError ? (
              <div className="px-7 pb-3 text-sm" style={{ color: theme.text.dangerStrong }}>
                {soulDocumentError}
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  }

  const updateChannel: UpdateChannel = draft.general?.updateChannel ?? 'stable'
  const isMac = window.api.process.platform === 'darwin'
  const preventSystemSleep = draft.general?.preventSystemSleep === true
  const notifyRunCompleted = draft.general?.notifyRunCompleted !== false
  const notifyCodingTaskStarted = draft.general?.notifyCodingTaskStarted !== false
  const notifyCodingTaskFinished = draft.general?.notifyCodingTaskFinished !== false

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>{t('settings.behavior.updatesSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.behavior.updateChannelLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {updateChannel === 'beta'
                ? t('settings.behavior.updateChannelBetaDesc')
                : t('settings.behavior.updateChannelStableDesc')}
            </div>
          </div>

          <div className="shrink-0">
            <SimpleSelect
              value={updateChannel}
              options={[
                { value: 'stable' as const, label: t('settings.behavior.updateChannelStable') },
                { value: 'beta' as const, label: t('settings.behavior.updateChannelBeta') }
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
        <SettingLabel>{t('settings.behavior.startupSection')}</SettingLabel>

        {isMac ? (
          <SettingRow>
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {t('settings.behavior.keepAwakeLabel')}
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                {t('settings.behavior.keepAwakeDesc')}
              </div>
            </div>

            <div className="shrink-0">
              <SettingSwitch
                checked={preventSystemSleep}
                onChange={() =>
                  onChange({
                    ...draft,
                    general: { ...draft.general, preventSystemSleep: !preventSystemSleep }
                  })
                }
                ariaLabel={t('settings.behavior.keepAwakeToggleAria')}
              />
            </div>
          </SettingRow>
        ) : null}

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.behavior.launchAtLoginLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.behavior.launchAtLoginDesc')}
            </div>
          </div>

          <button
            type="button"
            className="shrink-0 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => void handleLaunchAtLogin()}
          >
            {t('settings.behavior.setUpButton')}
          </button>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel
          action={
            <button
              className="text-[11px] font-medium hover:underline "
              style={{ color: theme.text.secondary }}
              onClick={() =>
                window.open(
                  'x-apple.systempreferences:com.apple.Notifications-Settings?id=sh.ringo.yachiyo'
                )
              }
            >
              {t('settings.behavior.systemSettingsButton')}
            </button>
          }
        >
          {t('settings.behavior.notificationsSection')}
        </SettingLabel>

        {(
          [
            {
              key: 'notifyRunCompleted',
              checked: notifyRunCompleted,
              label: t('settings.behavior.notifyRunCompletedLabel'),
              description: t('settings.behavior.notifyRunCompletedDesc')
            },
            {
              key: 'notifyCodingTaskStarted',
              checked: notifyCodingTaskStarted,
              label: t('settings.behavior.notifyCodingStartedLabel'),
              description: t('settings.behavior.notifyCodingStartedDesc')
            },
            {
              key: 'notifyCodingTaskFinished',
              checked: notifyCodingTaskFinished,
              label: t('settings.behavior.notifyCodingFinishedLabel'),
              description: t('settings.behavior.notifyCodingFinishedDesc')
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
                ariaLabel={t('settings.behavior.notifyToggleAria', { label })}
              />
            </div>
          </SettingRow>
        ))}
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.behavior.shortcutsSection')}</SettingLabel>

        {(
          [
            {
              key: 'translatorShortcut' as const,
              label: t('settings.behavior.translatorShortcutLabel'),
              description: t('settings.behavior.translatorShortcutDesc')
            },
            {
              key: 'jotdownShortcut' as const,
              label: t('settings.behavior.jotdownShortcutLabel'),
              description: t('settings.behavior.jotdownShortcutDesc')
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
            {t('settings.behavior.resetShortcuts')}
          </button>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.behavior.personalizationSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              USER.md
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.behavior.userDocDesc')}
            </div>
          </div>

          <button
            type="button"
            className="shrink-0 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => setView('user-document')}
          >
            {t('settings.behavior.openEditorButton')}
          </button>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              SOUL.md
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.behavior.soulDocDesc')}
            </div>
          </div>

          <button
            type="button"
            className="shrink-0 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={() => setView('soul-document')}
          >
            {t('settings.behavior.manageTraitsButton')}
          </button>
        </SettingRow>
      </SettingSection>
    </div>
  )
}
