import { theme, alpha } from '@renderer/theme/theme'

export function inputStyle(): React.CSSProperties {
  return {
    background: alpha('ink', 0.04),
    border: 'none',
    color: theme.text.primary
  }
}

export function settingsPanelStyle(): React.CSSProperties {
  return {
    background: theme.background.surface,
    border: `1px solid ${theme.border.panel}`,
    boxShadow: theme.shadow.panel
  }
}

export function compactChoiceStyle(selected: boolean): React.CSSProperties {
  return {
    background: selected ? theme.background.surfaceFrosted : theme.background.surfaceMuted,
    border: selected ? `1px solid ${theme.border.accent}` : `1px solid ${theme.border.panel}`,
    boxShadow: selected ? theme.shadow.raised : 'none'
  }
}

export function radioIndicatorStyle(selected: boolean): React.CSSProperties {
  return {
    border: selected ? `5px solid ${theme.text.accent}` : `1px solid ${theme.border.input}`,
    background: theme.text.inverse
  }
}
