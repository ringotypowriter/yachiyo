import { useMemo } from 'react'
import type React from 'react'
import { Streamdown } from 'streamdown'
import { theme } from '@renderer/theme/theme'
import { useHeavyMarkdownPlugins } from '@renderer/lib/markdown/heavyMarkdownPlugins'

interface HandoffSummaryRowProps {
  content: string
}

export function HandoffSummaryRow({ content }: HandoffSummaryRowProps): React.JSX.Element {
  const heavyPlugins = useHeavyMarkdownPlugins(content)
  const plugins = useMemo(
    () => (heavyPlugins ? { math: heavyPlugins.math, code: heavyPlugins.code } : {}),
    [heavyPlugins]
  )

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
