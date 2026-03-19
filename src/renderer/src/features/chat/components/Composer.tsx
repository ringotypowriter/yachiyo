import type React from 'react'
import { useRef, useCallback, useState, useEffect } from 'react'
import {
  AlertCircle,
  ChevronDown,
  CircleCheck,
  Paperclip,
  LoaderCircle,
  SendHorizonal,
  Square,
  Wrench,
  X
} from 'lucide-react'
import {
  DEFAULT_SETTINGS,
  EMPTY_COMPOSER_DRAFT,
  useAppStore,
  type ComposerImageDraft
} from '@renderer/app/store/useAppStore'
import { getComposerActionState } from '@renderer/features/chat/lib/composerActionState'
import { resolveComposerEnterAction } from '@renderer/features/chat/lib/composerEnterBehavior'
import {
  CORE_TOOL_NAMES,
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
} from '../../../../../shared/yachiyo/protocol.ts'
import { ModelSelectorPopup } from './ModelSelectorPopup'
import { ToolSelectorPopup } from './ToolSelectorPopup'

const NEW_THREAD_DRAFT_KEY = '__new__'
const MAX_COMPOSER_IMAGES = 4

function createDraftImageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `image-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image file.'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Image could not be converted into a preview.'))
        return
      }

      resolve(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

function getImageStatusLabel(image: ComposerImageDraft): string {
  if (image.status === 'loading') {
    return 'Loading'
  }

  if (image.status === 'failed') {
    return 'Needs attention'
  }

  return 'Ready'
}

function ComposerImagePreview({
  image,
  onRemove
}: {
  image: ComposerImageDraft
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="composer-image-card">
      <button
        type="button"
        className="composer-image-card__remove"
        aria-label={`Remove ${image.filename ?? 'image'}`}
        onClick={onRemove}
      >
        <X size={12} strokeWidth={1.8} />
      </button>

      <div className="composer-image-card__frame">
        {image.status === 'ready' && image.dataUrl ? (
          <img
            className="composer-image-card__media"
            src={image.dataUrl}
            alt={image.filename ?? 'Selected image'}
          />
        ) : (
          <div className="composer-image-card__placeholder">
            {image.status === 'loading' ? (
              <LoaderCircle size={16} strokeWidth={1.7} className="composer-image-card__spinner" />
            ) : (
              <AlertCircle size={16} strokeWidth={1.7} />
            )}
          </div>
        )}
      </div>

      <div className="composer-image-card__meta">
        <span className="composer-image-card__name">{image.filename ?? 'Image'}</span>
        <span className="composer-image-card__status">{getImageStatusLabel(image)}</span>
      </div>
    </div>
  )
}

export function Composer(): React.JSX.Element {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const composerDraft = useAppStore(
    (s) => s.composerDrafts[s.activeThreadId ?? NEW_THREAD_DRAFT_KEY] ?? EMPTY_COMPOSER_DRAFT
  )
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const settings = useAppStore((s) => s.settings ?? DEFAULT_SETTINGS)
  const activeRunId = useAppStore((s) => s.activeRunId)
  const config = useAppStore((s) => s.config)
  const runPhase = useAppStore((s) => s.runPhase)
  const cancelActiveRun = useAppStore((s) => s.cancelActiveRun)
  const enabledTools = useAppStore((s) => s.enabledTools)
  const removeComposerImage = useAppStore((s) => s.removeComposerImage)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const selectModel = useAppStore((s) => s.selectModel)
  const setComposerValue = useAppStore((s) => s.setComposerValue)
  const toggleEnabledTool = useAppStore((s) => s.toggleEnabledTool)
  const upsertComposerImage = useAppStore((s) => s.upsertComposerImage)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modelSelectorRef = useRef<HTMLDivElement>(null)
  const toolSelectorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [toolSelectorOpen, setToolSelectorOpen] = useState(false)
  const [isComposing, setIsComposing] = useState(false)

  const composerValue = composerDraft.text
  const draftImages = composerDraft.images
  const readyImageCount = draftImages.filter((image) => image.status === 'ready').length
  const hasLoadingImages = draftImages.some((image) => image.status === 'loading')
  const hasFailedImages = draftImages.some((image) => image.status === 'failed')
  const hasPayload = composerValue.trim().length > 0 || readyImageCount > 0
  const canAddImages = draftImages.length < MAX_COMPOSER_IMAGES
  const hasActiveRun = activeRunId !== null
  const isModelSelectorLocked = runPhase === 'preparing' || runPhase === 'streaming'
  const isConfigured = settings.apiKey.trim().length > 0 && settings.model.trim().length > 0
  const disabledToolCount = CORE_TOOL_NAMES.length - enabledTools.length
  const { canSend, showStopButton } = getComposerActionState({
    connectionStatus,
    hasActiveRun,
    hasFailedImages,
    hasLoadingImages,
    hasPayload,
    isConfigured
  })
  const activeRunEnterBehavior =
    config?.chat?.activeRunEnterBehavior ?? DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
  const primarySendMode = hasActiveRun
    ? activeRunEnterBehavior === 'enter-steers'
      ? 'steer'
      : 'follow-up'
    : 'normal'
  const activeRunHint =
    activeRunEnterBehavior === 'enter-steers'
      ? 'Enter to steer, Option+Enter to queue follow-up.'
      : 'Option+Enter to steer, Enter to queue follow-up.'

  const composerStatus = (() => {
    if (connectionStatus !== 'connected') {
      return {
        tone: 'error' as const,
        text: 'Local server is unavailable. Reconnect before sending.'
      }
    }

    if (!isConfigured) {
      return {
        tone: 'muted' as const,
        text: 'Choose a provider and model in Settings before sending.'
      }
    }

    if (hasLoadingImages) {
      return {
        tone: 'muted' as const,
        text: 'Preparing image...'
      }
    }

    if (hasFailedImages) {
      return {
        tone: 'error' as const,
        text: 'This image could not be prepared.'
      }
    }

    if (hasActiveRun) {
      return {
        tone: 'muted' as const,
        text: activeRunHint
      }
    }

    return null
  })()

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current
    if (!element) {
      return
    }

    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
    element.style.overflowY = element.scrollHeight > 160 ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    resizeTextarea()
  }, [composerValue, resizeTextarea])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [activeThreadId])

  useEffect(() => {
    if (!modelSelectorOpen && !toolSelectorOpen) return
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node
      const clickedInsideModelSelector =
        modelSelectorRef.current && modelSelectorRef.current.contains(target)
      const clickedInsideToolSelector =
        toolSelectorRef.current && toolSelectorRef.current.contains(target)

      if (!clickedInsideModelSelector) {
        setModelSelectorOpen(false)
      }

      if (!clickedInsideToolSelector) {
        setToolSelectorOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [modelSelectorOpen, toolSelectorOpen])

  const queueImageFiles = useCallback(
    async (files: File[]) => {
      const remainingSlots = Math.max(
        0,
        MAX_COMPOSER_IMAGES -
          (useAppStore.getState().composerDrafts[activeThreadId ?? NEW_THREAD_DRAFT_KEY]?.images
            .length ?? 0)
      )
      const imageFiles = files
        .filter((file) => file.type.startsWith('image/'))
        .slice(0, remainingSlots)

      for (const file of imageFiles) {
        const imageId = createDraftImageId()
        upsertComposerImage(
          {
            id: imageId,
            status: 'loading',
            dataUrl: '',
            mediaType: file.type || 'image/*',
            filename: file.name
          },
          activeThreadId
        )

        try {
          const dataUrl = await readFileAsDataUrl(file)
          upsertComposerImage(
            {
              id: imageId,
              status: 'ready',
              dataUrl,
              mediaType: file.type || 'image/*',
              filename: file.name
            },
            activeThreadId
          )
        } catch (error) {
          upsertComposerImage(
            {
              id: imageId,
              status: 'failed',
              dataUrl: '',
              mediaType: file.type || 'image/*',
              filename: file.name,
              error: error instanceof Error ? error.message : 'Unable to prepare this image.'
            },
            activeThreadId
          )
        }
      }
    },
    [activeThreadId, upsertComposerImage]
  )

  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setComposerValue(event.target.value)
    },
    [setComposerValue]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const action = resolveComposerEnterAction({
        activeRunEnterBehavior,
        event: {
          key: event.key,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: isComposing || event.nativeEvent.isComposing,
          keyCode: event.nativeEvent.keyCode
        },
        hasActiveRun
      })

      if (!action) {
        return
      }

      event.preventDefault()
      if (canSend) {
        setModelSelectorOpen(false)
        setToolSelectorOpen(false)
        void sendMessage(action === 'send' ? 'normal' : action)
      }
    },
    [activeRunEnterBehavior, canSend, hasActiveRun, isComposing, sendMessage]
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.items)
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null && file.type.startsWith('image/'))

      if (files.length === 0) {
        return
      }

      event.preventDefault()
      void queueImageFiles(files)
    },
    [queueImageFiles]
  )

  const providerLabel =
    settings.providerName || (settings.provider === 'openai' ? 'OpenAI' : 'Anthropic')
  const modelLabel = settings.model || 'Configure provider'
  const hasModels =
    config !== null && config.providers.some((provider) => provider.modelList.enabled.length > 0)

  return (
    <div className="flex flex-col" style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}>
      {draftImages.length > 0 ? (
        <div className="composer-image-strip">
          {draftImages.map((image) => (
            <ComposerImagePreview
              key={image.id}
              image={image}
              onRemove={() => removeComposerImage(image.id, activeThreadId)}
            />
          ))}
        </div>
      ) : null}

      <div className="px-4 pt-3 pb-1">
        <textarea
          ref={textareaRef}
          value={composerValue}
          onChange={handleInput}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            isConfigured
              ? 'Message Yachiyo...'
              : 'Open Settings and configure a provider before chatting.'
          }
          rows={1}
          className="w-full resize-none bg-transparent outline-none text-sm leading-relaxed placeholder:text-gray-400 message-selectable"
          style={{
            color: '#2D2D2B',
            minHeight: '22px',
            maxHeight: '160px'
          }}
        />
      </div>

      {composerStatus ? (
        <div className="px-4 pb-2">
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

      <div className="flex items-center gap-2 px-3 pb-3 no-drag">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            if (files.length > 0) {
              void queueImageFiles(files)
            }
            event.currentTarget.value = ''
          }}
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canAddImages}
          className="p-1.5 rounded-lg opacity-60 hover:opacity-85 transition-opacity disabled:opacity-30"
          aria-label="Attach"
        >
          <Paperclip size={16} strokeWidth={1.5} color="#8e8e93" />
        </button>

        <div ref={toolSelectorRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => {
              setModelSelectorOpen(false)
              setToolSelectorOpen((open) => !open)
            }}
            className="relative p-1.5 rounded-lg opacity-60 hover:opacity-85 transition-opacity"
            aria-label="Tools"
            aria-expanded={toolSelectorOpen}
            aria-haspopup="menu"
          >
            <Wrench
              size={16}
              strokeWidth={1.5}
              color={disabledToolCount > 0 ? '#CC7D5E' : '#8e8e93'}
            />
            {disabledToolCount > 0 ? (
              <span
                className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full text-white flex items-center justify-center"
                style={{ fontSize: '8px', background: '#CC7D5E' }}
              >
                {disabledToolCount}
              </span>
            ) : null}
          </button>

          {toolSelectorOpen ? (
            <ToolSelectorPopup
              enabledTools={enabledTools}
              hasActiveRun={hasActiveRun}
              onToggle={(toolName) => void toggleEnabledTool(toolName)}
              onClose={() => setToolSelectorOpen(false)}
            />
          ) : null}
        </div>

        <div ref={modelSelectorRef} style={{ position: 'relative' }}>
          <button
            onClick={() => {
              if (!hasModels || isModelSelectorLocked) {
                return
              }

              setToolSelectorOpen(false)
              setModelSelectorOpen((open) => !open)
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity ml-0.5"
            style={{
              color: '#2D2D2B',
              opacity: modelSelectorOpen ? 1 : 0.6,
              cursor: hasModels && !isModelSelectorLocked ? 'pointer' : 'default'
            }}
            aria-label="Model selection"
            type="button"
          >
            <CircleCheck size={12} strokeWidth={1.5} color={isConfigured ? '#5CAD8A' : '#8e8e93'} />
            {providerLabel} - {modelLabel}
            {hasModels ? (
              <ChevronDown
                size={10}
                strokeWidth={1.5}
                color="#8e8e93"
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
              currentProviderName={settings.providerName}
              currentModel={settings.model}
              onSelect={(providerName, model) => void selectModel(providerName, model)}
              onClose={() => setModelSelectorOpen(false)}
            />
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {showStopButton ? (
            <button
              type="button"
              onClick={() => void cancelActiveRun()}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
              style={{
                background: 'rgba(204,125,94,0.14)',
                border: '1px solid rgba(204,125,94,0.28)'
              }}
              aria-label="Stop generation"
              title="Stop generation"
            >
              <Square size={10} fill="#CC7D5E" strokeWidth={0} />
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              if (!canSend) return
              setModelSelectorOpen(false)
              setToolSelectorOpen(false)
              void sendMessage(primarySendMode)
            }}
            disabled={!canSend}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
            style={{
              background: canSend ? '#CC7D5E' : 'rgba(0,0,0,0.08)',
              cursor: canSend ? 'pointer' : 'default'
            }}
            aria-label={
              primarySendMode === 'steer'
                ? 'Steer reply'
                : primarySendMode === 'follow-up'
                  ? 'Queue follow-up'
                  : 'Send'
            }
            title={
              primarySendMode === 'steer'
                ? 'Steer reply'
                : primarySendMode === 'follow-up'
                  ? 'Queue follow-up'
                  : 'Send'
            }
          >
            <SendHorizonal size={14} strokeWidth={1.8} color={canSend ? 'white' : '#aaa'} />
          </button>
        </div>
      </div>
    </div>
  )
}
