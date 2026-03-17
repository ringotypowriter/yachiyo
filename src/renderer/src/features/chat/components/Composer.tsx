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
import { shouldSendOnComposerEnter } from '@renderer/features/chat/lib/composerEnterBehavior'
import { ModelSelectorPopup } from './ModelSelectorPopup'

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
  const removeComposerImage = useAppStore((s) => s.removeComposerImage)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const selectModel = useAppStore((s) => s.selectModel)
  const setComposerValue = useAppStore((s) => s.setComposerValue)
  const upsertComposerImage = useAppStore((s) => s.upsertComposerImage)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [selectorOpen, setSelectorOpen] = useState(false)
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
  const { canSend, showStopButton } = getComposerActionState({
    connectionStatus,
    hasActiveRun,
    hasFailedImages,
    hasLoadingImages,
    hasPayload,
    isConfigured
  })

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

    if (hasActiveRun) {
      return {
        tone: 'muted' as const,
        text: 'A reply is still running. Stop it or wait for it to finish.'
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
    if (!selectorOpen) return
    const handler = (event: MouseEvent): void => {
      if (selectorRef.current && !selectorRef.current.contains(event.target as Node)) {
        setSelectorOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [selectorOpen])

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
      if (
        shouldSendOnComposerEnter({
          key: event.key,
          shiftKey: event.shiftKey,
          isComposing: isComposing || event.nativeEvent.isComposing,
          keyCode: event.nativeEvent.keyCode
        })
      ) {
        event.preventDefault()
        if (canSend) {
          setSelectorOpen(false)
          void sendMessage()
        }
      }
    },
    [canSend, isComposing, sendMessage]
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

        <button
          type="button"
          className="relative p-1.5 rounded-lg opacity-50 hover:opacity-80 transition-opacity"
          aria-label="Tools"
        >
          <Wrench size={16} strokeWidth={1.5} color="#8e8e93" />
          <span
            className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full text-white flex items-center justify-center"
            style={{ fontSize: '8px', background: '#CC7D5E' }}
          >
            2
          </span>
        </button>

        <div ref={selectorRef} style={{ position: 'relative' }}>
          <button
            onClick={() => hasModels && !isModelSelectorLocked && setSelectorOpen((open) => !open)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity ml-0.5"
            style={{
              color: '#2D2D2B',
              opacity: selectorOpen ? 1 : 0.6,
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
                  transform: selectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease'
                }}
              />
            ) : null}
          </button>

          {selectorOpen && config && !isModelSelectorLocked ? (
            <ModelSelectorPopup
              config={config}
              currentProviderName={settings.providerName}
              currentModel={settings.model}
              onSelect={(providerName, model) => void selectModel(providerName, model)}
              onClose={() => setSelectorOpen(false)}
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
              setSelectorOpen(false)
              void sendMessage()
            }}
            disabled={!canSend}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
            style={{
              background: canSend ? '#CC7D5E' : 'rgba(0,0,0,0.08)',
              cursor: canSend ? 'pointer' : 'default'
            }}
            aria-label="Send"
            title="Send"
          >
            <SendHorizonal size={14} strokeWidth={1.8} color={canSend ? 'white' : '#aaa'} />
          </button>
        </div>
      </div>
    </div>
  )
}
