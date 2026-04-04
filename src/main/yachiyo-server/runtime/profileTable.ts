import type { UserDocumentMode } from './user.ts'

// ---------------------------------------------------------------------------
// Section schema — defines columns and key column per section per mode
// ---------------------------------------------------------------------------

export interface SectionSchema {
  /** User-facing column headers (without the auto-managed "Since" column). */
  columns: string[]
  /** Which column serves as the upsert match key. */
  keyColumn: string
}

const OWNER_SECTIONS: Record<string, SectionSchema> = {
  Profile: { columns: ['Key', 'Value'], keyColumn: 'Key' },
  Preferences: { columns: ['Key', 'Value'], keyColumn: 'Key' },
  'Collaboration Notes': { columns: ['Topic', 'Note'], keyColumn: 'Topic' }
}

const GUEST_SECTIONS: Record<string, SectionSchema> = {
  Profile: { columns: ['Key', 'Value'], keyColumn: 'Key' },
  Preferences: { columns: ['Key', 'Value'], keyColumn: 'Key' },
  Notes: { columns: ['Topic', 'Note'], keyColumn: 'Topic' }
}

const GROUP_SECTIONS: Record<string, SectionSchema> = {
  People: { columns: ['Nickname', 'Identity', 'Notes'], keyColumn: 'Nickname' },
  'Group Vibe': { columns: ['Aspect', 'Description'], keyColumn: 'Aspect' },
  'Topic Hints': { columns: ['Topic', 'Hint'], keyColumn: 'Topic' }
}

const SECTIONS_BY_MODE: Record<string, Record<string, SectionSchema>> = {
  owner: OWNER_SECTIONS,
  guest: GUEST_SECTIONS,
  group: GROUP_SECTIONS
}

export function getSectionsForMode(mode?: UserDocumentMode): Record<string, SectionSchema> {
  return SECTIONS_BY_MODE[mode ?? 'owner'] ?? OWNER_SECTIONS
}

export function getSectionSchema(
  sectionName: string,
  mode?: UserDocumentMode
): SectionSchema | undefined {
  const sections = getSectionsForMode(mode)
  // Case-insensitive lookup
  const entry = Object.entries(sections).find(
    ([name]) => name.toLowerCase() === sectionName.toLowerCase()
  )
  return entry?.[1]
}

export function getCanonicalSectionName(
  sectionName: string,
  mode?: UserDocumentMode
): string | undefined {
  const sections = getSectionsForMode(mode)
  const entry = Object.entries(sections).find(
    ([name]) => name.toLowerCase() === sectionName.toLowerCase()
  )
  return entry?.[0]
}

// ---------------------------------------------------------------------------
// Markdown table parsing
// ---------------------------------------------------------------------------

/** A parsed table row: column name → cell value. */
export type TableRow = Record<string, string>

/** The auto-managed timestamp column name. */
const SINCE_COLUMN = 'Since'

/** Legacy column headers that should map to current canonical names. */
const COLUMN_ALIASES: Record<string, string> = {
  'identity / real name': 'Identity'
}

function resolveColumnAlias(header: string): string {
  return COLUMN_ALIASES[header.toLowerCase()] ?? header
}

function parseCells(line: string): string[] {
  // Split "| a | b | c |" or "| a | b | c" into ["a", "b", "c"]
  const stripped = line.replace(/^\|/, '').replace(/\|\s*$/, '')
  return stripped.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  // Match lines like |---|---|---| or |:---:|---| but not data rows with empty cells
  return /^\|[\s:-]+(\|[\s:-]+)+\|?\s*$/.test(line)
}

function isTableRow(line: string): boolean {
  // Accept rows with or without trailing pipe: "| a | b |" and "| a | b"
  return line.trimStart().startsWith('|') && line.includes('|', 1)
}

/**
 * Parse a markdown table from raw section body lines.
 * Returns parsed rows keyed by column headers, plus any non-table lines
 * that need migration.
 */
export function parseTable(
  bodyLines: string[],
  schema: SectionSchema
): { rows: TableRow[]; legacyLines: string[] } {
  const allColumns = [...schema.columns, SINCE_COLUMN]
  const rows: TableRow[] = []
  const legacyLines: string[] = []

  let foundHeaders = false
  let headerColumns: string[] = []

  for (const line of bodyLines) {
    const trimmed = line.trim()

    // Skip empty lines and HTML comments
    if (!trimmed || trimmed.startsWith('<!--')) continue

    if (!foundHeaders && isTableRow(trimmed)) {
      // First table row = headers — resolve legacy aliases
      headerColumns = parseCells(trimmed).map(resolveColumnAlias)
      foundHeaders = true
      continue
    }

    if (foundHeaders && isTableSeparator(trimmed)) {
      // Skip the separator line after headers
      continue
    }

    if (foundHeaders && isTableRow(trimmed)) {
      const cells = parseCells(trimmed)
      const row: TableRow = {}
      for (let i = 0; i < headerColumns.length; i++) {
        const col = headerColumns[i]
        if (col && allColumns.some((c) => c.toLowerCase() === col.toLowerCase())) {
          // Map to canonical column name
          const canonical = allColumns.find((c) => c.toLowerCase() === col.toLowerCase()) ?? col
          row[canonical] = cells[i]?.trim() ?? ''
        }
      }
      rows.push(row)
      continue
    }

    // Non-table line — legacy freeform content
    if (trimmed.length > 0) {
      legacyLines.push(trimmed)
    }
  }

  return { rows, legacyLines }
}

/**
 * Convert legacy freeform lines into table rows.
 * Each line becomes a row with only the last content column filled.
 */
export function migrateLegacyLines(
  lines: string[],
  schema: SectionSchema,
  timestamp: string
): TableRow[] {
  const lastContentColumn = schema.columns[schema.columns.length - 1]
  if (!lastContentColumn) return []

  return lines.map((line) => {
    const row: TableRow = {}
    for (const col of schema.columns) {
      row[col] = ''
    }
    row[lastContentColumn] = line
    row[SINCE_COLUMN] = timestamp
    return row
  })
}

// ---------------------------------------------------------------------------
// Table operations
// ---------------------------------------------------------------------------

/**
 * Upsert rows into an existing table. Matches by key column (case-insensitive).
 * New rows get the provided timestamp. Updated rows get their timestamp refreshed.
 */
export function upsertRows(
  existing: TableRow[],
  entries: TableRow[],
  schema: SectionSchema,
  timestamp: string
): TableRow[] {
  const result = [...existing]
  const keyCol = schema.keyColumn

  for (const entry of entries) {
    const entryKey = (entry[keyCol] ?? '').toLowerCase()
    const idx = result.findIndex((row) => (row[keyCol] ?? '').toLowerCase() === entryKey)

    if (idx >= 0) {
      // Merge: preserve existing columns, overwrite only provided ones
      const merged: TableRow = { ...result[idx] }
      for (const col of schema.columns) {
        if (col in entry) {
          merged[col] = entry[col] ?? ''
        }
      }
      merged[SINCE_COLUMN] = timestamp
      result[idx] = merged
    } else {
      // Insert: fill all columns, empty string for omitted ones
      const newRow: TableRow = {}
      for (const col of schema.columns) {
        newRow[col] = entry[col] ?? ''
      }
      newRow[SINCE_COLUMN] = timestamp
      result.push(newRow)
    }
  }

  return result
}

/**
 * Remove rows by key column value (case-insensitive).
 */
export function removeRows(
  existing: TableRow[],
  keys: string[],
  schema: SectionSchema
): TableRow[] {
  const keyCol = schema.keyColumn
  const lowerKeys = new Set(keys.map((k) => k.toLowerCase()))
  return existing.filter((row) => !lowerKeys.has((row[keyCol] ?? '').toLowerCase()))
}

// ---------------------------------------------------------------------------
// Markdown table rendering
// ---------------------------------------------------------------------------

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * Render a table as markdown lines (headers + separator + data rows).
 */
export function renderTable(rows: TableRow[], schema: SectionSchema): string {
  const allColumns = [...schema.columns, SINCE_COLUMN]

  const header = '| ' + allColumns.join(' | ') + ' |'
  const separator = '|' + allColumns.map(() => '---').join('|') + '|'

  const dataLines = rows.map((row) => {
    const cells = allColumns.map((col) => escapeCell(row[col] ?? ''))
    return '| ' + cells.join(' | ') + ' |'
  })

  return [header, separator, ...dataLines].join('\n')
}

// ---------------------------------------------------------------------------
// Tool description builder
// ---------------------------------------------------------------------------

export function buildSectionDescriptionBlock(mode?: UserDocumentMode): string {
  const sections = getSectionsForMode(mode)
  const lines = Object.entries(sections).map(([name, schema]) => {
    const colDesc = schema.columns
      .map((col) => (col === schema.keyColumn ? `${col} (key)` : col))
      .join(', ')
    return `- "${name}": ${colDesc}`
  })
  return lines.join('\n')
}

/**
 * Format a timestamp for the Since column.
 */
export function formatTimestamp(date?: Date): string {
  const d = date ?? new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// Eager migration — converts legacy freeform USER.md to table structure
// ---------------------------------------------------------------------------

interface SectionSpan {
  headingIdx: number
  bodyStart: number
  bodyEnd: number
}

/**
 * Find ALL occurrences of a `## SectionName` heading in the document lines.
 */
function findAllSectionSpans(lines: string[], sectionName: string): SectionSpan[] {
  const headingRe = new RegExp(
    `^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'i'
  )
  const spans: SectionSpan[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i])) continue

    const bodyStart = i + 1
    let bodyEnd = lines.length
    for (let j = bodyStart; j < lines.length; j++) {
      if (/^##\s/.test(lines[j])) {
        bodyEnd = j
        break
      }
    }
    spans.push({ headingIdx: i, bodyStart, bodyEnd })
  }

  return spans
}

/**
 * Migrate a USER.md document in place. Handles:
 * 1. Legacy freeform content → table rows
 * 2. Duplicate section headings → merged into one section
 * 3. Missing sections from schema → appended with empty tables
 *
 * Rebuilds the document so each schema section appears exactly once with
 * a proper table. Returns true if any changes were made.
 */
export function migrateDocumentToTables(
  content: string,
  mode?: UserDocumentMode
): { migrated: boolean; content: string } {
  const sections = getSectionsForMode(mode)
  const lines = content.split('\n')
  const timestamp = formatTimestamp()
  let needsMigration = false

  // Collect all rows and legacy lines from ALL occurrences of each section
  const mergedData = new Map<string, { schema: SectionSchema; rows: TableRow[] }>()

  for (const [name, schema] of Object.entries(sections)) {
    const spans = findAllSectionSpans(lines, name)
    const allRows: TableRow[] = []

    if (spans.length > 1) needsMigration = true

    for (const span of spans) {
      const bodyLines = lines.slice(span.bodyStart, span.bodyEnd)
      const { rows, legacyLines } = parseTable(bodyLines, schema)
      allRows.push(...rows)

      if (legacyLines.length > 0) {
        allRows.push(...migrateLegacyLines(legacyLines, schema, timestamp))
        needsMigration = true
      }
    }

    // Check if existing single section lacks table headers
    if (spans.length === 1) {
      const bodyLines = lines.slice(spans[0].bodyStart, spans[0].bodyEnd)
      const hasTableHeaders = bodyLines.some(
        (line) => isTableRow(line.trim()) && !isTableSeparator(line.trim())
      )
      if (!hasTableHeaders && allRows.length === 0) {
        needsMigration = true // Section exists but has no table — needs headers
      }
    }

    if (spans.length === 0) {
      needsMigration = true // Missing section — needs to be appended
    }

    mergedData.set(name, { schema, rows: allRows })
  }

  if (!needsMigration) return { migrated: false, content }

  // Collect all non-schema section spans to preserve them
  const schemaNamesLower = new Set(Object.keys(sections).map((n) => n.toLowerCase()))
  const nonSchemaSections: Array<{ heading: string; body: string[] }> = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/)
    if (!match) continue
    const name = match[1]
    if (schemaNamesLower.has(name.toLowerCase())) continue

    // Non-schema section — preserve it
    const bodyStart = i + 1
    let bodyEnd = lines.length
    for (let j = bodyStart; j < lines.length; j++) {
      if (/^##\s/.test(lines[j])) {
        bodyEnd = j
        break
      }
    }
    nonSchemaSections.push({
      heading: `## ${name}`,
      body: lines.slice(bodyStart, bodyEnd)
    })
  }

  // Rebuild: preamble + schema sections + preserved non-schema sections
  const firstSectionIdx = lines.findIndex((line) => /^##\s/.test(line))
  const preamble = firstSectionIdx >= 0 ? lines.slice(0, firstSectionIdx) : [...lines]

  const rebuilt = [...preamble]

  for (const [name, { schema, rows }] of mergedData) {
    rebuilt.push(`## ${name}`, '', renderTable(rows, schema), '')
  }

  for (const section of nonSchemaSections) {
    rebuilt.push(section.heading, ...section.body)
  }

  return { migrated: true, content: rebuilt.join('\n') }
}
