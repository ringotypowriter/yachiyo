import type React from 'react'
import { useMemo, useState } from 'react'
import { alpha, solid } from '@renderer/theme/theme'
import { codeHighlightTokenStyle } from '../lib/code-blocks/codeHighlightTheme.ts'
import type { HighlightToken } from '../lib/code-blocks/highlightTokens.ts'
import { useCodeHighlightTokens } from '../lib/code-blocks/useCodeHighlightTokens.ts'
import { tryParseJson } from '../lib/jsonTree/isValidJson.ts'

interface JsonTreeViewProps {
  value: string
  maxHeight?: string
}

interface LineSegment {
  indent: number
  tokens: HighlightToken[]
  isCollapsibleOpen?: boolean
  isCollapsibleClose?: boolean
}

function lineIndent(line: HighlightToken[]): number {
  if (line.length === 0) return 0
  const first = line[0]
  if (!first) return 0
  const match = /^\s*/.exec(first.content)
  return match ? match[0].length / 2 : 0
}

function isOpenBracket(line: HighlightToken[]): boolean {
  if (line.length !== 1) return false
  const first = line[0]
  if (!first) return false
  const content = first.content
  // Only match pure bracket lines with no leading whitespace,
  // otherwise nested inline brackets like `  "key": {` or `  {` confuse matching.
  if (/^\s/.test(content)) return false
  return content === '{' || content === '['
}

function isCloseBracket(line: HighlightToken[], openChar: string): boolean {
  if (line.length !== 1) return false
  const first = line[0]
  if (!first) return false
  const content = first.content
  // Only match pure bracket lines with no leading whitespace.
  if (/^\s/.test(content)) return false
  const expected = openChar === '{' ? '}' : openChar === '[' ? ']' : undefined
  return content === expected
}

function findMatchingClosingLine(lines: HighlightToken[][], openIndex: number): number {
  const openToken = lines[openIndex]?.[0]
  if (!openToken) return openIndex
  const openChar = openToken.content.trim()
  if (openChar !== '{' && openChar !== '[') return openIndex

  let depth = 0
  for (let i = openIndex; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (isOpenBracket(line)) depth++
    if (isCloseBracket(line, openChar)) {
      depth--
      if (depth === 0) return i
    }
  }
  return openIndex
}

function buildSegments(lines: HighlightToken[][]): LineSegment[] {
  const segments: LineSegment[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line || line.length === 0) {
      segments.push({ indent: 0, tokens: [] })
      index++
      continue
    }

    const indent = lineIndent(line)

    if (isOpenBracket(line)) {
      const closeLine = findMatchingClosingLine(lines, index)
      if (closeLine > index) {
        segments.push({
          indent,
          tokens: line,
          isCollapsibleOpen: true
        })
        // Push all content lines between open and close as body segments
        for (let i = index + 1; i < closeLine; i++) {
          const contentLine = lines[i]
          if (!contentLine || contentLine.length === 0) {
            segments.push({ indent: indent + 1, tokens: [] })
          } else {
            segments.push({ indent: lineIndent(contentLine), tokens: contentLine })
          }
        }
        segments.push({
          indent,
          tokens: lines[closeLine] ?? [],
          isCollapsibleClose: true
        })
        index = closeLine + 1
        continue
      }
    }

    segments.push({ indent, tokens: line })
    index++
  }
  return segments
}

function renderTokens(tokens: HighlightToken[]): React.ReactNode {
  return tokens.map((token, i) => (
    <span
      key={i}
      className="yachiyo-code-token"
      style={codeHighlightTokenStyle(token) as React.CSSProperties | undefined}
    >
      {token.content}
    </span>
  ))
}

function CollapsibleBlock({
  open,
  close,
  children,
  collapsedByDefault
}: {
  open: React.ReactNode
  close: React.ReactNode
  children: React.ReactNode
  collapsedByDefault: boolean
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(collapsedByDefault)

  return (
    <>
      <div
        onClick={() => setCollapsed((v) => !v)}
        style={{
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          color: solid('textPlaceholder'),
          userSelect: 'none'
        }}
      >
        <span
          style={{
            display: 'inline-block',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 0.1s ease',
            fontSize: '9px'
          }}
        >
          ▼
        </span>
        {open}
        {collapsed ? (
          <span style={{ color: solid('textMuted'), fontSize: '10px', marginLeft: 4 }}>…</span>
        ) : null}
      </div>
      {!collapsed && children}
      <div onClick={() => setCollapsed((v) => !v)} style={{ cursor: 'pointer' }}>
        {close}
      </div>
    </>
  )
}

export function JsonTreeView({
  value,
  maxHeight = '240px'
}: JsonTreeViewProps): React.JSX.Element | null {
  const parsed = useMemo(() => tryParseJson(value), [value])
  const tokensByLine = useCodeHighlightTokens(value, 'json')

  if (parsed === undefined || !tokensByLine) {
    return (
      <pre
        className="message-selectable overflow-auto rounded-md px-3 py-2"
        style={{
          background: alpha('ink', 0.02),
          fontFamily: "'SF Mono', ui-monospace, Menlo, monospace",
          fontSize: '11px',
          lineHeight: '18px',
          maxHeight,
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {value}
      </pre>
    )
  }

  const segments = buildSegments(tokensByLine)
  const rendered: React.ReactNode[] = []
  let index = 0

  while (index < segments.length) {
    const segment = segments[index]
    if (segment.isCollapsibleOpen && index + 1 < segments.length) {
      const openLine = segment.tokens
      const body: React.ReactNode[] = []
      let bodyIndex = index + 1
      while (
        bodyIndex < segments.length &&
        segments[bodyIndex].indent > segment.indent &&
        !segments[bodyIndex].isCollapsibleClose
      ) {
        body.push(
          <div
            key={bodyIndex}
            style={{
              paddingLeft: (segments[bodyIndex].indent - segment.indent) * 12
            }}
          >
            {renderTokens(segments[bodyIndex].tokens)}
          </div>
        )
        bodyIndex++
      }
      const closeSegment = segments[bodyIndex]
      rendered.push(
        <div key={index} style={{ paddingLeft: segment.indent * 12 }}>
          <CollapsibleBlock
            open={renderTokens(openLine)}
            close={
              <span style={{ color: solid('textPlaceholder') }}>
                {closeSegment ? renderTokens(closeSegment.tokens) : ''}
              </span>
            }
            collapsedByDefault={segment.indent >= 1}
          >
            {body}
          </CollapsibleBlock>
        </div>
      )
      index = bodyIndex + 1
    } else {
      rendered.push(
        <div key={index} style={{ paddingLeft: segment.indent * 12 }}>
          {renderTokens(segment.tokens)}
        </div>
      )
      index++
    }
  }

  return (
    <div
      className="message-selectable overflow-auto rounded-lg px-2 py-1.5"
      style={{
        fontFamily: "'SF Mono', ui-monospace, Menlo, monospace",
        fontSize: '11px',
        lineHeight: '18px',
        maxHeight,
        background: alpha('ink', 0.02)
      }}
    >
      {rendered}
    </div>
  )
}
