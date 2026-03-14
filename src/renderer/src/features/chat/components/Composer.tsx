import { useRef, useCallback } from 'react'
import { Paperclip, Wrench, ChevronDown, SendHorizonal, Square, CircleCheck } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'

export function Composer() {
  const composerValue = useAppStore((s) => s.composerValue)
  const runStatus = useAppStore((s) => s.runStatus)
  const setComposerValue = useAppStore((s) => s.setComposerValue)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isRunning = runStatus === 'running'
  const canSend = composerValue.trim().length > 0 && !isRunning

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (canSend) sendMessage(composerValue)
      }
    },
    [canSend, composerValue, sendMessage],
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setComposerValue(e.target.value)
      // Auto-resize
      const el = e.target
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 160) + 'px'
    },
    [setComposerValue],
  )

  return (
    <div
      className="flex flex-col"
      style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}
    >
      {/* Textarea row */}
      <div className="px-4 pt-3 pb-1">
        <textarea
          ref={textareaRef}
          value={composerValue}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          className="w-full resize-none bg-transparent outline-none text-sm leading-relaxed placeholder:text-gray-400 message-selectable"
          style={{
            color: '#1c1c1e',
            minHeight: '22px',
            maxHeight: '160px',
            overflow: 'hidden',
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
            style={{ fontSize: '8px', background: '#4a7876' }}
          >
            2
          </span>
        </button>

        {/* Model selector */}
        <button
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium opacity-60 hover:opacity-90 transition-opacity ml-0.5"
          style={{ color: '#1c1c1e' }}
        >
          <CircleCheck size={12} strokeWidth={1.5} color="#8e8e93" />
          Anthropic – claude-opus-4-5
          <ChevronDown size={10} strokeWidth={1.5} color="#8e8e93" />
        </button>

        {/* Send / Stop */}
        <div className="ml-auto">
          {isRunning ? (
            <button
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
              style={{ background: '#4a7876' }}
              title="Stop"
            >
              <Square size={10} fill="white" strokeWidth={0} />
            </button>
          ) : (
            <button
              onClick={() => canSend && sendMessage(composerValue)}
              disabled={!canSend}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
              style={{
                background: canSend ? '#4a7876' : 'rgba(0,0,0,0.08)',
                cursor: canSend ? 'pointer' : 'default',
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
