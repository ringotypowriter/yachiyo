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
        className="border-l py-0.5 pl-3"
        style={{
          borderColor: theme.border.panel,
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
