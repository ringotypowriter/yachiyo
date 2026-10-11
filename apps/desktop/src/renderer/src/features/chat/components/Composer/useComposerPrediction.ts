import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { resolvePredictionKey } from '../../lib/composer/composerPrediction.ts'

interface PredictionInput {
  value: string
  enabled: boolean
  threadId: string | null
  contextKey: string
  setValue: (value: string) => void
}
interface PredictionResult {
  text: string
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useComposerPrediction({
  value,
  enabled,
  threadId,
  contextKey,
  setValue
}: PredictionInput): PredictionResult {
  const [sessionId] = useState(() => crypto.randomUUID())
  const [prediction, setPrediction] = useState<{ text: string; contextKey: string } | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const text =
    enabled && value === '' && dismissed !== contextKey && prediction?.contextKey === contextKey
      ? prediction.text
      : ''

  useEffect(() => {
    if (
      !enabled ||
      value !== '' ||
      !threadId ||
      dismissed === contextKey ||
      prediction?.contextKey === contextKey
    )
      return
    let cancelled = false
    let requested = false
    const timer = setTimeout(() => {
      requested = true
      void window.api.yachiyo
        .predictComposer({ sessionId, threadId })
        .then((text) => {
          if (!cancelled) setPrediction({ text, contextKey })
        })
        .catch(() => {
          // Prediction is optional; provider failures must not interrupt typing.
          if (!cancelled) setPrediction({ text: '', contextKey })
        })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (requested) void window.api.yachiyo.predictComposer({ sessionId }).catch(() => {})
    }
  }, [contextKey, dismissed, enabled, prediction, sessionId, threadId, value])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const textarea = event.currentTarget
      if (textarea.value !== '' || !enabled || !threadId) return false
      const action = resolvePredictionKey(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          isComposing: event.nativeEvent.isComposing,
          keyCode: event.nativeEvent.keyCode
        },
        textarea.selectionStart,
        textarea.selectionEnd,
        textarea.value.length
      )
      if (action === 'dismiss') {
        setDismissed(contextKey)
        if (!text) return false
      } else if (action === 'accept' && text) {
        // Native insertion keeps the whole instruction in Chromium's normal undo stack.
        if (!document.execCommand?.('insertText', false, text)) setValue(text)
        setDismissed(contextKey)
      } else {
        return false
      }
      event.preventDefault()
      return true
    },
    [contextKey, enabled, setValue, text, threadId]
  )

  return { text, handleKeyDown }
}
