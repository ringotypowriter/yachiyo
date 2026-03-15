import type React from 'react'
import { useRef, useCallback, useState, useEffect } from 'react'
import { Paperclip, Wrench, ChevronDown, SendHorizonal, Square, CircleCheck } from 'lucide-react'
import { DEFAULT_SETTINGS, useAppStore } from '@renderer/app/store/useAppStore'
import { ModelSelectorPopup } from './ModelSelectorPopup'

export function Composer(): React.JSX.Element {
  const composerValue = useAppStore((s) => s.composerValue)
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const settings = useAppStore((s) => s.settings ?? DEFAULT_SETTINGS)
  const config = useAppStore((s) => s.config)
  const runStatus = useAppStore((s) => s.runStatus)
  const cancelActiveRun = useAppStore((s) => s.cancelActiveRun)
  const setComposerValue = useAppStore((s) => s.setComposerValue)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const selectModel = useAppStore((s) => s.selectModel)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectorRef = useRef<HTMLDivElement>(null)

  const [selectorOpen, setSelectorOpen] = useState(false)

  const isRunning = runStatus === 'running'
  const isConfigured = settings.apiKey.trim().length > 0 && settings.model.trim().length > 0
  const canSend =
    composerValue.trim().length > 0 &&
    !isRunning &&
    isConfigured &&
    connectionStatus === 'connected'

  // Close popup on outside click
  useEffect(() => {
    if (!selectorOpen) return
    const handler = (e: MouseEvent): void => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [selectorOpen])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (canSend) void sendMessage(composerValue)
      }
    },
    [canSend, composerValue, sendMessage]
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setComposerValue(e.target.value)
      // Auto-resize
      const el = e.target
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 160) + 'px'
    },
    [setComposerValue]
  )

  const providerLabel = settings.providerName || (settings.provider === 'openai' ? 'OpenAI' : 'Anthropic')
  const modelLabel = settings.model || 'Configure provider'
  const hasModels = config !== null && config.providers.some((p) => p.modelList.enabled.length > 0)

  return (
    <div className="flex flex-col" style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}>
      {/* Textarea row */}
      <div className="px-4 pt-3 pb-1">
        <textarea
          ref={textareaRef}
          value={composerValue}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={
            isConfigured
              ? 'Type a message...'
              : 'Open Settings and configure a provider before chatting.'
          }
          rows={1}
          className="w-full resize-none bg-transparent outline-none text-sm leading-relaxed placeholder:text-gray-400 message-selectable"
          style={{
            color: '#2D2D2B',
            minHeight: '22px',
            maxHeight: '160px',
            overflow: 'hidden'
          }}
        />
      </div>

      {/* Toolbar row */}
      <div className="flex items-center gap-2 px-3 pb-3 no-drag">
        {/* Attachment */}
        <button
          className="p-1.5 rounded-lg opacity-50 hover:opacity-80 transition-opacity"
          title="Attach file"
        >
          <Paperclip size={16} strokeWidth={1.5} color="#8e8e93" />
        </button>

        {/* Tools */}
        <button
          className="relative p-1.5 rounded-lg opacity-50 hover:opacity-80 transition-opacity"
          title="Tools"
        >
          <Wrench size={16} strokeWidth={1.5} color="#8e8e93" />
          {/* Badge */}
          <span
            className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full text-white flex items-center justify-center"
            style={{ fontSize: '8px', background: '#CC7D5E' }}
          >
            2
          </span>
        </button>

        {/* Model selector */}
        <div ref={selectorRef} style={{ position: 'relative' }}>
          <button
            onClick={() => hasModels && setSelectorOpen((o) => !o)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity ml-0.5"
            style={{
              color: '#2D2D2B',
              opacity: selectorOpen ? 1 : 0.6,
              cursor: hasModels ? 'pointer' : 'default'
            }}
            title={hasModels ? 'Switch model' : 'Add models in Settings → Providers'}
          >
            <CircleCheck size={12} strokeWidth={1.5} color={isConfigured ? '#5CAD8A' : '#8e8e93'} />
            {providerLabel} – {modelLabel}
            {hasModels && (
              <ChevronDown
                size={10}
                strokeWidth={1.5}
                color="#8e8e93"
                style={{
                  transform: selectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease'
                }}
              />
            )}
          </button>

          {selectorOpen && config && (
            <ModelSelectorPopup
              config={config}
              currentProviderName={settings.providerName}
              currentModel={settings.model}
              onSelect={(providerName, model) => void selectModel(providerName, model)}
              onClose={() => setSelectorOpen(false)}
            />
          )}
        </div>

        {/* Send / Stop */}
        <div className="ml-auto">
          {isRunning ? (
            <button
              onClick={() => void cancelActiveRun()}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
              style={{ background: '#CC7D5E' }}
              title="Stop"
            >
              <Square size={10} fill="white" strokeWidth={0} />
            </button>
          ) : (
            <button
              onClick={() => canSend && void sendMessage(composerValue)}
              disabled={!canSend}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
              style={{
                background: canSend ? '#CC7D5E' : 'rgba(0,0,0,0.08)',
                cursor: canSend ? 'pointer' : 'default'
              }}
              title="Send"
            >
              <SendHorizonal size={14} strokeWidth={1.8} color={canSend ? 'white' : '#aaa'} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
