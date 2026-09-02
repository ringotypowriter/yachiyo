import type React from 'react'

import { theme } from '@renderer/theme/theme'
import {
  getToolCallDetailBlocks,
  type ToolCallDetailsPresentation
} from '../lib/tool-calls/toolCallPresentation.ts'
import { isValidJson } from '../lib/jsonTree/isValidJson.ts'
import { JsonTreeView } from './JsonTreeView.tsx'
import { ToolCodeBlock } from './ToolCodeBlock.tsx'

interface ToolCallDetailsPanelProps {
  presentation: ToolCallDetailsPresentation
  id?: string
  className?: string
  nested?: boolean
}

export function ToolCallDetailsPanel({
  presentation,
  id,
  className = '',
  nested = false
}: ToolCallDetailsPanelProps): React.JSX.Element | null {
  const detailBlocks = getToolCallDetailBlocks(presentation)
  if (detailBlocks.length === 0) return null

  return (
    <div
      id={id}
      className={`flex flex-col gap-1.5 border-l pl-3 ${nested ? 'pr-0' : 'pr-6'} yachiyo-detail-reveal ${className}`}
      style={{ borderColor: theme.border.panel }}
    >
      {detailBlocks.map((block) => (
        <div key={`${block.label}:${block.value.slice(0, 32)}`}>
          <div
            style={{
              color: block.tone === 'danger' ? theme.text.danger : theme.text.placeholder,
              fontSize: '10px',
              letterSpacing: '0.04em',
              marginBottom: '4px',
              textTransform: 'uppercase'
            }}
          >
            {block.label}
          </div>
          {block.label.startsWith('diff') ? (
            <ToolCodeBlock value={block.value} filePath={block.filePath} variant="diff" />
          ) : block.language && block.tone !== 'danger' ? (
            <ToolCodeBlock
              value={block.value}
              filePath={block.filePath}
              language={block.language}
            />
          ) : isValidJson(block.value) && block.tone !== 'danger' ? (
            <JsonTreeView value={block.value} />
          ) : (
            <pre
              className="message-selectable overflow-auto rounded-md px-3 py-2"
              style={{
                background:
                  block.tone === 'danger'
                    ? theme.background.dangerSoft
                    : theme.background.codeBlock,
                border: block.tone === 'danger' ? 'none' : `1px solid ${theme.border.default}`,
                color: block.tone === 'danger' ? theme.text.dangerStrong : theme.text.secondary,
                fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
                fontSize: '10.5px',
                lineHeight: 1.5,
                margin: 0,
                maxHeight: '160px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {block.value}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}
