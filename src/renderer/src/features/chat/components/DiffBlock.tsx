import type React from 'react'
import { alpha, solid } from '@renderer/theme/theme'

interface DiffBlockProps {
  value: string
}

type LineType = 'fileHeader' | 'hunk' | 'added' | 'removed' | 'context'

interface ParsedLine {
  type: LineType
  text: string
  oldNum: number | null
  newNum: number | null
}

function classifyLine(line: string): LineType {
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'fileHeader'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  return 'context'
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
  if (!match) return null
  return { oldStart: parseInt(match[1], 10), newStart: parseInt(match[2], 10) }
}

function parseDiffLines(raw: string): ParsedLine[] {
  const lines = raw.split('\n')
  const result: ParsedLine[] = []
  let oldNum = 0
  let newNum = 0

  for (const line of lines) {
    const type = classifyLine(line)

    if (type === 'fileHeader') {
      result.push({ type, text: line, oldNum: null, newNum: null })
    } else if (type === 'hunk') {
      const hunk = parseHunkHeader(line)
      if (hunk) {
        oldNum = hunk.oldStart
        newNum = hunk.newStart
      }
      result.push({ type, text: line, oldNum: null, newNum: null })
    } else if (type === 'added') {
      result.push({ type, text: line, oldNum: null, newNum: newNum++ })
    } else if (type === 'removed') {
      result.push({ type, text: line, oldNum: oldNum++, newNum: null })
    } else {
      result.push({ type, text: line, oldNum: oldNum++, newNum: newNum++ })
    }
  }

  return result
}

const lineStyles: Record<LineType, { background: string; color: string }> = {
  fileHeader: { background: alpha('ink', 0.07), color: solid('textMuted') },
  hunk: { background: alpha('accent', 0.1), color: solid('accent') },
  added: { background: alpha('successStrong', 0.12), color: solid('successStrong') },
  removed: { background: alpha('danger', 0.1), color: solid('dangerStrong') },
  context: { background: 'transparent', color: solid('textSecondary') }
}

const gutterColor = solid('textPlaceholder')
const gutterBorderColor = alpha('ink', 0.08)

export function DiffBlock({ value }: DiffBlockProps): React.JSX.Element {
  const lines = parseDiffLines(value)

  return (
    <div
      className="message-selectable overflow-auto rounded-md"
      style={{
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: '10.5px',
        lineHeight: 1.5,
        maxHeight: '160px',
        border: `1px solid ${alpha('ink', 0.1)}`
      }}
    >
      {lines.map((line, i) => {
        const { background, color } = lineStyles[line.type]
        const showNums = line.type !== 'fileHeader' && line.type !== 'hunk'
        return (
          <div key={i} style={{ background, color, display: 'flex' }}>
            <span
              style={{
                color: gutterColor,
                borderRight: `1px solid ${gutterBorderColor}`,
                minWidth: '3.2em',
                paddingLeft: '6px',
                paddingRight: '4px',
                textAlign: 'right',
                userSelect: 'none',
                flexShrink: 0
              }}
            >
              {showNums && line.oldNum != null ? line.oldNum : ''}
            </span>
            <span
              style={{
                color: gutterColor,
                borderRight: `1px solid ${gutterBorderColor}`,
                minWidth: '3.2em',
                paddingLeft: '4px',
                paddingRight: '6px',
                textAlign: 'right',
                userSelect: 'none',
                flexShrink: 0
              }}
            >
              {showNums && line.newNum != null ? line.newNum : ''}
            </span>
            <span
              style={{
                paddingLeft: '10px',
                paddingRight: '12px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                flex: 1
              }}
            >
              {line.text || ' '}
            </span>
          </div>
        )
      })}
    </div>
  )
}
