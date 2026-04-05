import type React from 'react'
import { useMemo } from 'react'
import type { Components, LinkSafetyConfig } from 'streamdown'
import { Streamdown } from 'streamdown'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'
import { LinkSafetyModal } from './LinkSafetyModal'
import { LinkableCode } from './LinkableCode'
import { mathPlugin } from './mathPlugin'

interface MessageMarkdownProps {
  content: string
  isStreaming?: boolean
}

export function MessageMarkdown({
  content,
  isStreaming = false
}: MessageMarkdownProps): React.JSX.Element {
  const linkSafety = useMemo<LinkSafetyConfig>(
    () => ({
      enabled: true,
      renderModal: (props) => <LinkSafetyModal {...props} />
    }),
    []
  )

  const components = useMemo<Components>(() => ({ inlineCode: LinkableCode }), [])

  return (
    <MarkdownErrorBoundary fallback={content}>
      <div className="streamdown-content message-selectable">
        <Streamdown
          isAnimating={isStreaming}
          animated={
            isStreaming
              ? { sep: 'char', animation: 'slideUp', duration: 120, easing: 'ease-out' }
              : false
          }
          caret={isStreaming ? 'circle' : undefined}
          mode={isStreaming ? 'streaming' : 'static'}
          controls={true}
          plugins={{ math: mathPlugin }}
          linkSafety={linkSafety}
          components={components}
        >
          {content}
        </Streamdown>
      </div>
    </MarkdownErrorBoundary>
  )
}
