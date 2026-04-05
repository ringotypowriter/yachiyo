import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Eye, List, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { theme, alpha } from '@renderer/theme/theme'
import type { JotdownFull, JotdownMeta } from '../../shared/yachiyo/protocol'

type SaveStatus = 'idle' | 'saving' | 'saved'

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function JotdownApp(): React.JSX.Element {
  const [notes, setNotes] = useState<JotdownMeta[]>([])
  const [activeNote, setActiveNote] = useState<JotdownFull | null>(null)
  const [content, setContent] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [showList, setShowList] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<{ id: string; content: string } | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const selectingRef = useRef<string | null>(null)

  // Focus list overlay only when it first opens
  useEffect(() => {
    if (showList) {
      listRef.current?.focus()
    }
  }, [showList])

  // Close list on Escape
  useEffect(() => {
    if (!showList) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShowList(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [showList])

  // Load notes on mount
  useEffect(() => {
    window.api.yachiyo.listJotdowns().then((list) => {
      setNotes(list)
      if (list.length > 0) {
        window.api.yachiyo.loadJotdown({ id: list[0].id }).then((note) => {
          setActiveNote(note)
          setContent(note.content)
        })
      } else {
        window.api.yachiyo.createJotdown().then((note) => {
          setActiveNote(note)
          setContent(note.content)
          setNotes([
            {
              id: note.id,
              title: note.title,
              createdAt: note.createdAt,
              modifiedAt: note.modifiedAt
            }
          ])
        })
      }
    })
  }, [])

  const flushSave = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingSaveRef.current
    if (pending) {
      pendingSaveRef.current = null
      setSaveStatus('saving')
      const meta = await window.api.yachiyo.saveJotdown(pending)
      setNotes((prev) => prev.map((n) => (n.id === meta.id ? meta : n)))
      setSaveStatus('saved')
    }
  }, [])

  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent)
      setSaveStatus('idle')
      if (!activeNote) return

      pendingSaveRef.current = { id: activeNote.id, content: newContent }

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(async () => {
        const pending = pendingSaveRef.current
        if (!pending) return
        pendingSaveRef.current = null
        setSaveStatus('saving')
        const meta = await window.api.yachiyo.saveJotdown(pending)
        setNotes((prev) => prev.map((n) => (n.id === meta.id ? meta : n)))
        setSaveStatus('saved')
      }, 500)
    },
    [activeNote]
  )

  // Flush pending save on unmount (window close)
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const pending = pendingSaveRef.current
      if (pending) {
        pendingSaveRef.current = null
        // Fire-and-forget — the window is closing, but the IPC call
        // reaches the main process synchronously enough to persist.
        window.api.yachiyo.saveJotdown(pending)
      }
    }
  }, [])

  const handleCreate = useCallback(async () => {
    await flushSave()
    selectingRef.current = null
    const note = await window.api.yachiyo.createJotdown()
    setNotes((prev) => [
      { id: note.id, title: note.title, createdAt: note.createdAt, modifiedAt: note.modifiedAt },
      ...prev
    ])
    setActiveNote(note)
    setContent(note.content)
    setSaveStatus('idle')
    setShowList(false)
    setMode('edit')
  }, [flushSave])

  const handleSelectNote = useCallback(
    async (id: string) => {
      if (activeNote?.id === id) {
        setShowList(false)
        return
      }
      await flushSave()
      selectingRef.current = id
      const note = await window.api.yachiyo.loadJotdown({ id })
      if (selectingRef.current !== id) return
      setActiveNote(note)
      setContent(note.content)
      setSaveStatus('idle')
      setShowList(false)
    },
    [activeNote, flushSave]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      // Cancel any pending autosave for the note being deleted
      // so it doesn't get resurrected after deletion.
      if (pendingSaveRef.current?.id === id) {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        pendingSaveRef.current = null
        setSaveStatus('idle')
      }
      await window.api.yachiyo.deleteJotdown({ id })
      const remaining = notes.filter((n) => n.id !== id)
      setNotes(remaining)

      if (activeNote?.id === id) {
        if (remaining.length > 0) {
          const note = await window.api.yachiyo.loadJotdown({ id: remaining[0].id })
          setActiveNote(note)
          setContent(note.content)
        } else {
          const note = await window.api.yachiyo.createJotdown()
          setNotes([
            {
              id: note.id,
              title: note.title,
              createdAt: note.createdAt,
              modifiedAt: note.modifiedAt
            }
          ])
          setActiveNote(note)
          setContent(note.content)
        }
        setSaveStatus('idle')
      }
    },
    [activeNote, notes]
  )

  return (
    <div
      className="flex flex-col h-full select-none relative"
      style={{ background: 'transparent' }}
    >
      {/* Title bar */}
      <div className="drag-region flex items-center shrink-0 px-3" style={{ height: 38 }}>
        <span className="no-drag text-[13px] font-medium" style={{ color: theme.text.secondary }}>
          Jot Down
        </span>
        <div className="flex-1" />
        <button
          className="no-drag p-1 rounded-md opacity-50 hover:opacity-80 transition-opacity mr-0.5"
          style={{ color: theme.icon.default }}
          onClick={handleCreate}
          aria-label="New note"
        >
          <Plus size={14} strokeWidth={1.5} />
        </button>
        {notes.length > 0 && (
          <button
            className="no-drag p-1 rounded-md transition-opacity mr-0.5"
            style={{
              color: showList ? theme.text.accent : theme.icon.default,
              opacity: showList ? 0.9 : 0.5
            }}
            onClick={() => setShowList(!showList)}
            aria-label="Note list"
            aria-expanded={showList}
            aria-controls="jotdown-list"
          >
            <List size={14} strokeWidth={1.5} />
          </button>
        )}
        <button
          className="no-drag p-1 rounded-md opacity-50 hover:opacity-80 transition-opacity mr-0.5"
          style={{ color: mode === 'preview' ? theme.text.accent : theme.icon.default }}
          onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}
          aria-label={mode === 'edit' ? 'Preview' : 'Edit'}
        >
          {mode === 'edit' ? (
            <Eye size={13} strokeWidth={1.5} />
          ) : (
            <Pencil size={13} strokeWidth={1.5} />
          )}
        </button>
        <button
          className="no-drag p-1 rounded-md opacity-50 hover:opacity-80 transition-opacity"
          style={{ color: theme.icon.default }}
          onClick={() => window.api.hideJotdown()}
          aria-label="Close"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      {/* Main area */}
      <div className="flex-1 min-h-0 mx-3 mb-1">
        {mode === 'edit' ? (
          <textarea
            className="w-full h-full resize-none rounded-lg px-3 py-2 text-[13px] outline-none"
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.text.primary,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
              lineHeight: 1.6
            }}
            placeholder="Start writing..."
            aria-label="Note content"
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
          />
        ) : (
          <div
            className="w-full h-full overflow-y-auto rounded-lg px-3 py-2 text-[13px]"
            style={{ color: theme.text.primary }}
          >
            {content ? (
              <div className="streamdown-content">
                <Streamdown mode="static">{content}</Streamdown>
              </div>
            ) : (
              <span style={{ color: theme.text.placeholder }}>Nothing to preview...</span>
            )}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div
        className="shrink-0 mx-3 mb-2 flex items-center justify-between px-1 text-[11px]"
        style={{ color: theme.text.muted }}
      >
        <span>{activeNote ? formatDate(activeNote.createdAt) : ''}</span>
        <span className="flex items-center gap-1">
          {saveStatus === 'saving' && (
            <>
              <Loader2 size={10} className="animate-spin" />
              Saving...
            </>
          )}
          {saveStatus === 'saved' && (
            <>
              <Check size={10} />
              Saved
            </>
          )}
        </span>
      </div>

      {/* Note list overlay */}
      {showList && (
        <div
          ref={listRef}
          id="jotdown-list"
          role="dialog"
          aria-label="Notes"
          tabIndex={-1}
          className="absolute inset-x-0 overflow-y-auto rounded-b-lg outline-none"
          style={{
            top: 38,
            bottom: 0,
            background: theme.background.surfaceFrosted,
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            borderTop: `1px solid ${theme.border.subtle}`,
            boxShadow: theme.shadow.overlay,
            zIndex: 10
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowList(false)
          }}
        >
          <div className="px-3 pt-2 pb-1">
            <span className="text-[11px] font-medium" style={{ color: theme.text.muted }}>
              Notes
            </span>
          </div>
          {notes.map((note, index) => (
            <div
              key={note.id}
              role="button"
              tabIndex={0}
              aria-label={`Open note: ${note.title}`}
              className="flex items-center px-3 py-2 text-[12px] transition-colors group"
              style={{
                borderBottom:
                  index < notes.length - 1 ? `1px solid ${theme.border.subtle}` : undefined,
                background:
                  note.id === activeNote?.id ? theme.background.accentSoft : 'transparent',
                cursor: 'pointer'
              }}
              onMouseEnter={(e) => {
                if (note.id !== activeNote?.id)
                  (e.currentTarget as HTMLElement).style.background = theme.background.hover
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLElement).style.background =
                  note.id === activeNote?.id ? theme.background.accentSoft : 'transparent'
              }}
              onFocus={(e) => {
                if (note.id !== activeNote?.id)
                  (e.currentTarget as HTMLElement).style.background = theme.background.hover
              }}
              onBlur={(e) => {
                ;(e.currentTarget as HTMLElement).style.background =
                  note.id === activeNote?.id ? theme.background.accentSoft : 'transparent'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleSelectNote(note.id)
                }
              }}
              onClick={() => handleSelectNote(note.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span
                    className="text-[10px] px-1 rounded"
                    style={{ background: alpha('ink', 0.06), color: theme.text.muted }}
                  >
                    {formatTime(note.createdAt)}
                  </span>
                  <span className="text-[10px]" style={{ color: theme.text.muted }}>
                    {formatDate(note.createdAt)}
                  </span>
                </div>
                <div
                  className="truncate"
                  style={{
                    color: note.id === activeNote?.id ? theme.text.accent : theme.text.primary
                  }}
                >
                  {note.title}
                </div>
              </div>
              <button
                className="shrink-0 p-1 rounded-md opacity-0 group-hover:opacity-40 focus-visible:opacity-80 hover:opacity-80! transition-opacity ml-2"
                style={{ color: theme.text.danger }}
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete(note.id)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                }}
                aria-label="Delete note"
              >
                <Trash2 size={12} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
