import { useMemo } from 'react'
import type React from 'react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { theme } from '@renderer/theme/theme'
import { mathPlugin } from '@renderer/lib/markdown/mathPlugin'

interface HandoffSummaryRowProps {
  content: string
}

export function HandoffSummaryRow({ content }: HandoffSummaryRowProps): React.JSX.Element {
  const plugins = useMemo(() => ({ math: mathPlugin, code }), [])

  return (
    <div className="handoff-fold-summary message-selectable">
      <div
        className="px-3 py-2"
        style={{
          background: theme.background.surfaceSoft,
          borderLeft: `2px solid ${theme.border.accent}`,
          borderRadius: '0 8px 8px 0',
          color: theme.text.secondary,
          fontSize: '12px',
          lineHeight: 1.55
        }}
      >
        <Streamdown mode="static" controls={true} plugins={plugins}>
          {content}
        </Streamdown>
      </div>
    </div>
  )
}
