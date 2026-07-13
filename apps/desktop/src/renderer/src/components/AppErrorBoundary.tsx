import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '@yachiyo/i18n/index'
import { theme } from '@renderer/theme/theme'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

/**
 * Last-resort boundary wrapping each window's whole React tree. Without it an
 * uncaught render error unmounts everything into a silent white window.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught render error', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children
    }
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          textAlign: 'center'
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: theme.text.primary }}>
          {t('shell.rendererError.title')}
        </span>
        <span style={{ fontSize: 12.5, color: theme.text.muted, maxWidth: 420 }}>
          {t('shell.rendererError.description')}
        </span>
        <code
          style={{
            fontSize: 11,
            color: theme.text.tertiary,
            maxWidth: 480,
            overflowWrap: 'anywhere'
          }}
        >
          {this.state.error.message}
        </code>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 8,
            padding: '7px 16px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
            background: theme.background.accentFill,
            color: theme.text.onAccentFill
          }}
        >
          {t('shell.rendererError.reload')}
        </button>
      </div>
    )
  }
}
