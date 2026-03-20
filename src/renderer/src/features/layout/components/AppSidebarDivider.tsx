export interface AppSidebarDividerProps {
  offset: number | null
}

export function AppSidebarDivider({ offset }: AppSidebarDividerProps): React.JSX.Element | null {
  if (offset === null) {
    return null
  }

  return (
    <div
      style={{
        width: '1px',
        background: 'rgba(0,0,0,0.08)',
        position: 'absolute',
        left: `${offset}px`,
        top: 0,
        bottom: 0,
        zIndex: 1
      }}
    />
  )
}
