import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRightLeft, Check, ChevronDown, Clock, Copy, Loader2, X } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import type { TranslateResult } from '../../shared/yachiyo/protocol'

const STORAGE_KEY = 'yachiyo-translator-target-lang'
const HISTORY_KEY = 'yachiyo-translator-history'

const COMMON_LANGUAGES = [
  'English',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Japanese',
  'Korean',
  'Spanish',
  'French',
  'German',
  'Russian',
  'Portuguese',
  'Italian',
  'Arabic',
  'Thai',
  'Vietnamese',
  'Indonesian'
]

interface HistoryEntry {
  id: string
  source: string
  target: string
  targetLanguage: string
}

function LanguageCombobox({
  value,
  onChange
}: {
  value: string
  onChange: (lang: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const filtered = filter
    ? COMMON_LANGUAGES.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : COMMON_LANGUAGES

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent): void => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="relative">
      <div
        className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[13px] cursor-pointer"
        style={{
          background: alpha('ink', 0.04),
          border: `1px solid ${alpha('ink', 0.08)}`
        }}
        onClick={() => {
          setOpen(!open)
          setFilter('')
          setTimeout(() => inputRef.current?.focus(), 0)
        }}
      >
        <ArrowRightLeft size={13} style={{ color: theme.text.secondary, flexShrink: 0 }} />
        <input
          ref={inputRef}
          className="bg-transparent outline-none flex-1 min-w-0"
          style={{ color: theme.text.primary }}
          placeholder="Target language..."
          value={open ? filter : value}
          onChange={(e) => {
            setFilter(e.target.value)
            if (!open) setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filter) {
              onChange(filter)
              setOpen(false)
              setFilter('')
            }
            if (e.key === 'Escape') {
              setOpen(false)
              setFilter('')
            }
          }}
          onFocus={() => {
            if (!open) {
              setOpen(true)
              setFilter('')
            }
          }}
        />
        <ChevronDown
          size={13}
          style={{
            color: theme.text.muted,
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s ease'
          }}
        />
      </div>
      {open && filtered.length > 0 && (
        <div
          ref={menuRef}
          className="absolute left-0 right-0 rounded-lg overflow-hidden overflow-y-auto"
          style={{
            bottom: 'calc(100% + 4px)',
            maxHeight: 200,
            background: theme.background.surfaceFrosted,
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: `1px solid ${theme.border.strong}`,
            boxShadow: theme.shadow.menu,
            zIndex: 50
          }}
        >
          {filtered.map((lang) => (
            <button
              key={lang}
              className="w-full text-left px-3 py-1.5 text-[13px] transition-colors"
              style={{
                color: lang === value ? theme.text.accent : theme.text.primary,
                background: lang === value ? theme.background.accentSoft : 'transparent'
              }}
              onMouseEnter={(e) => {
                if (lang !== value)
                  (e.currentTarget as HTMLElement).style.background = theme.background.hover
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLElement).style.background =
                  lang === value ? theme.background.accentSoft : 'transparent'
              }}
              onClick={() => {
                onChange(lang)
                setOpen(false)
                setFilter('')
              }}
            >
              {lang}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TranslatorApp(): React.JSX.Element {
  const [sourceText, setSourceText] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [targetLang, setTargetLang] = useState(() => localStorage.getItem(STORAGE_KEY) || 'English')
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    } catch {
      return []
    }
  })
  const [showHistory, setShowHistory] = useState(false)
  const [toolModelAvailable, setToolModelAvailable] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  }, [history])

  useEffect(() => {
    window.api.yachiyo.getConfig().then((config) => {
      const mode = config.toolModel?.mode ?? 'default'
      setToolModelAvailable(mode !== 'disabled')
    })
  }, [])

  const handleTargetLangChange = useCallback((lang: string) => {
    setTargetLang(lang)
    localStorage.setItem(STORAGE_KEY, lang)
  }, [])

  const handleTranslate = useCallback(async () => {
    if (!sourceText.trim() || loading) return

    setLoading(true)
    setTranslatedText('')

    // Subscribe to streaming deltas before starting the request
    let streamed = ''
    const unsub = window.api.yachiyo.onTranslateDelta((delta) => {
      streamed += delta
      setTranslatedText(streamed)
    })

    try {
      const result: TranslateResult = await window.api.yachiyo.translate({
        text: sourceText.trim(),
        targetLanguage: targetLang
      })

      unsub()

      if (result.status === 'success') {
        setTranslatedText(result.translatedText)
        setHistory((prev) => [
          {
            id: crypto.randomUUID(),
            source: sourceText.trim(),
            target: result.translatedText,
            targetLanguage: targetLang
          },
          ...prev.slice(0, 49)
        ])
      } else if (result.status === 'unavailable') {
        setTranslatedText(`[Unavailable] ${result.reason}`)
      } else {
        setTranslatedText(`[Error] ${result.error}`)
      }
    } catch (err) {
      unsub()
      setTranslatedText(`[Error] ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [sourceText, targetLang, loading])

  const handleCopy = useCallback(() => {
    if (!translatedText) return
    navigator.clipboard.writeText(translatedText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [translatedText])

  const handleHistoryClick = useCallback((entry: HistoryEntry) => {
    setSourceText(entry.source)
    setTranslatedText(entry.target)
    setTargetLang(entry.targetLanguage)
    localStorage.setItem(STORAGE_KEY, entry.targetLanguage)
    setShowHistory(false)
  }, [])

  return (
    <div
      className="flex flex-col h-full select-none relative"
      style={{ background: 'transparent' }}
    >
      {/* Title bar */}
      <div className="drag-region flex items-center shrink-0 px-3" style={{ height: 38 }}>
        <span className="no-drag text-[13px] font-medium" style={{ color: theme.text.secondary }}>
          Translator
        </span>
        <div className="flex-1" />
        {history.length > 0 && (
          <button
            className="no-drag p-1 rounded-md transition-opacity mr-1"
            style={{
              color: showHistory ? theme.text.accent : theme.icon.default,
              opacity: showHistory ? 0.9 : 0.4
            }}
            onClick={() => setShowHistory(!showHistory)}
            aria-label="History"
          >
            <Clock size={13} strokeWidth={1.5} />
          </button>
        )}
        <button
          className="no-drag p-1 rounded-md opacity-50 hover:opacity-80 transition-opacity"
          style={{ color: theme.icon.default }}
          onClick={() => window.close()}
          aria-label="Close"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      {/* Tool model unavailable notice */}
      {toolModelAvailable === false && (
        <div
          className="mx-3 mt-2 px-3 py-2 rounded-lg text-[12px] shrink-0"
          style={{
            background: theme.background.dangerSoft,
            color: theme.text.danger,
            border: `1px solid ${alpha('danger', 0.12)}`
          }}
        >
          Tool model is not configured. Go to Settings &gt; Chat to enable it.
        </div>
      )}

      {/* Input — fixed half */}
      <div className="flex-1 flex flex-col min-h-0 mx-3 mt-2">
        <textarea
          className="flex-1 resize-none rounded-lg px-3 py-2 text-[13px] outline-none"
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.text.primary
          }}
          placeholder="Enter text to translate..."
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              handleTranslate()
            }
          }}
        />
      </div>

      {/* Divider */}
      <div className="mx-6 shrink-0" style={{ height: 1, background: alpha('ink', 0.1) }} />

      {/* Output — fixed half */}
      <div className="flex-1 flex flex-col min-h-0 mx-3 mt-1.5 relative">
        <textarea
          readOnly
          className="flex-1 resize-none rounded-lg px-3 py-2 text-[13px] outline-none"
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.text.primary
          }}
          placeholder="Translation will appear here..."
          value={translatedText}
        />
        {loading && !translatedText && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 size={18} className="animate-spin" style={{ color: theme.text.accent }} />
          </div>
        )}
        {translatedText && !loading && (
          <button
            className="absolute top-2 right-2 p-1 rounded-md opacity-40 hover:opacity-80 transition-opacity"
            style={{ color: theme.icon.default }}
            onClick={handleCopy}
            aria-label="Copy translation"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
      </div>

      {/* Bottom bar: language selector + translate button */}
      <div className="shrink-0 mx-3 my-2 flex items-end gap-2">
        <div className="flex-1">
          <LanguageCombobox value={targetLang} onChange={handleTargetLangChange} />
        </div>
        <button
          className="shrink-0 px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition-opacity no-drag"
          style={{
            background: theme.text.accent,
            color: theme.text.inverse,
            opacity: !sourceText.trim() || loading || toolModelAvailable === false ? 0.4 : 1,
            cursor:
              !sourceText.trim() || loading || toolModelAvailable === false
                ? 'not-allowed'
                : 'pointer'
          }}
          disabled={!sourceText.trim() || loading || toolModelAvailable === false}
          onClick={handleTranslate}
        >
          {loading ? 'Translating...' : 'Translate'}
        </button>
      </div>

      {/* History overlay */}
      {showHistory && (
        <div
          className="absolute inset-x-0 overflow-y-auto rounded-b-lg"
          style={{
            top: 38,
            bottom: 0,
            background: 'transparent',
            backdropFilter: 'blur(40px)',
            WebkitBackdropFilter: 'blur(40px)',
            zIndex: 10
          }}
        >
          <div className="px-3 pt-2 pb-1">
            <span className="text-[11px] font-medium" style={{ color: theme.text.muted }}>
              History
            </span>
          </div>
          {history.map((entry) => (
            <button
              key={entry.id}
              className="w-full text-left px-3 py-2 text-[12px] transition-colors"
              style={{
                borderBottom: `1px solid ${theme.border.subtle}`,
                color: theme.text.secondary
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.background = theme.background.hover)
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.background = 'transparent')
              }
              onClick={() => handleHistoryClick(entry)}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span
                  className="text-[10px] px-1 rounded"
                  style={{ background: alpha('ink', 0.06), color: theme.text.muted }}
                >
                  {entry.targetLanguage}
                </span>
              </div>
              <div className="truncate" style={{ color: theme.text.muted }}>
                {entry.source.slice(0, 80)}
                {entry.source.length > 80 ? '...' : ''}
              </div>
              <div className="truncate mt-0.5" style={{ color: theme.text.primary }}>
                {entry.target.slice(0, 80)}
                {entry.target.length > 80 ? '...' : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
