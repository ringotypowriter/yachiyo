import { Eye, EyeOff, PanelLeft, PanelRight } from 'lucide-react'
import type { Thread } from '@renderer/app/types'
import { Tooltip } from '@renderer/components/Tooltip'
import { ThreadHeaderActions } from '@renderer/features/layout/components/ThreadHeaderActions'
import { ThreadHeaderTitle } from '@renderer/features/layout/components/ThreadHeaderTitle'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { theme } from '@renderer/theme/theme'

export interface AppMainPanelHeaderProps {
  activeThread: Thread | null
  headerPaddingLeft: number
  isBootstrapping: boolean
  isInspectionPanelOpen: boolean
  isMemoryEnabled: boolean
  isPrivacyMode: boolean
  isPrivacyToggleLocked: boolean
  isSidebarToggleDisabled: boolean
  messageCount: number
  onOpenThreadWorkspace: () => Promise<void>
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
  isMemoryEnabled,
  isPrivacyMode,
  isPrivacyToggleLocked,
  isSidebarToggleDisabled,
  messageCount,
  onOpenThreadWorkspace,
  onSelectThreadOperation,
  onToggleInspectionPanel,
  onTogglePrivacyMode,
  onToggleSidebar,
  showSidebarToggle,
  toggleSidebarTitle
}: AppMainPanelHeaderProps): React.JSX.Element {
  return (
    <div
      className="flex items-center shrink-0 drag-region"
      style={{
        height: '48px',
        paddingLeft: `${headerPaddingLeft}px`,
        paddingRight: '20px',
        borderBottom: `1px solid ${theme.border.default}`,
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

      {/* Title: centered when sidebar is hidden, left-aligned when sidebar is open */}
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
        <div style={{ pointerEvents: 'auto', minWidth: 0, overflow: 'hidden' }}>
          <ThreadHeaderTitle
            activeThread={activeThread}
            isBootstrapping={isBootstrapping}
            messageCount={messageCount}
            onOpenThreadWorkspace={onOpenThreadWorkspace}
            showSubtitle={!showSidebarToggle}
          />
        </div>
      </div>

      {/* Right zone: actions */}
      <div className="flex items-center gap-1 no-drag ml-auto" style={{ position: 'relative' }}>
        {activeThread ? (
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
                opacity: isPrivacyToggleLocked ? 0.25 : isPrivacyMode ? 1 : 0.45,
                cursor: isPrivacyToggleLocked ? 'not-allowed' : 'pointer'
              }}
              aria-label={
                isPrivacyToggleLocked
                  ? 'Privacy mode locked'
                  : isPrivacyMode
                    ? 'Privacy mode on'
                    : 'Privacy mode off'
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
        {activeThread ? (
          <Tooltip content={isInspectionPanelOpen ? 'Close run inspector' : 'Open run inspector'}>
            <button
              onClick={onToggleInspectionPanel}
              className="p-1.5 rounded-md transition-opacity no-drag shrink-0"
              style={{
                color: isInspectionPanelOpen ? theme.text.accent : theme.icon.default,
                opacity: isInspectionPanelOpen ? 1 : 0.45
              }}
              aria-label={isInspectionPanelOpen ? 'Close run inspector' : 'Open run inspector'}
              aria-pressed={isInspectionPanelOpen}
            >
              <PanelRight size={16} strokeWidth={1.5} />
            </button>
          </Tooltip>
        ) : null}
        <ThreadHeaderActions
          activeThread={activeThread}
          isMemoryEnabled={isMemoryEnabled}
          isRenameDisabled={false}
          onSelectOperation={onSelectThreadOperation}
        />
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
  const label = isLocked
    ? 'Privacy Mode: Locked'
    : isPrivacyMode
      ? 'Privacy Mode: On'
      : 'Privacy Mode: Off'
  const description = isLocked
    ? 'Cannot change after messages are sent'
    : isPrivacyMode
      ? 'Memory recall and distillation are disabled'
      : 'Enable to hide this thread from memory'

  return (
    <div style={{ minWidth: 200, whiteSpace: 'normal' }}>
      <div
        style={{
          fontWeight: 600,
          fontSize: 12,
          color: isPrivacyMode && !isLocked ? theme.text.accent : theme.text.primary,
          marginBottom: 2
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 11, color: theme.text.muted, lineHeight: 1.5 }}>{description}</div>
    </div>
  )
}
