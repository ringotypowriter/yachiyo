import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { predictionRemainder, resolvePredictionKey } from '../../lib/composer/composerPrediction.ts'

interface Prediction {
  draft: string
  continuation: string
  contextKey: string
}
interface PredictionInput {
  value: string
  enabled: boolean
  contextKey: string
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  setValue: (value: string) => void
}
interface PredictionResult {
  text: string
  refreshSelection: () => void
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useComposerPrediction({
  value,
  enabled,
  contextKey,
  textareaRef,
  setValue
}: PredictionInput): PredictionResult {
  const [sessionId] = useState(() => crypto.randomUUID())
  const [prediction, setPrediction] = useState<Prediction | null>(null)
  const [atEnd, setAtEnd] = useState(false)
  const dismissed = useRef<{ value: string; contextKey: string } | null>(null)
  const [dismissVersion, setDismissVersion] = useState(0)
  const text =
    enabled && atEnd && prediction?.contextKey === contextKey
      ? predictionRemainder(prediction.draft, prediction.continuation, value)
      : ''

  const refreshSelection = useCallback((): void => {
    const textarea = textareaRef.current
    setAtEnd(
      Boolean(
        textarea &&
        textarea.selectionStart === textarea.value.length &&
        textarea.selectionEnd === textarea.value.length
      )
    )
  }, [textareaRef])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) refreshSelection()
    })
    document.addEventListener('selectionchange', refreshSelection)
    return () => {
      cancelled = true
      document.removeEventListener('selectionchange', refreshSelection)
    }
  }, [refreshSelection, value, enabled])

  useEffect(() => {
    let cancelled = false
    if (
      prediction &&
      (!enabled ||
        !atEnd ||
        prediction.contextKey !== contextKey ||
        !predictionRemainder(prediction.draft, prediction.continuation, value))
    ) {
      queueMicrotask(() => {
        if (!cancelled) setPrediction(null)
      })
    }
    if (
      !enabled ||
      !atEnd ||
      value.trim().length < 3 ||
      value.length > 12000 ||
      text ||
      (dismissed.current?.value === value && dismissed.current.contextKey === contextKey)
    )
      return () => {
        cancelled = true
      }
    let requested = false
    const timer = setTimeout(() => {
      requested = true
      void window.api.yachiyo
        .predictComposer({ sessionId, text: value })
        .then((continuation) => {
          if (!cancelled && continuation) setPrediction({ draft: value, continuation, contextKey })
        })
        .catch(() => {
          // Prediction is optional; provider failures must not interrupt typing.
        })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (requested)
        void window.api.yachiyo.predictComposer({ sessionId, text: '' }).catch(() => {})
    }
  }, [atEnd, contextKey, dismissVersion, enabled, prediction, sessionId, text, value])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const textarea = event.currentTarget
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
        dismissed.current = { value, contextKey }
        setPrediction(null)
        setDismissVersion((version) => version + 1)
        if (!text) return false
      } else if (action === 'accept' && text) {
        // Native insertion keeps the completion in Chromium's normal undo stack.
        if (!document.execCommand?.('insertText', false, text)) setValue(value + text)
        setPrediction(null)
      } else {
        return false
      }
      event.preventDefault()
      return true
    },
    [contextKey, setValue, text, value]
  )

  return { text, refreshSelection, handleKeyDown }
}
