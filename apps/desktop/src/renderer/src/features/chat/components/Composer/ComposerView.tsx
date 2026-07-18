import type React from 'react'
import {
  AlertCircle,
  Brain,
  ChevronDown,
  CircleCheck,
  Cpu,
  Folder,
  LoaderCircle,
  Map,
  MessageSquare,
  Paperclip,
  SendHorizonal,
  Sparkles,
  Square,
  Telescope,
  Timer,
  TriangleAlert,
  X,
  Zap
} from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { formatNumber } from '@yachiyo/i18n/index'
import { theme } from '@renderer/theme/theme'
import { Tooltip } from '@renderer/components/Tooltip'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { formatTokenCount } from '@renderer/lib/formatTokenCount'
import { ModelSelectorPopup } from '../ModelSelectorPopup'
import { SlashCommandPopup } from '../SlashCommandPopup'
import { SkillsSelectorPopup } from '../SkillsSelectorPopup'
import { ToolSelectorPopup } from '../ToolSelectorPopup'
import { ReasoningSelectorPopup } from '../ReasoningSelectorPopup'
import { RunArrowIndicator } from '../RunArrowIndicator'
import { WorkspaceSelectorPopup } from '../WorkspaceSelectorPopup'
import { WorkspaceSuggestionPopup } from './WorkspaceSuggestionPopup'
import { SmoothCaretOverlay } from '../SmoothCaretOverlay'
import { BackgroundTasksChip } from '../BackgroundTasksChip'
import type { AcpAgentEntry } from '../../lib/composer/modelSelectorState'
import { clearGoalX } from '@renderer/features/chat/lib/composer/pretextSync'
import { selectComposerPlaceholder } from '@renderer/features/chat/lib/composer/composerPlaceholder'
import { formatReasoningSelection } from '../../lib/composer/reasoningSelectionLabel'
import { getRunModeCopy } from '../../lib/composer/runModeCopy'
import {
  ACCEPT_ATTRIBUTE,
  COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX,
  SELECTION_BG,
  SKILL_TAG_PATTERN,
  ComposerFilePreview,
  ComposerImagePreview,
  QueuedFollowUpBufferBubble,
  StagedInputBufferBubble,
  TodoProgressWidget,
  getWorkspaceLabel,
  renderComposerTextHighlights,
  renderPretextLine
} from './support.tsx'

const MODE_ICON_MAP: Record<string, React.ElementType> = {
  auto: Zap,
  explore: Telescope,
  plan: Map,
  chat: MessageSquare
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ComposerView(props: any): React.JSX.Element {
  const t = useT()
  const {
    presentation = 'normal',
    composerRootRef,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    isDragOver,
    editingMessage,
    cancelEditMessage,
    queuedFollowUpMessage,
    handleEditQueuedFollowUp,
    queuedFollowUpCanRemove,
    handleRemoveQueuedFollowUp,
    inputBuffer,
    todoList,
    mergeBufferedPayloadIntoDraft,
    draftImages,
    draftFiles,
    removeComposerImage,
    activeThreadId,
    placeholderRunId,
    placeholderRunIndex,
    removeComposerFile,
    popupContainerRef,
    showSlashCommandPopup,
    matchingSlashCommands,
    slashSelectedIndex,
    handleSlashCommandSelect,
    dismissSlashPopup,
    fileMentionQuery,
    fileMentionMatchesState,
    isFileMentionSearchPending,
    loadMoreFileMentionMatches,
    fileMentionAnchorRect,
    activeSkillTag,
    validatedFileTags,
    validThingSlugs,
    setComposerValue,
    composerValue,
    composerInputRef,
    overlayRef,
    overlayLineTexts,
    overlaySelRange,
    textareaRef,
    isTextareaFocused,
    setIsTextareaFocused,
    handleInput,
    setIsComposing,
    handleKeyDown,
    handlePaste,
    handleTextareaScroll,
    isConfigured,
    composerStatus,
    fileInputRef,
    queueImageFiles,
    queueDocumentFiles,
    canAddImages,
    canAddFiles,
    effectiveAcpBinding,
    toolSelectorRef,
    setModelSelectorOpen,
    setReasoningSelectorOpen,
    setSkillsSelectorOpen,
    setWorkspaceSelectorOpen,
    setToolSelectorOpen,
    toolSelectorOpen,
    runMode,
    hasActiveRun,
    setRunMode,
    skillsSelectorRef,
    skillsSelectorOpen,
    enabledSkillCount,
    availableSkills,
    effectiveEnabledSkillNames,
    hasCustomSkillOverride,
    setComposerEnabledSkillNames,
    defaultEnabledSkillNames,
    inputBufferDurable,
    inputBufferSession,
    toggleInputBufferSession,
    workspaceSelectorRef,
    setWorkspaceHintHovered,
    setWorkspaceHintPinned,
    workspaceSelectorOpen,
    workspaceSwitchLockReason,
    currentWorkspacePath,
    showWorkspaceHint,
    workspaceHint,
    savedWorkspacePaths,
    requestWorkspaceSelection,
    pendingWorkspaceChangeConfirmation,
    setPendingWorkspaceChangeConfirmation,
    commitWorkspaceSelection,
    workspaceSuggestionPath,
    dismissWorkspaceSuggestion,
    switchToWorkspaceSuggestion,
    modelSelectorRef,
    modelSelectorOpen,
    canOpenModelPicker,
    isModelSelectorLocked,
    activeAcpBinding,
    providerLabel,
    modelLabel,
    config,
    effectiveModel,
    runBackendSwitch,
    selectModel,
    setPendingAcpBinding,
    activeThreadMessageCount,
    notifyAcpRebindBlocked,
    reasoningSelectorRef,
    reasoningSelectorOpen,
    reasoningSelectorState,
    setComposerReasoningEffort,
    showRunStats,
    hasRunStatsText,
    displayPromptTokens,
    latestRun,
    estimatedDraftTokens,
    canHandoffActiveThread,
    stripCompactThresholdTokens,
    showStopButton,
    isCancelInFlight,
    setIsCancelInFlight,
    cancelActiveRun,
    canSend,
    dispatchSend,
    primarySendMode,
    isSendInFlight,
    handleComposerWheel,
    attachmentStripRef
  } = props

  const isCompact = presentation === 'compact'
  const inputMinHeight = isCompact ? '58px' : '92px'

  const placeholderText = selectComposerPlaceholder({
    threadId: activeThreadId,
    runId: placeholderRunId,
    runIndex: placeholderRunIndex,
    runMode
  })

  return (
    <div
      ref={composerRootRef}
      className={`composer-shell composer-shell--${presentation} flex flex-col`}
      style={{
        borderTop: isCompact ? undefined : `1px solid ${theme.border.panel}`,
        position: 'relative'
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onWheel={handleComposerWheel}
    >
      {isDragOver ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `color-mix(in srgb, ${theme.background.accentPanel} 85%, transparent)`,
            border: `2px dashed ${theme.text.accent}`,
            borderRadius: isCompact ? 22 : 8,
            pointerEvents: 'none'
          }}
        >
          <span
            style={{
              fontSize: '0.8125rem',
              fontWeight: 500,
              color: theme.text.accent
            }}
          >
            {t('chat.composer.dropFilesToAttach')}
          </span>
        </div>
      ) : null}
      {editingMessage !== null ? (
        <div
          className="flex items-center justify-between px-4 py-1.5"
          style={{
            background: theme.background.accentPanel,
            borderBottom: `1px solid ${theme.border.accent}`
          }}
        >
          <span className="text-xs font-medium" style={{ color: theme.text.accent }}>
            {t('chat.composer.editingMessage')}
          </span>
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded transition-opacity opacity-70 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={cancelEditMessage}
            aria-label={t('chat.composer.cancelEditing')}
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : null}
      {queuedFollowUpMessage ? (
        <QueuedFollowUpBufferBubble
          message={queuedFollowUpMessage}
          onEdit={handleEditQueuedFollowUp}
          onRemove={queuedFollowUpCanRemove ? handleRemoveQueuedFollowUp : undefined}
        />
      ) : null}
      {inputBuffer.staged ? (
        <StagedInputBufferBubble
          staged={inputBuffer.staged}
          progress={inputBuffer.progress}
          remainingMs={inputBuffer.remainingMs}
          onSendNow={inputBuffer.flushNow}
          onCancel={() => {
            const payload = inputBuffer.staged
            inputBuffer.cancel()
            if (payload) {
              mergeBufferedPayloadIntoDraft(payload, payload.sourceThreadId)
            }
          }}
        />
      ) : null}
      <div className="composer-widget-shelf no-drag">
        <div className="composer-widget-shelf__left">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              const images = files.filter((f) => f.type.startsWith('image/'))
              const docs = files.filter((f) => !f.type.startsWith('image/'))
              if (images.length > 0) void queueImageFiles(images)
              if (docs.length > 0) void queueDocumentFiles(docs)
              event.currentTarget.value = ''
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canAddImages && !canAddFiles}
            className="composer-shelf-icon-button"
            aria-label={t('chat.composer.attach')}
          >
            <Paperclip size={15} strokeWidth={1.5} color={theme.icon.muted} />
          </button>

          {!effectiveAcpBinding && (
            <div ref={toolSelectorRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => {
                  setModelSelectorOpen(false)
                  setReasoningSelectorOpen(false)
                  setSkillsSelectorOpen(false)
                  setWorkspaceSelectorOpen(false)
                  setToolSelectorOpen((open) => !open)
                }}
                className="composer-shelf-icon-button"
                style={{
                  color: theme.text.primary,
                  opacity: toolSelectorOpen ? 1 : undefined,
                  gap: 4
                }}
                aria-label={t('chat.composer.modeAria', {
                  mode: getRunModeCopy(runMode === 'custom' ? 'auto' : runMode).label
                })}
                aria-expanded={toolSelectorOpen}
                aria-haspopup="menu"
              >
                {(() => {
                  const ModeIcon = MODE_ICON_MAP[runMode === 'custom' ? 'auto' : runMode]
                  return (
                    <ModeIcon
                      size={14}
                      strokeWidth={1.5}
                      color={runMode !== 'chat' ? theme.icon.accent : theme.icon.muted}
                    />
                  )
                })()}
                <span style={{ fontSize: 11.5, fontWeight: 500 }}>
                  {getRunModeCopy(runMode === 'custom' ? 'auto' : runMode).shortLabel}
                </span>
                <ChevronDown
                  size={10}
                  strokeWidth={1.5}
                  color={theme.icon.muted}
                  style={{
                    transform: toolSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s ease'
                  }}
                />
              </button>

              {toolSelectorOpen ? (
                <ToolSelectorPopup
                  triggerRef={toolSelectorRef}
                  runMode={runMode}
                  hasActiveRun={hasActiveRun}
                  onSelectMode={(mode) => void setRunMode(mode)}
                  onClose={() => setToolSelectorOpen(false)}
                />
              ) : null}
            </div>
          )}

          <div
            ref={workspaceSelectorRef}
            style={{ position: 'relative' }}
            onMouseEnter={() => setWorkspaceHintHovered(true)}
            onMouseLeave={() => setWorkspaceHintHovered(false)}
          >
            <button
              type="button"
              onClick={() => {
                if (workspaceSwitchLockReason) {
                  setWorkspaceHintPinned(true)
                  return
                }

                setModelSelectorOpen(false)
                setReasoningSelectorOpen(false)
                setSkillsSelectorOpen(false)
                setToolSelectorOpen(false)
                setWorkspaceSelectorOpen((open) => !open)
              }}
              className="composer-shelf-icon-button composer-shelf-icon-button--workspace"
              style={{
                color: theme.text.primary,
                opacity: workspaceSelectorOpen ? 1 : undefined,
                gap: 4
              }}
              aria-label={t('chat.workspacePicker.ariaLabel')}
              aria-expanded={workspaceSelectorOpen}
              aria-haspopup="menu"
            >
              <Folder
                size={14}
                strokeWidth={1.5}
                color={currentWorkspacePath ? theme.icon.accent : theme.icon.muted}
              />
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 500,
                  maxWidth: 88,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {getWorkspaceLabel(currentWorkspacePath)}
              </span>
              <ChevronDown
                size={10}
                strokeWidth={1.5}
                color={theme.icon.muted}
                style={{
                  transform: workspaceSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease'
                }}
              />
            </button>

            {showWorkspaceHint && !workspaceSuggestionPath ? (
              <div
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 8px)',
                  left: 0,
                  width: 260,
                  padding: '10px 11px',
                  borderRadius: 12,
                  background: theme.background.surfaceFrosted,
                  backdropFilter: 'blur(18px)',
                  WebkitBackdropFilter: 'blur(18px)',
                  border: `1px solid ${theme.border.strong}`,
                  boxShadow: theme.shadow.overlay,
                  zIndex: 45
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: theme.text.primary,
                    lineHeight: 1.35
                  }}
                >
                  {workspaceHint.title}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 12,
                    color: theme.text.muted,
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {workspaceHint.detail}
                </div>
              </div>
            ) : null}

            {workspaceSuggestionPath ? (
              <WorkspaceSuggestionPopup
                workspacePath={workspaceSuggestionPath}
                onSwitch={switchToWorkspaceSuggestion}
                onDismiss={dismissWorkspaceSuggestion}
              />
            ) : null}

            {workspaceSelectorOpen ? (
              <WorkspaceSelectorPopup
                triggerRef={workspaceSelectorRef}
                currentWorkspacePath={currentWorkspacePath}
                savedPaths={savedWorkspacePaths}
                onSelectWorkspace={(workspacePath) => {
                  requestWorkspaceSelection({
                    threadId: activeThreadId,
                    currentWorkspacePath,
                    nextWorkspacePath: workspacePath
                  })
                }}
                onChooseDirectory={() => {
                  void (async () => {
                    const pickedPath = await window.api.yachiyo.pickWorkspaceDirectory()
                    if (!pickedPath) {
                      return
                    }

                    requestWorkspaceSelection({
                      threadId: activeThreadId,
                      currentWorkspacePath,
                      nextWorkspacePath: pickedPath,
                      saveWorkspacePath: pickedPath
                    })
                  })()
                }}
                onClose={() => setWorkspaceSelectorOpen(false)}
              />
            ) : null}
          </div>

          {todoList ? <TodoProgressWidget items={todoList.items} /> : null}
        </div>

        <div className="composer-widget-shelf__right">
          <BackgroundTasksChip threadId={activeThreadId} />
        </div>
      </div>

      {pendingWorkspaceChangeConfirmation ? (
        <ConfirmDialog
          title={
            pendingWorkspaceChangeConfirmation.title ?? t('chat.composer.switchWorkspaceTitle')
          }
          description={
            pendingWorkspaceChangeConfirmation.description ??
            t('chat.composer.switchWorkspaceDescription')
          }
          actions={[
            { key: 'keep', label: t('chat.composer.keepCurrentWorkspace') },
            { key: 'switch', label: t('chat.composer.switchWorkspace'), tone: 'accent' }
          ]}
          onClose={() => setPendingWorkspaceChangeConfirmation(null)}
          onSelect={(key) => {
            if (key !== 'switch') {
              setPendingWorkspaceChangeConfirmation(null)
              return
            }

            const selection = pendingWorkspaceChangeConfirmation
            setPendingWorkspaceChangeConfirmation(null)
            void commitWorkspaceSelection(selection)
          }}
        />
      ) : null}

      {draftImages.length > 0 || draftFiles.length > 0 ? (
        <div ref={attachmentStripRef} className="composer-image-strip">
          {draftImages.map((image) => (
            <ComposerImagePreview
              key={image.id}
              image={image}
              onRemove={() => removeComposerImage(image.id, activeThreadId)}
            />
          ))}
          {draftFiles.map((file) => (
            <ComposerFilePreview
              key={file.id}
              file={file}
              onRemove={() => removeComposerFile(file.id, activeThreadId)}
            />
          ))}
        </div>
      ) : null}

      <div ref={popupContainerRef} style={{ position: 'relative' }}>
        {showSlashCommandPopup ? (
          <SlashCommandPopup
            triggerRef={popupContainerRef}
            commands={matchingSlashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={handleSlashCommandSelect}
            onClose={dismissSlashPopup}
            onReachEnd={
              fileMentionQuery !== null &&
              fileMentionMatchesState.hasMore &&
              !isFileMentionSearchPending
                ? loadMoreFileMentionMatches
                : undefined
            }
            leftOffset={0}
            anchorRect={fileMentionQuery !== null ? fileMentionAnchorRect : null}
            portal={fileMentionQuery !== null}
            emptyState={
              fileMentionQuery !== null
                ? isFileMentionSearchPending
                  ? t('chat.composer.searchingWorkspace')
                  : t('chat.composer.noFilesFound')
                : undefined
            }
          />
        ) : null}
        {activeSkillTag || validatedFileTags.length > 0 ? (
          <div className="composer-tag-row px-4 pt-2 flex flex-wrap items-center gap-2">
            {activeSkillTag ? (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{
                  maxWidth: '100%',
                  background: theme.background.accentPanel,
                  border: `1px solid ${theme.border.accent}`,
                  color: theme.text.accent
                }}
              >
                <Sparkles size={11} strokeWidth={1.7} />
                <span
                  className="font-mono"
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {activeSkillTag}
                </span>
                <button
                  type="button"
                  aria-label={t('chat.composer.removeSkillTag', { name: activeSkillTag })}
                  onClick={() =>
                    setComposerValue(composerValue.replace(SKILL_TAG_PATTERN, '').trimStart())
                  }
                  className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            ) : null}
            {validatedFileTags.map((fileTag, index) => (
              <div
                key={`${fileTag}-${index}`}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{
                  maxWidth: '100%',
                  background: theme.background.accentPanel,
                  border: `1px solid ${theme.border.accent}`,
                  color: theme.text.accent
                }}
              >
                <Folder size={11} strokeWidth={1.7} />
                <span
                  className="font-mono"
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {fileTag}
                </span>
                <button
                  type="button"
                  aria-label={t('chat.composer.removeFileTag', { name: fileTag })}
                  onClick={() =>
                    setComposerValue(
                      composerValue
                        .replace(`@${fileTag}`, '')
                        .replace(/\s{2,}/g, ' ')
                        .trimStart()
                    )
                  }
                  className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div ref={composerInputRef} className="composer-input-zone px-4">
          {/*
            Input stack (same grid cell):
            - Highlight div: real text paint for @mentions etc. pointer-events:none; scrollTop synced
              from textarea in onScroll.
            - textarea: value controlled by composerValue; transparent text + hidden native caret;
              overflowY auto when content taller than COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX.
            - SmoothCaretOverlay: mirror+span measures caret in content Y; maps with textarea.scrollTop.
            resizeTextarea() preserves scroll when toggling height:auto→fixed. When already at
            max height and overflowing, it avoids height:auto so scrollHeight stays tied to the
            new value (trailing newline can scroll into view) without content padding tricks.
          */}
          <div
            style={{
              display: 'grid',
              position: 'relative',
              maxHeight: `${COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX}px`,
              minHeight: inputMinHeight,
              overflow: 'hidden'
            }}
          >
            <div
              aria-hidden
              ref={overlayRef}
              className="composer-text-overlay"
              style={{
                gridArea: '1 / 1',
                position: 'relative',
                fontSize: '0.875rem',
                lineHeight: '1.625',
                fontFamily: 'inherit',
                whiteSpace: 'pre',
                overflowY: 'auto',
                pointerEvents: 'none',
                minHeight: inputMinHeight,
                maxHeight: `${COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX}px`,
                letterSpacing: '0.04em'
              }}
            >
              {overlayLineTexts
                ? (() => {
                    const elements: React.ReactNode[] = []
                    let charOffset = 0
                    for (let i = 0; i < overlayLineTexts.length; i++) {
                      const lineText = overlayLineTexts[i]
                      elements.push(
                        <div key={i}>
                          {renderPretextLine(
                            lineText,
                            charOffset,
                            overlaySelRange,
                            theme.text.primary,
                            theme.text.accent,
                            validatedFileTags,
                            validThingSlugs
                          )}
                        </div>
                      )
                      charOffset += lineText.length
                      // Skip consumed hard-break chars (\r\n or \n) between lines
                      if (charOffset < composerValue.length && composerValue[charOffset] === '\r')
                        charOffset++
                      if (charOffset < composerValue.length && composerValue[charOffset] === '\n')
                        charOffset++
                    }
                    if (composerValue.endsWith('\n')) {
                      elements.push(
                        <div key="trailing-nl">
                          {overlaySelRange && overlaySelRange[1] > charOffset ? (
                            <span style={{ backgroundColor: SELECTION_BG }}>{'\u200b'}</span>
                          ) : (
                            '\u200b'
                          )}
                        </div>
                      )
                    }
                    return elements
                  })()
                : renderComposerTextHighlights(
                    composerValue,
                    theme.text.primary,
                    theme.text.accent,
                    validatedFileTags,
                    validThingSlugs
                  )}
            </div>
            <SmoothCaretOverlay
              textareaRef={textareaRef}
              hostRef={composerInputRef}
              highlightRef={overlayRef}
              enabled={true}
              trailStrength="high"
              isFocused={isTextareaFocused}
              color={theme.text.accent}
              trailColor="rgb(var(--yachiyo-rgb-accent) / 0.38)"
              text={composerValue}
            />
            <textarea
              ref={textareaRef}
              value={composerValue}
              onChange={handleInput}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={handleKeyDown}
              onPointerUp={clearGoalX}
              onPaste={handlePaste}
              onScroll={handleTextareaScroll}
              onFocus={() => setIsTextareaFocused(true)}
              onBlur={() => setIsTextareaFocused(false)}
              placeholder={
                isConfigured ? placeholderText : t('chat.composer.notConfiguredPlaceholder')
              }
              rows={1}
              className="w-full resize-none bg-transparent outline-none text-sm leading-relaxed message-selectable composer-textarea-pretext"
              style={{
                gridArea: '1 / 1',
                color: 'transparent',
                caretColor: 'transparent',
                padding: 0,
                minHeight: inputMinHeight,
                maxHeight: `${COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX}px`,
                letterSpacing: '0.04em',
                wordBreak: 'break-word',
                overflowWrap: 'break-word'
              }}
            />
          </div>
        </div>
      </div>

      {composerStatus ? (
        <div className="composer-status-row px-4 pb-2">
          <div className={`composer-status composer-status--${composerStatus.tone}`}>
            {composerStatus.tone === 'error' ? (
              <AlertCircle size={12} strokeWidth={1.8} />
            ) : (
              <span className="composer-status__dot" />
            )}
            <span>{composerStatus.text}</span>
          </div>
        </div>
      ) : null}

      <div className="composer-action-row flex items-center gap-2 px-3 pb-3 no-drag">
        {!effectiveAcpBinding && (
          <div ref={skillsSelectorRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => {
                setModelSelectorOpen(false)
                setReasoningSelectorOpen(false)
                setToolSelectorOpen(false)
                setWorkspaceSelectorOpen(false)
                setSkillsSelectorOpen((open) => !open)
              }}
              className="relative p-1.5 rounded-lg opacity-60 hover:opacity-85 transition-opacity"
              aria-label={t('chat.composer.skills')}
              aria-expanded={skillsSelectorOpen}
              aria-haspopup="menu"
            >
              <Sparkles
                size={16}
                strokeWidth={1.5}
                color={enabledSkillCount > 0 ? theme.icon.accent : theme.icon.muted}
              />
              {enabledSkillCount > 0 ? (
                <span
                  className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center"
                  style={{
                    fontSize: '8px',
                    background: theme.background.accentFill,
                    color: theme.text.onAccentFill
                  }}
                >
                  {enabledSkillCount}
                </span>
              ) : null}
            </button>

            {skillsSelectorOpen ? (
              <SkillsSelectorPopup
                triggerRef={skillsSelectorRef}
                availableSkills={availableSkills}
                effectiveEnabledSkillNames={effectiveEnabledSkillNames}
                hasCustomOverride={hasCustomSkillOverride}
                onReset={() => setComposerEnabledSkillNames(null)}
                onToggle={(skillName) => {
                  const current = hasCustomSkillOverride
                    ? effectiveEnabledSkillNames
                    : defaultEnabledSkillNames
                  const next = current.includes(skillName)
                    ? current.filter((name) => name !== skillName)
                    : [...current, skillName]
                  setComposerEnabledSkillNames(next)
                }}
                onClose={() => setSkillsSelectorOpen(false)}
              />
            ) : null}
          </div>
        )}

        {inputBufferDurable ? (
          <Tooltip
            content={
              inputBufferSession
                ? t('chat.composer.bufferingOnTooltip')
                : t('chat.composer.bufferingOffTooltip')
            }
            placement="top"
          >
            <button
              type="button"
              onClick={toggleInputBufferSession}
              className="relative p-1.5 rounded-lg opacity-60 hover:opacity-85 transition-opacity"
              aria-label={t('chat.composer.toggleBuffering')}
              aria-pressed={inputBufferSession}
            >
              <Timer
                size={16}
                strokeWidth={1.5}
                color={inputBufferSession ? theme.icon.accent : theme.icon.muted}
              />
            </button>
          </Tooltip>
        ) : null}

        <div ref={modelSelectorRef} style={{ position: 'relative' }}>
          <button
            onClick={() => {
              if (!canOpenModelPicker || isModelSelectorLocked) {
                return
              }

              setSkillsSelectorOpen(false)
              setToolSelectorOpen(false)
              setWorkspaceSelectorOpen(false)
              setReasoningSelectorOpen(false)
              setModelSelectorOpen((open) => !open)
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity ml-0.5"
            style={{
              color: theme.text.primary,
              opacity: modelSelectorOpen ? 1 : 0.6
            }}
            aria-label={t('chat.composer.modelSelection')}
            type="button"
          >
            {activeAcpBinding ? (
              <Cpu size={12} strokeWidth={1.5} color={theme.icon.accent} />
            ) : (
              <CircleCheck
                size={12}
                strokeWidth={1.5}
                color={isConfigured ? theme.icon.success : theme.icon.muted}
              />
            )}
            {effectiveAcpBinding
              ? (effectiveAcpBinding.profileName ??
                effectiveAcpBinding.profileId ??
                t('chat.composer.acpAgentFallback'))
              : `${providerLabel} - ${modelLabel}`}
            {canOpenModelPicker ? (
              <ChevronDown
                size={10}
                strokeWidth={1.5}
                color={theme.icon.muted}
                style={{
                  transform: modelSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease'
                }}
              />
            ) : null}
          </button>

          {modelSelectorOpen && config && !isModelSelectorLocked ? (
            <ModelSelectorPopup
              config={config}
              triggerRef={modelSelectorRef}
              currentProviderName={effectiveModel.providerName}
              currentModel={effectiveModel.model}
              currentAcpProfileId={effectiveAcpBinding?.profileId ?? null}
              onSelect={async (providerName, model) => {
                await runBackendSwitch(async () => {
                  await selectModel(providerName, model)
                  if (activeAcpBinding && activeThreadId) {
                    await window.api.yachiyo.setThreadRuntimeBinding({
                      threadId: activeThreadId,
                      runtimeBinding: null
                    })
                  }
                })
                setPendingAcpBinding(null)
              }}
              onSelectAcpAgent={async (agent: AcpAgentEntry) => {
                if (activeThreadId && activeThreadMessageCount > 0) {
                  if (activeAcpBinding?.profileId !== agent.id) {
                    notifyAcpRebindBlocked()
                  }
                  return
                }

                if (activeThreadId) {
                  await runBackendSwitch(async () => {
                    await window.api.yachiyo.setThreadRuntimeBinding({
                      threadId: activeThreadId,
                      runtimeBinding: {
                        kind: 'acp',
                        profileId: agent.id,
                        profileName: agent.name,
                        sessionStatus: 'new'
                      }
                    })
                  })
                } else {
                  setPendingAcpBinding({
                    kind: 'acp',
                    profileId: agent.id,
                    profileName: agent.name,
                    sessionStatus: 'new'
                  })
                }
              }}
              onClose={() => setModelSelectorOpen(false)}
            />
          ) : null}
        </div>

        {!effectiveAcpBinding ? (
          <div ref={reasoningSelectorRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => {
                setModelSelectorOpen(false)
                setSkillsSelectorOpen(false)
                setToolSelectorOpen(false)
                setWorkspaceSelectorOpen(false)
                setReasoningSelectorOpen((open) => !open)
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity"
              style={{
                color: theme.text.primary,
                opacity: reasoningSelectorOpen ? 1 : 0.6
              }}
              aria-label={t('chat.composer.reasoningEffort')}
              aria-expanded={reasoningSelectorOpen}
              aria-haspopup="menu"
            >
              <Brain
                size={12}
                strokeWidth={1.5}
                color={
                  reasoningSelectorState.selected === 'off' ? theme.icon.muted : theme.icon.accent
                }
              />
              {formatReasoningSelection(reasoningSelectorState.selected)}
              <ChevronDown
                size={10}
                strokeWidth={1.5}
                color={theme.icon.muted}
                style={{
                  transform: reasoningSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease'
                }}
              />
            </button>

            {reasoningSelectorOpen ? (
              <ReasoningSelectorPopup
                triggerRef={reasoningSelectorRef}
                options={reasoningSelectorState.options}
                selected={reasoningSelectorState.selected}
                onSelect={setComposerReasoningEffort}
                onClose={() => setReasoningSelectorOpen(false)}
              />
            ) : null}
          </div>
        ) : null}

        {showRunStats ? (
          hasRunStatsText ? (
            <Tooltip
              content={
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    width: 240,
                    whiteSpace: 'normal'
                  }}
                >
                  {displayPromptTokens != null ? (
                    <>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>
                        {t('chat.composer.lastRunTokenUsage')}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                        <span style={{ color: theme.text.secondary }}>
                          {t('chat.composer.promptTokens')}
                        </span>
                        <span>{formatNumber(displayPromptTokens)}</span>
                      </div>
                    </>
                  ) : null}
                  {latestRun?.completionTokens != null ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                      <span style={{ color: theme.text.secondary }}>
                        {t('chat.composer.completionTokens')}
                      </span>
                      <span>{formatNumber(latestRun.completionTokens)}</span>
                    </div>
                  ) : null}
                  {latestRun?.totalPromptTokens != null &&
                  latestRun.totalPromptTokens !== displayPromptTokens ? (
                    <>
                      <div
                        style={{
                          height: 1,
                          background: theme.border.default,
                          margin: '2px 0'
                        }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                        <span style={{ color: theme.text.secondary }}>
                          {t('chat.composer.totalPromptTokens')}
                        </span>
                        <span>{formatNumber(latestRun.totalPromptTokens)}</span>
                      </div>
                      {latestRun.totalCompletionTokens != null ? (
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                          <span style={{ color: theme.text.secondary }}>
                            {t('chat.composer.totalCompletionTokens')}
                          </span>
                          <span>{formatNumber(latestRun.totalCompletionTokens)}</span>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {estimatedDraftTokens > 0 ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                      <span style={{ color: theme.text.secondary }}>
                        {t('chat.composer.draftEstimate')}
                      </span>
                      <span>{formatNumber(estimatedDraftTokens)}</span>
                    </div>
                  ) : null}
                  {canHandoffActiveThread &&
                  (displayPromptTokens ?? 0) + estimatedDraftTokens >
                    stripCompactThresholdTokens ? (
                    <div
                      style={{
                        marginTop: 4,
                        paddingTop: 6,
                        borderTop: `1px solid ${theme.border.default}`,
                        color: theme.text.warning,
                        fontSize: 11,
                        lineHeight: 1.4
                      }}
                    >
                      {t('chat.composer.contextOverLimit', {
                        limit: formatTokenCount(stripCompactThresholdTokens),
                        command: '/handoff'
                      })}
                    </div>
                  ) : null}
                </div>
              }
            >
              <span
                className="text-xs px-1.5 flex items-center gap-1"
                style={{ color: theme.text.secondary, opacity: 0.7, userSelect: 'none' }}
              >
                {(displayPromptTokens ?? 0) + estimatedDraftTokens > stripCompactThresholdTokens ? (
                  <TriangleAlert
                    size={11}
                    style={{
                      color: theme.text.warning,
                      flexShrink: 0,
                      opacity: 1,
                      display: 'block'
                    }}
                  />
                ) : null}
                {displayPromptTokens != null ? formatTokenCount(displayPromptTokens) : null}
                {estimatedDraftTokens > 0 ? (
                  <span style={{ opacity: 0.6 }}>
                    {displayPromptTokens != null ? '+' : ''}
                    {formatTokenCount(estimatedDraftTokens)}
                  </span>
                ) : null}
                <RunArrowIndicator />
              </span>
            </Tooltip>
          ) : (
            <span
              className="text-xs flex items-center"
              style={{ color: theme.text.secondary, opacity: 0.7, userSelect: 'none' }}
            >
              <RunArrowIndicator />
            </span>
          )
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {showStopButton ? (
            <button
              type="button"
              disabled={isCancelInFlight}
              onClick={() => {
                if (isCancelInFlight) return
                setIsCancelInFlight(true)
                void cancelActiveRun()
              }}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
              style={{
                background: theme.background.accentPanel,
                border: `1px solid ${theme.border.accent}`,
                opacity: isCancelInFlight ? 0.6 : 1
              }}
              aria-label={t('chat.composer.stopGeneration')}
              title={t('chat.composer.stopGeneration')}
            >
              {isCancelInFlight ? (
                <LoaderCircle size={12} className="animate-spin" color={theme.text.accent} />
              ) : (
                <Square size={10} fill={theme.text.accent} strokeWidth={0} />
              )}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              if (!canSend) return
              setModelSelectorOpen(false)
              setSkillsSelectorOpen(false)
              setToolSelectorOpen(false)
              setWorkspaceSelectorOpen(false)
              dispatchSend(primarySendMode)
            }}
            disabled={!canSend}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
            style={{
              background: canSend ? theme.text.accent : theme.border.panel,
              opacity: isSendInFlight ? 0.6 : 1
            }}
            aria-label={
              primarySendMode === 'steer'
                ? t('chat.composer.steerReply')
                : primarySendMode === 'follow-up'
                  ? t('chat.composer.queueFollowUp')
                  : editingMessage !== null
                    ? t('chat.composer.updateMessage')
                    : t('chat.composer.send')
            }
            title={
              primarySendMode === 'steer'
                ? t('chat.composer.steerReply')
                : primarySendMode === 'follow-up'
                  ? t('chat.composer.queueFollowUp')
                  : editingMessage !== null
                    ? t('chat.composer.updateMessage')
                    : t('chat.composer.send')
            }
          >
            {isSendInFlight ? (
              <LoaderCircle size={14} className="animate-spin" color={theme.text.inverse} />
            ) : (
              <SendHorizonal
                size={14}
                strokeWidth={1.8}
                color={canSend ? theme.text.inverse : theme.icon.placeholder}
              />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
