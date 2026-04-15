import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TableRow {
  cells: string[]
}

interface Section {
  heading: string
  /** Non-table lines that appear before the table in this section. */
  preTableLines: string[]
  headers: string[]
  rows: TableRow[]
  /** Non-table lines that appear after the table in this section. */
  postTableLines: string[]
}

interface ParsedDocument {
  preamble: string[]
  sections: Section[]
}

// ---------------------------------------------------------------------------
// Markdown table parsing
// ---------------------------------------------------------------------------

function isTableSeparator(line: string): boolean {
  return /^\|[\s:-]+(\|[\s:-]+)+\|?\s*$/.test(line)
}

function parseCells(line: string): string[] {
  // Split on unescaped pipes only (not \|)
  const inner = line.replace(/^\|/, '').replace(/\|\s*$/, '')
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && i + 1 < inner.length && inner[i + 1] === '|') {
      current += '|'
      i++ // skip the pipe
    } else if (inner[i] === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += inner[i]
    }
  }
  cells.push(current.trim())
  // Decode <br> tags back to newlines for editing
  return cells.map((c) => c.replace(/<br\s*\/?>/gi, '\n'))
}

function parseDocument(content: string): ParsedDocument {
  const lines = content.split('\n')
  const preamble: string[] = []
  const sections: Section[] = []

  let i = 0

  // Collect preamble (everything before the first ## heading)
  while (i < lines.length && !/^##\s/.test(lines[i])) {
    preamble.push(lines[i])
    i++
  }

  // Collect sections
  while (i < lines.length) {
    if (/^##\s/.test(lines[i])) {
      const heading = lines[i].replace(/^##\s+/, '').trim()
      i++

      const bodyLines: string[] = []
      while (i < lines.length && !/^##\s/.test(lines[i])) {
        bodyLines.push(lines[i])
        i++
      }

      // Parse table from body, preserving non-table lines
      let headers: string[] = []
      const rows: TableRow[] = []
      const preTableLines: string[] = []
      const postTableLines: string[] = []
      let foundHeaders = false
      let tableEnded = false

      for (const line of bodyLines) {
        const trimmed = line.trim()

        if (tableEnded) {
          postTableLines.push(line)
          continue
        }

        if (!foundHeaders && trimmed.startsWith('|') && !isTableSeparator(trimmed)) {
          headers = parseCells(trimmed)
          foundHeaders = true
          continue
        }

        if (foundHeaders && isTableSeparator(trimmed)) continue

        if (foundHeaders && trimmed.startsWith('|')) {
          const cells = parseCells(trimmed)
          // Pad or trim to match header count
          while (cells.length < headers.length) cells.push('')
          rows.push({ cells: cells.slice(0, headers.length) })
          continue
        }

        // Non-table line
        if (!foundHeaders) {
          preTableLines.push(line)
        } else {
          // First non-table line after table started → table ended
          tableEnded = true
          postTableLines.push(line)
        }
      }

      sections.push({ heading, headers, rows, preTableLines, postTableLines })
    } else {
      i++
    }
  }

  return { preamble, sections }
}

// ---------------------------------------------------------------------------
// Markdown table serialization
// ---------------------------------------------------------------------------

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function serializeDocument(doc: ParsedDocument): string {
  const parts: string[] = [...doc.preamble]

  for (const section of doc.sections) {
    parts.push(`## ${section.heading}`)

    // Preserved non-table lines before the table
    if (section.preTableLines.length > 0) {
      parts.push(...section.preTableLines)
    } else {
      parts.push('')
    }

    if (section.headers.length > 0) {
      parts.push('| ' + section.headers.join(' | ') + ' |')
      parts.push('|' + section.headers.map(() => '---').join('|') + '|')

      for (const row of section.rows) {
        parts.push('| ' + row.cells.map(escapeCell).join(' | ') + ' |')
      }
    }

    // Preserved non-table lines after the table
    if (section.postTableLines.length > 0) {
      parts.push(...section.postTableLines)
    } else {
      parts.push('')
    }
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Helpers — which columns are editable
// ---------------------------------------------------------------------------

/** Columns auto-managed by the system — shown but not editable. */
const READONLY_COLUMNS = new Set(['#', 'Since'])

function isEditableColumn(header: string): boolean {
  return !READONLY_COLUMNS.has(header)
}

function editableColumnIndices(headers: string[]): number[] {
  return headers.reduce<number[]>((acc, h, i) => {
    if (isEditableColumn(h)) acc.push(i)
    return acc
  }, [])
}

// ---------------------------------------------------------------------------
// Auto-resizing textarea for multiline cell editing
// ---------------------------------------------------------------------------

function AutoResizeTextarea({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}): React.ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      className="flex-1 resize-none rounded-lg px-2.5 py-1.5 text-sm outline-none"
      style={{
        background: alpha('ink', 0.04),
        border: 'none',
        color: theme.text.primary,
        overflow: 'hidden'
      }}
      placeholder={placeholder}
    />
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface UserDocumentTableEditorProps {
  content: string
  onChange: (next: string) => void
}

export function UserDocumentTableEditor({
  content,
  onChange
}: UserDocumentTableEditorProps): React.ReactNode {
  // Maintain local parsed state to avoid lossy serialize→parse round-trips
  // (markdown table parsing trims cell whitespace, which eats trailing spaces).
  const [doc, setDoc] = useState(() => parseDocument(content))
  const [prevContent, setPrevContent] = useState(content)

  // Re-parse only when the parent pushes a genuinely new content string
  // (e.g. initial load, revert).
  if (content !== prevContent) {
    setPrevContent(content)
    setDoc(parseDocument(content))
  }

  const emitChange = useCallback(
    (next: ParsedDocument) => {
      setDoc(next)
      const serialized = serializeDocument(next)
      setPrevContent(serialized)
      onChange(serialized)
    },
    [onChange]
  )

  function updateCell(sectionIdx: number, rowIdx: number, colIdx: number, value: string): void {
    const next = structuredClone(doc)
    next.sections[sectionIdx].rows[rowIdx].cells[colIdx] = value
    emitChange(next)
  }

  function addRow(sectionIdx: number): void {
    const next = structuredClone(doc)
    const section = next.sections[sectionIdx]
    const cells = section.headers.map((h) => (READONLY_COLUMNS.has(h) ? '' : ''))
    section.rows.push({ cells })
    emitChange(next)
  }

  function removeRow(sectionIdx: number, rowIdx: number): void {
    const next = structuredClone(doc)
    next.sections[sectionIdx].rows.splice(rowIdx, 1)
    emitChange(next)
  }

  if (doc.sections.length === 0) {
    return (
      <div className="px-7 pb-4 text-sm" style={{ color: theme.text.muted }}>
        No sections found in USER.md
      </div>
    )
  }

  return (
    <div className="space-y-5 px-7 pb-5">
      {doc.sections.map((section, si) => {
        const editableCols = editableColumnIndices(section.headers)
        const sinceIdx = section.headers.indexOf('Since')

        return (
          <div key={section.heading}>
            {/* Section heading */}
            <div
              className="pb-2 text-[11px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: theme.text.secondary }}
            >
              {section.heading}
            </div>

            {/* Table rows */}
            <div className="overflow-hidden rounded-xl" style={{ background: alpha('ink', 0.025) }}>
              {section.rows.length === 0 ? (
                <div className="px-4 py-5 text-center text-sm" style={{ color: theme.text.muted }}>
                  No entries yet
                </div>
              ) : (
                section.rows.map((row, ri) => (
                  <div
                    key={ri}
                    className="group flex items-start gap-3 px-4 py-2.5"
                    style={{
                      borderTop: ri > 0 ? `1px solid ${alpha('ink', 0.05)}` : undefined
                    }}
                  >
                    {/* Editable cells */}
                    <div className="flex flex-1 flex-col gap-1.5">
                      {editableCols.map((colIdx) => {
                        const header = section.headers[colIdx]
                        const value = row.cells[colIdx] ?? ''

                        return (
                          <div key={colIdx} className="flex items-start gap-2">
                            <span
                              className="w-20 shrink-0 pt-1.5 text-xs"
                              style={{ color: theme.text.tertiary }}
                            >
                              {header}
                            </span>
                            <AutoResizeTextarea
                              value={value}
                              onChange={(v) => updateCell(si, ri, colIdx, v)}
                              placeholder={header}
                            />
                          </div>
                        )
                      })}

                      {/* Since timestamp (read-only) */}
                      {sinceIdx !== -1 && row.cells[sinceIdx] ? (
                        <div className="flex items-center gap-2">
                          <span className="w-20 shrink-0" />
                          <span className="text-xs" style={{ color: theme.text.muted }}>
                            {row.cells[sinceIdx]}
                          </span>
                        </div>
                      ) : null}
                    </div>

                    {/* Delete button */}
                    <button
                      type="button"
                      onClick={() => removeRow(si, ri)}
                      className="mt-1.5 shrink-0 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100!"
                      style={{ color: theme.text.danger }}
                      aria-label={`Remove row ${ri + 1}`}
                    >
                      <Trash2 size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))
              )}

              {/* Add row */}
              <button
                type="button"
                onClick={() => addRow(si)}
                className="flex w-full items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors"
                style={{
                  color: theme.text.accent,
                  borderTop: `1px solid ${alpha('ink', 0.05)}`,
                  opacity: 0.7
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '1'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '0.7'
                }}
              >
                <Plus size={14} strokeWidth={2} />
                Add
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
