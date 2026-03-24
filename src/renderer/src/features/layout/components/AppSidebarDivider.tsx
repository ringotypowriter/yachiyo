import { theme } from '@renderer/theme/theme'

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
      style={{
        width: '1px',
        background: theme.border.panel,
        position: 'absolute',
        left: `${offset}px`,
        top: 0,
        bottom: 0,
        zIndex: 1
      }}
    >
      {/* Wider invisible hit area, starts below title bar to avoid blocking window drag */}
      <div
        onMouseDown={onDragStart}
        style={{
          position: 'absolute',
          left: '-4px',
          right: '-4px',
          top: '52px',
          bottom: 0,
          cursor: 'col-resize'
        }}
      />
    </div>
  )
}
