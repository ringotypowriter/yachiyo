import type React from 'react'
import { useRef, useState } from 'react'
import { MessageCircleQuestion, ArrowUp } from 'lucide-react'
import type { ToolCall, AskUserToolCallDetails } from '@renderer/app/types'
import { shouldSubmitAskUserAnswer } from '@renderer/features/chat/lib/ask-user/askUserEnterBehavior'
import { theme } from '@renderer/theme/theme'

interface AskUserInlineWidgetProps {
  toolCall: ToolCall
}

export function AskUserInlineWidget({ toolCall }: AskUserInlineWidgetProps): React.JSX.Element {
  const details = toolCall.details as AskUserToolCallDetails | undefined
  const isWaiting = toolCall.status === 'waiting-for-user'
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const question = details?.question ?? toolCall.inputSummary
  const choices = details?.choices
  const answer = details?.answer

  const submitAnswer = async (value: string): Promise<void> => {
    const trimmed = value.trim()
    if (!trimmed || isSending || !toolCall.runId) return
    setIsSending(true)
    try {
      await window.api.yachiyo.answerToolQuestion({
        threadId: toolCall.threadId,
        runId: toolCall.runId,
        toolCallId: toolCall.id,
        answer: trimmed
      })
    } finally {
      setIsSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (
      !shouldSubmitAskUserAnswer({
        key: e.key,
        shiftKey: e.shiftKey,
        isComposing: e.nativeEvent.isComposing,
        keyCode: e.nativeEvent.keyCode
      })
    ) {
      return
    }

    e.preventDefault()
    submitAnswer(input)
  }

  // Completed state: flat Q→A row, matching finished tool rows
  if (!isWaiting) {
    return (
      <div
        className="flex flex-wrap items-center gap-1.5 px-6 py-0.5"
        style={{ fontSize: '11px', color: theme.text.muted }}
      >
        <MessageCircleQuestion
          size={12}
          strokeWidth={1.8}
          className="shrink-0"
          style={{ color: theme.text.accent }}
        />
        <span style={{ color: theme.text.secondary }}>{question}</span>
        {answer && <span style={{ color: theme.text.primary, fontWeight: 500 }}>· {answer}</span>}
      </div>
    )
  }

  // Waiting state: accent card with question + input
  const hasInput = input.trim().length > 0
  return (
    <div className="px-6 py-1.5">
      <div
        className="flex flex-col gap-3 rounded-lg px-4 py-3.5"
        style={{
          background: theme.background.surface,
          border: `1px solid ${theme.border.default}`
        }}
      >
        {/* Question */}
        <div className="flex items-start gap-2.5">
          <MessageCircleQuestion
            size={15}
            strokeWidth={1.6}
            className="mt-px shrink-0"
            style={{
              color: theme.text.accent,
              animation: 'yachiyo-preparing-pulse 1.2s ease-in-out infinite'
            }}
          />
          <span
            style={{
              color: theme.text.primary,
              fontSize: '12.5px',
              fontWeight: 500,
              lineHeight: 1.4
            }}
          >
            {question}
          </span>
        </div>

        {/* Choices + Input stacked at same width */}
        <div className="flex flex-col gap-1.5 pl-6" style={{ maxWidth: 360 }}>
          {choices &&
            choices.length > 0 &&
            choices.map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={isSending}
                onClick={() => submitAnswer(choice)}
                className="w-full rounded-md px-3 py-2 text-left"
                style={{
                  background: theme.background.surface,
                  border: `1px solid ${theme.border.panel}`,
                  boxShadow: theme.shadow.button,
                  color: theme.text.secondary,
                  fontSize: '11.5px',
                  fontWeight: 450,
                  transition: 'all 0.12s ease'
                }}
                onMouseEnter={(e) => {
                  if (isSending) return
                  e.currentTarget.style.background = theme.background.accentMuted
                  e.currentTarget.style.borderColor = theme.border.accent
                  e.currentTarget.style.color = theme.text.accentStrong
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = theme.background.surface
                  e.currentTarget.style.borderColor = theme.border.panel
                  e.currentTarget.style.color = theme.text.secondary
                }}
              >
                {choice}
              </button>
            ))}

          {/* Input */}
          <div
            className="flex min-w-0 flex-1 items-center rounded-md"
            style={{
              background: theme.background.surface,
              border: `1px solid ${theme.border.panel}`,
              transition: 'border-color 0.12s ease'
            }}
            onFocus={() => {
              const el = inputRef.current?.parentElement
              if (el) el.style.borderColor = theme.border.accent
            }}
            onBlur={() => {
              const el = inputRef.current?.parentElement
              if (el) el.style.borderColor = theme.border.panel
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSending}
              placeholder={choices?.length ? 'Or type your answer...' : 'Type your answer...'}
              className="min-w-0 flex-1 bg-transparent px-3 py-1.5 outline-none"
              style={{
                color: theme.text.primary,
                fontSize: '12px',
                border: 'none'
              }}
            />
            <button
              type="button"
              disabled={isSending || !hasInput}
              onClick={() => submitAnswer(input)}
              className="mr-1 flex shrink-0 items-center justify-center rounded-md p-1"
              style={{
                background: hasInput ? theme.background.accentFill : 'transparent',
                color: hasInput ? theme.text.onAccentFill : theme.text.placeholder,
                border: 'none',
                opacity: hasInput ? 1 : 0.4,
                transition: 'all 0.12s ease'
              }}
            >
              <ArrowUp size={13} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
