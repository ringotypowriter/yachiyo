import type { ReactNode } from 'react'
import { Activity, Eye, EyeOff, PanelLeft } from 'lucide-react'
import { tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import type { Thread } from '@renderer/app/types'
import { Tooltip } from '@renderer/components/Tooltip'
import { ThreadHeaderActions } from '@renderer/features/layout/components/ThreadHeaderActions'
import { ThreadHeaderTitle } from '@renderer/features/layout/components/ThreadHeaderTitle'
import { shouldShowCenteredHeaderAccessory } from '@renderer/features/layout/lib/mainPanelHeaderLayout'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { theme } from '@renderer/theme/theme'

export interface AppMainPanelHeaderProps {
  activeThread: Thread | null
  headerPaddingLeft: number
  isBootstrapping: boolean
  isInspectionPanelOpen: boolean
  isPrivacyMode: boolean
  isPrivacyToggleLocked: boolean
  isReadOnly?: boolean
  isRunning?: boolean
  isSaving?: boolean
  isSidebarToggleDisabled: boolean
  isStarred?: boolean
  hideThreadActions?: boolean
  centerAccessory?: ReactNode
  messageCount: number
  onOpenThreadWorkspace: () => Promise<void>
  onOpenInEditor?: () => Promise<void>
  onOpenInTerminal?: () => Promise<void>
  onSelectThreadOperation: (operationKey: ThreadContextOperationKey) => void
  onToggleInspectionPanel: () => void
  onTogglePrivacyMode: () => void
  onToggleSidebar: () => void
  showSidebarToggle: boolean
  toggleSidebarTitle: string
}

export function AppMainPanelHeader({
  activeThread,
  headerPaddingLeft,
  isBootstrapping,
  isInspectionPanelOpen,
  isPrivacyMode,
  isPrivacyToggleLocked,
  isReadOnly = false,
  isRunning,
  isSaving,
  isSidebarToggleDisabled,
  isStarred,
  hideThreadActions = false,
  centerAccessory,
  messageCount,
  onOpenThreadWorkspace,
  onOpenInEditor,
  onOpenInTerminal,
  onSelectThreadOperation,
  onToggleInspectionPanel,
  onTogglePrivacyMode,
  onToggleSidebar,
  showSidebarToggle,
  toggleSidebarTitle
}: AppMainPanelHeaderProps): React.JSX.Element {
  const t = useT()
  const showCenteredAccessory = shouldShowCenteredHeaderAccessory({
    showSidebarToggle,
    hasCenterAccessory: centerAccessory != null
  })

  return (
    <div
      className="flex h-full min-w-0 flex-1 items-center"
      style={{
        paddingLeft: `${headerPaddingLeft}px`,
        paddingRight: '20px',
        position: 'relative'
      }}
    >
      {/* Left zone: sidebar toggle */}
      {showSidebarToggle ? (
        <button
          disabled={isSidebarToggleDisabled}
          onClick={onToggleSidebar}
          className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity no-drag shrink-0 disabled:opacity-30"
          style={{ color: theme.icon.default, marginTop: -4 }}
          title={toggleSidebarTitle}
          aria-label={toggleSidebarTitle}
        >
          <PanelLeft size={16} strokeWidth={1.5} />
        </button>
      ) : null}

      {/* Title + workspace buttons — centered when sidebar off, left when sidebar on */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: showSidebarToggle ? 'center' : 'flex-start',
          paddingLeft: showSidebarToggle ? '80px' : `${headerPaddingLeft}px`,
          paddingRight: '80px',
          pointerEvents: 'none'
        }}
      >
        <div className="no-drag" style={{ pointerEvents: 'auto', minWidth: 0, overflow: 'hidden' }}>
          {showCenteredAccessory ? (
            centerAccessory
          ) : (
            <ThreadHeaderTitle
              activeThread={activeThread}
              centered={showSidebarToggle}
              onOpenThreadWorkspace={onOpenThreadWorkspace}
              onOpenInEditor={onOpenInEditor}
              onOpenInTerminal={onOpenInTerminal}
            />
          )}
        </div>
      </div>

      {/* Center status — absolutely centered, only when sidebar is open */}
      {!showSidebarToggle && activeThread ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none'
          }}
        >
          {centerAccessory ? (
            <div className="no-drag" style={{ pointerEvents: 'auto' }}>
              {centerAccessory}
            </div>
          ) : (
            <span className="text-xs font-medium" style={{ color: theme.text.muted }}>
              {isBootstrapping
                ? t('layout.header.loadingWorkspace')
                : messageCount > 0
                  ? tPlural('layout.header.messageCount', messageCount)
                  : t('layout.header.noMessagesYet')}
            </span>
          )}
        </div>
      ) : null}

      {/* Right zone: actions */}
      <div className="flex items-center gap-1 no-drag ml-auto" style={{ position: 'relative' }}>
        {activeThread && !isReadOnly && !hideThreadActions ? (
          <Tooltip
            content={
              <PrivacyTooltipContent
                isPrivacyMode={isPrivacyMode}
                isLocked={isPrivacyToggleLocked}
              />
            }
          >
            <button
              onClick={isPrivacyToggleLocked ? undefined : onTogglePrivacyMode}
              className="p-1.5 rounded-md transition-opacity no-drag shrink-0"
              style={{
                color: isPrivacyMode ? theme.text.accent : theme.icon.default,
                opacity: isPrivacyToggleLocked
                  ? isPrivacyMode
                    ? 1
                    : 0.25
                  : isPrivacyMode
                    ? 1
                    : 0.45
              }}
              aria-label={
                isPrivacyToggleLocked
                  ? isPrivacyMode
                    ? t('layout.header.privacy.lockedOn')
                    : t('layout.header.privacy.lockedOff')
                  : isPrivacyMode
                    ? t('layout.header.privacy.on')
                    : t('layout.header.privacy.off')
              }
              aria-pressed={isPrivacyMode}
            >
              {isPrivacyMode ? (
                <EyeOff size={16} strokeWidth={1.5} />
              ) : (
                <Eye size={16} strokeWidth={1.5} />
              )}
            </button>
          </Tooltip>
        ) : null}
        {activeThread && !isReadOnly && !hideThreadActions ? (
          <Tooltip
            content={
              isInspectionPanelOpen
                ? t('layout.header.closeRunInspector')
                : t('layout.header.openRunInspector')
            }
          >
            <button
              onClick={onToggleInspectionPanel}
              className="p-1.5 rounded-md transition-opacity no-drag shrink-0"
              style={{
                color: isInspectionPanelOpen ? theme.text.accent : theme.icon.default,
                opacity: isInspectionPanelOpen ? 1 : 0.45
              }}
              aria-label={
                isInspectionPanelOpen
                  ? t('layout.header.closeRunInspector')
                  : t('layout.header.openRunInspector')
              }
              aria-pressed={isInspectionPanelOpen}
            >
              <Activity size={16} strokeWidth={1.5} />
            </button>
          </Tooltip>
        ) : null}
        {!hideThreadActions ? (
          <ThreadHeaderActions
            activeThread={activeThread}
            isRenameDisabled={false}
            isRunning={isRunning}
            isSaving={isSaving}
            isStarred={isStarred}
            onSelectOperation={onSelectThreadOperation}
          />
        ) : null}
      </div>
    </div>
  )
}

function PrivacyTooltipContent({
  isPrivacyMode,
  isLocked
}: {
  isPrivacyMode: boolean
  isLocked: boolean
}): React.JSX.Element {
  const t = useT()
  const label = isLocked
    ? isPrivacyMode
      ? t('layout.header.privacy.lockedOn')
      : t('layout.header.privacy.lockedOff')
    : isPrivacyMode
      ? t('layout.header.privacy.on')
      : t('layout.header.privacy.off')
  const description = isLocked
    ? isPrivacyMode
      ? t('layout.header.privacy.descLockedOn')
      : t('layout.header.privacy.descLockedOff')
    : isPrivacyMode
      ? t('layout.header.privacy.descOn')
      : t('layout.header.privacy.descOff')

  return (
    <div style={{ minWidth: 200, whiteSpace: 'normal' }}>
      <div
        style={{
          fontWeight: 600,
          fontSize: 12,
          color: isPrivacyMode ? theme.text.accent : theme.text.primary,
          marginBottom: 2
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 11, color: theme.text.muted, lineHeight: 1.5 }}>{description}</div>
    </div>
  )
}
