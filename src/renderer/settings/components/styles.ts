export function inputStyle(): React.CSSProperties {
  return {
    background: 'rgba(255,255,255,0.76)',
    border: '1px solid rgba(0,0,0,0.12)',
    color: '#2D2D2B'
  }
}

export function settingsPanelStyle(): React.CSSProperties {
  return {
    background: 'rgba(255,255,255,0.68)',
    border: '1px solid rgba(0,0,0,0.08)',
    boxShadow: '0 10px 30px rgba(0,0,0,0.04)'
  }
}

export function compactChoiceStyle(selected: boolean): React.CSSProperties {
  return {
    background: selected ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.56)',
    border: selected ? '1px solid rgba(204,125,94,0.28)' : '1px solid rgba(0,0,0,0.08)',
    boxShadow: selected ? '0 8px 22px rgba(0,0,0,0.06)' : 'none'
  }
}

export function radioIndicatorStyle(selected: boolean): React.CSSProperties {
  return {
    border: selected ? '5px solid #CC7D5E' : '1px solid rgba(0,0,0,0.18)',
    background: '#fff'
  }
}
