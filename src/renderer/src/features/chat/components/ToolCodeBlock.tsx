import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, SquareArrowOutUpRight } from 'lucide-react'
import { alpha, solid } from '@renderer/theme/theme'
import { code as codePlugin } from '@streamdown/code'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { detectLanguage } from '../lib/detectLanguage'

interface ToolCodeBlockProps {
  value: string
  filePath?: string
  variant?: 'diff' | 'preview'
  /** When true, remove the max-height cap so the block fills its parent. */
  fillHeight?: boolean
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface HighlightToken {
  content: string
  color?: string
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

type DiffLineType = 'hunk' | 'added' | 'removed' | 'context'

interface DiffLine {
  type: DiffLineType
  text: string
  lineNum: number | null
}

function classifyLine(line: string): DiffLineType | 'fileHeader' {
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

function parseDiffLines(raw: string): DiffLine[] {
  const lines = raw.split('\n')
  const result: DiffLine[] = []
  let oldNum = 0
  let newNum = 0

  for (const line of lines) {
    const type = classifyLine(line)
    if (type === 'fileHeader') continue
    if (type === 'hunk') {
      const hunk = parseHunkHeader(line)
      if (hunk) {
        oldNum = hunk.oldStart
        newNum = hunk.newStart
      }
      result.push({ type, text: line, lineNum: null })
    } else if (type === 'added') {
      result.push({ type, text: line, lineNum: newNum++ })
    } else if (type === 'removed') {
      result.push({ type, text: line, lineNum: oldNum++ })
    } else {
      result.push({ type, text: line, lineNum: newNum })
      oldNum++
      newNum++
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Highlighting hook
// ---------------------------------------------------------------------------

function useHighlight(
  code: string,
  filePath: string | undefined
): (HighlightToken[] | null)[] | null {
  const [tokensByLine, setTokensByLine] = useState<(HighlightToken[] | null)[] | null>(null)

  useEffect(() => {
    const lang = detectLanguage(filePath)
    if (!lang) return

    codePlugin.highlight({ code, language: lang, themes: codePlugin.getThemes() }, (result) => {
      setTokensByLine(
        result.tokens.map((lineTokens) =>
          lineTokens.map((t) => ({
            content: t.content,
            color: (t.htmlStyle as Record<string, string> | undefined)?.color
          }))
        )
      )
    })
  }, [code, filePath])

  return tokensByLine
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const accentBar: Record<'added' | 'removed', string> = {
  added: solid('successStrong'),
  removed: solid('dangerStrong')
}

const diffBg: Record<DiffLineType, string> = {
  hunk: 'transparent',
  added: alpha('successStrong', 0.07),
  removed: alpha('danger', 0.06),
  context: 'transparent'
}

const gutterColor = alpha('ink', 0.25)

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderTokens(tokens: HighlightToken[]): React.JSX.Element[] {
  return tokens.map((token, i) => (
    <span key={i} style={{ color: token.color }}>
      {token.content}
    </span>
  ))
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ToolCodeBlock({
  value,
  filePath,
  variant = 'preview',
  fillHeight = false
}: ToolCodeBlockProps): React.JSX.Element {
  if (variant === 'diff')
    return <DiffView value={value} filePath={filePath} fillHeight={fillHeight} />
  return <PreviewView value={value} filePath={filePath} />
}

// ---------------------------------------------------------------------------
// Preview variant
// ---------------------------------------------------------------------------

function PreviewView({ value, filePath }: { value: string; filePath?: string }): React.JSX.Element {
  const lines = value.split('\n')
  const tokensByLine = useHighlight(value, filePath)

  return (
    <Container maxHeight="320px" filePath={filePath}>
      {lines.map((line, i) => (
        <div key={i} style={{ display: 'flex', borderLeft: '2px solid transparent' }}>
          <Gutter>{i + 1}</Gutter>
          <Code color={solid('textSecondary')}>
            {tokensByLine?.[i] ? renderTokens(tokensByLine[i]) : line || ' '}
          </Code>
        </div>
      ))}
    </Container>
  )
}

// ---------------------------------------------------------------------------
// Diff variant
// ---------------------------------------------------------------------------

function DiffView({
  value,
  filePath,
  fillHeight = false
}: {
  value: string
  filePath?: string
  fillHeight?: boolean
}): React.JSX.Element {
  const diffLines = parseDiffLines(value)

  // Build the stripped code for highlighting (only content lines)
  const contentIndices: number[] = []
  const codeLines: string[] = []
  for (let i = 0; i < diffLines.length; i++) {
    const t = diffLines[i].type
    if (t === 'added' || t === 'removed' || t === 'context') {
      contentIndices.push(i)
      codeLines.push(diffLines[i].text.slice(1))
    }
  }

  const allTokens = useHighlight(codeLines.join('\n'), filePath)

  // Map tokens back to diff line indices
  const tokensByDiffLine: (HighlightToken[] | null)[] = new Array(diffLines.length).fill(null)
  if (allTokens) {
    for (let j = 0; j < contentIndices.length; j++) {
      tokensByDiffLine[contentIndices[j]] = allTokens[j]
    }
  }

  // Skip leading hunk separator
  const startIdx = diffLines[0]?.type === 'hunk' ? 1 : 0

  return (
    <Container maxHeight={fillHeight ? 'none' : '200px'} filePath={filePath}>
      {diffLines.slice(startIdx).map((line, i) => {
        if (line.type === 'hunk') {
          return (
            <div key={i} style={{ height: 1, background: alpha('ink', 0.08), margin: '2px 0' }} />
          )
        }

        const isChange = line.type === 'added' || line.type === 'removed'
        const tokens = tokensByDiffLine[startIdx + i]
        const fallbackColor = isChange ? accentBar[line.type] : solid('textSecondary')

        return (
          <div
            key={i}
            style={{
              display: 'flex',
              background: diffBg[line.type],
              borderLeft: isChange ? `2px solid ${accentBar[line.type]}` : '2px solid transparent'
            }}
          >
            <Gutter>{line.lineNum != null ? line.lineNum : ''}</Gutter>
            <Code color={fallbackColor}>
              {tokens ? renderTokens(tokens) : line.text.slice(1) || ' '}
            </Code>
          </div>
        )
      })}
    </Container>
  )
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Container({
  maxHeight,
  filePath,
  children
}: {
  maxHeight: string
  filePath?: string
  children: React.ReactNode
}): React.JSX.Element {
  const editorApp = useAppStore((s) => s.config?.workspace?.editorApp)
  const markdownApp = useAppStore((s) => s.config?.workspace?.markdownApp)

  const handleReveal = useCallback(() => {
    if (filePath) window.api.yachiyo.revealFile({ path: filePath })
  }, [filePath])

  const handleOpenInEditor = useCallback(async () => {
    if (!filePath) return
    const isMd = filePath.toLowerCase().endsWith('.md')
    const app = isMd ? markdownApp || editorApp : editorApp
    if (!app) return
    try {
      await window.api.yachiyo.openFileInEditor({ path: filePath, editorApp: app })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to open in editor.')
    }
  }, [filePath, editorApp, markdownApp])

  const hasActions = !!filePath

  return (
    <div className="group/code relative">
      <div
        className="message-selectable overflow-auto rounded-lg"
        style={{
          fontFamily: "'SF Mono', ui-monospace, Menlo, monospace",
          fontSize: '11px',
          lineHeight: '18px',
          maxHeight,
          background: alpha('ink', 0.02)
        }}
      >
        {children}
      </div>
      {hasActions && (
        <div
          className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover/code:opacity-100 transition-opacity"
          style={{ zIndex: 1 }}
        >
          <ActionButton title="Reveal in Finder" onClick={handleReveal}>
            <FolderOpen size={12} strokeWidth={1.5} />
          </ActionButton>
          {(() => {
            const isMd = filePath?.toLowerCase().endsWith('.md') ?? false
            const app = isMd ? markdownApp || editorApp : editorApp
            return app ? (
              <ActionButton title={`Open in ${app}`} onClick={handleOpenInEditor}>
                <SquareArrowOutUpRight size={12} strokeWidth={1.5} />
              </ActionButton>
            ) : null
          })()}
        </div>
      )}
    </div>
  )
}

function ActionButton({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="rounded-md p-1 transition-colors"
      style={{
        color: solid('textMuted'),
        background: alpha('ink', 0.06)
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = alpha('ink', 0.12)
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = alpha('ink', 0.06)
      }}
    >
      {children}
    </button>
  )
}

function Gutter({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      style={{
        color: gutterColor,
        minWidth: '2.8em',
        paddingRight: '8px',
        textAlign: 'right',
        userSelect: 'none',
        flexShrink: 0,
        fontSize: '10px',
        lineHeight: '18px'
      }}
    >
      {children}
    </span>
  )
}

function Code({
  color,
  children
}: {
  color: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      style={{
        paddingRight: '12px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        flex: 1,
        color
      }}
    >
      {children}
    </span>
  )
}
