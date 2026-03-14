import React, { Component, type ReactNode } from 'react'

interface Props {
  fallback: string
  children: ReactNode
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
          className="text-sm leading-relaxed whitespace-pre-wrap message-selectable"
          style={{ color: '#1c1c1e' }}
        >
          {this.props.fallback}
        </p>
      )
    }
    return this.props.children
  }
}
