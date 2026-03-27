import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import type { SettingsConfig, UserPrompt } from '../../../shared/yachiyo/protocol.ts'
import { normalizeUserPrompts } from '../../../shared/yachiyo/protocol.ts'
import { SettingLabel, SettingSection } from '../components/primitives'
import { inputStyle } from '../components/styles'

const KEYCODE_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/

interface DraftRow {
  keycode: string
  text: string
}

interface PromptsProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function PromptsPane({ draft, onChange }: PromptsProps): React.ReactNode {
  const [rows, setRows] = useState<DraftRow[]>(() =>
    (draft.prompts ?? []).map((p) => ({ keycode: p.keycode, text: p.text }))
  )
  const [keycodeErrors, setKeycodeErrors] = useState<Record<number, string>>({})

  useEffect(() => {
    const valid = rows.filter(
      (row, idx) => row.keycode && KEYCODE_RE.test(row.keycode) && row.text && !keycodeErrors[idx]
    )
    const deduped: UserPrompt[] = []
    const seen = new Set<string>()
    for (const row of valid) {
      if (!seen.has(row.keycode)) {
        seen.add(row.keycode)
        deduped.push({ keycode: row.keycode, text: row.text })
      }
    }
    const normalized = normalizeUserPrompts(deduped)
    onChange({ ...draft, prompts: normalized })
  }, [rows, keycodeErrors]) // eslint-disable-line react-hooks/exhaustive-deps

  function validateKeycode(value: string, index: number): void {
    const errors = { ...keycodeErrors }
    if (!value) {
      errors[index] = 'Keycode is required.'
    } else if (!KEYCODE_RE.test(value)) {
      errors[index] = 'Must start with a letter, then letters, digits, or hyphens.'
    } else {
      const duplicate = rows.some((row, i) => i !== index && row.keycode === value)
      if (duplicate) {
        errors[index] = 'Keycode already used.'
      } else {
        delete errors[index]
      }
    }
    setKeycodeErrors(errors)
  }

  function updateRow(index: number, patch: Partial<DraftRow>): void {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function addRow(): void {
    setRows((prev) => [...prev, { keycode: '', text: '' }])
  }

  function removeRow(index: number): void {
    setRows((prev) => prev.filter((_, i) => i !== index))
    setKeycodeErrors((prev) => {
      const next: Record<number, string> = {}
      for (const [key, val] of Object.entries(prev)) {
        const k = Number(key)
        if (k < index) next[k] = val
        else if (k > index) next[k - 1] = val
      }
      return next
    })
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel
          action={
            <button
              type="button"
              onClick={addRow}
              className="flex items-center gap-1 text-xs font-medium transition-opacity opacity-60 hover:opacity-100"
              style={{ color: theme.text.accent }}
            >
              <Plus size={13} strokeWidth={1.8} />
              Add prompt
            </button>
          }
        >
          Prompts
        </SettingLabel>

        {rows.length === 0 ? (
          <div
            className="px-7 pb-4 text-sm leading-5"
            style={{
              color: theme.text.tertiary,
              borderTop: `1px solid ${theme.border.subtle}`
            }}
          >
            No prompts defined. Add a prompt to use it as a /command in the composer.
          </div>
        ) : (
          rows.map((row, index) => (
            <div
              key={index}
              className="px-7 py-4 space-y-2.5"
              style={{ borderTop: `1px solid ${theme.border.subtle}` }}
            >
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1" style={{ width: 160 }}>
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-mono" style={{ color: theme.text.muted }}>
                      /
                    </span>
                    <input
                      type="text"
                      value={row.keycode}
                      placeholder="keycode"
                      className="flex-1 rounded-lg px-2 py-1 text-xs font-mono outline-none"
                      style={inputStyle()}
                      onChange={(e) => updateRow(index, { keycode: e.target.value })}
                      onBlur={(e) => validateKeycode(e.target.value, index)}
                      spellCheck={false}
                    />
                  </div>
                  {keycodeErrors[index] ? (
                    <div className="text-xs leading-4" style={{ color: theme.text.danger }}>
                      {keycodeErrors[index]}
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  className="ml-auto p-1 rounded-lg opacity-50 hover:opacity-80 transition-opacity"
                  aria-label="Remove prompt"
                >
                  <Trash2 size={14} strokeWidth={1.6} color={theme.icon.muted} />
                </button>
              </div>

              <textarea
                value={row.text}
                placeholder="Prompt text…"
                rows={3}
                className="w-full rounded-lg px-3 py-2 text-sm resize-none outline-none leading-relaxed"
                style={inputStyle()}
                onChange={(e) => updateRow(index, { text: e.target.value })}
              />
            </div>
          ))
        )}
      </SettingSection>
    </div>
  )
}
