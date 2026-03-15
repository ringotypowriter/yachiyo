import type React from 'react'
import { Streamdown } from 'streamdown'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'

interface MessageMarkdownProps {
  content: string
  isStreaming?: boolean
}

export function MessageMarkdown({
  content,
  isStreaming = false
}: MessageMarkdownProps): React.JSX.Element {
  return (
    <MarkdownErrorBoundary fallback={content}>
      <div className="streamdown-content message-selectable">
        <Streamdown
          isAnimating={isStreaming}
          animated={isStreaming}
          caret={isStreaming ? 'circle' : undefined}
          mode={isStreaming ? 'streaming' : 'static'}
        >
          {content}
        </Streamdown>
      </div>
    </MarkdownErrorBoundary>
  )
}
