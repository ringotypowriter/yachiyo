import React, { Component, type ReactNode } from 'react'
import { theme } from '@renderer/theme/theme'

interface Props {
  fallback: string
  children: ReactNode
  exportMode?: boolean
}

interface State {
  hasError: boolean
}

export class MarkdownErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <p
          data-share-error={this.props.exportMode ? 'Markdown could not be rendered.' : undefined}
          className="text-sm leading-relaxed whitespace-pre-wrap message-selectable"
          style={{ color: theme.text.primary }}
        >
          {this.props.fallback}
        </p>
      )
    }
    return this.props.children
  }
}
