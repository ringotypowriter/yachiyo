export interface AppSidebarDividerProps {
  offset: number | null
  onDragStart: (e: React.MouseEvent) => void
}

export function AppSidebarDivider({
  offset,
  onDragStart
}: AppSidebarDividerProps): React.JSX.Element | null {
  if (offset === null) {
    return null
  }

  return (
    <div
      onMouseDown={onDragStart}
      style={{
        position: 'absolute',
        left: `${offset - 4}px`,
        width: '8px',
        top: '52px',
        bottom: 0,
        zIndex: 1,
        cursor: 'col-resize'
      }}
    />
  )
}
