import { useEffect, useRef, useState } from 'react'
import { Keyboard, X } from 'lucide-react'
import { theme } from '@renderer/theme/theme'

interface ShortcutRecorderProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

const IS_MAC = navigator.platform.toLowerCase().includes('mac')

function formatAccelerator(raw: string): string {
  return raw
    .replace(/CommandOrControl/g, IS_MAC ? 'Command' : 'Ctrl')
    .replace(/Control/g, 'Ctrl')
    .replace(/Meta/g, IS_MAC ? 'Command' : 'Win')
}

function eventToAccelerator(e: KeyboardEvent): string | null {
  if (!e.key) return null
  // Ignore lone modifier releases
  if (
    e.key === 'Control' ||
    e.key === 'Alt' ||
    e.key === 'Shift' ||
    e.key === 'Meta' ||
    e.key === 'Tab' ||
    e.key === 'Escape' ||
    e.key === 'CapsLock' ||
    e.key.startsWith('Arrow')
  ) {
    return null
  }

  const parts: string[] = []
  if (e.metaKey) parts.push('Command')
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  const key = e.code.startsWith('Digit')
    ? e.code.replace('Digit', '')
    : e.code.startsWith('Key')
      ? e.code.replace('Key', '')
      : e.code.startsWith('Numpad')
        ? `num${e.code.replace('Numpad', '')}`
        : e.key.length === 1
          ? e.key.toUpperCase()
          : e.key

  parts.push(key)
  return parts.join('+')
}

export function ShortcutRecorder({
  value,
  onChange,
  placeholder = 'Click to record'
}: ShortcutRecorderProps): React.JSX.Element {
  const [isRecording, setIsRecording] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isRecording) {
      window.api.pauseGlobalShortcuts()
    } else {
      window.api.resumeGlobalShortcuts()
    }

    return () => {
      if (isRecording) {
        window.api.resumeGlobalShortcuts()
      }
    }
  }, [isRecording])

  useEffect(() => {
    if (!isRecording) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const accelerator = eventToAccelerator(e)
      if (accelerator) {
        onChange(accelerator)
        setIsRecording(false)
      }
    }

    const handleMouseDown = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsRecording(false)
      }
    }

    const handleBlur = (): void => {
      setIsRecording(false)
    }

    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('blur', handleBlur)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('blur', handleBlur)
    }
  }, [isRecording, onChange])

  return (
    <div
      ref={containerRef}
      className="flex items-center gap-2 shrink-0"
      onClick={() => !isRecording && setIsRecording(true)}
    >
      <div
        tabIndex={0}
        role="button"
        aria-label="Record shortcut"
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors select-none cursor-pointer w-52"
        style={{
          background: isRecording ? 'rgba(150,210,240,0.25)' : 'rgba(0,0,0,0.04)',
          color: isRecording ? theme.text.accent : theme.text.primary,
          border: `1px solid ${isRecording ? theme.border.strong : 'transparent'}`
        }}
        onFocus={() => setIsRecording(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setIsRecording(true)
          } else if (e.key === 'Escape') {
            setIsRecording(false)
          }
        }}
      >
        <Keyboard size={14} />
        <span className="flex-1 truncate text-center">
          {isRecording ? 'Press keys...' : formatAccelerator(value) || placeholder}
        </span>
      </div>
      {value && (
        <button
          type="button"
          className="p-1 rounded-md opacity-40 hover:opacity-80 transition-opacity"
          style={{ color: theme.text.secondary }}
          onClick={(e) => {
            e.stopPropagation()
            onChange('')
          }}
          aria-label="Clear shortcut"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
