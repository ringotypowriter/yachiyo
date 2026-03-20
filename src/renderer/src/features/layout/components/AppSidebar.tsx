import { PanelLeft, Search, Settings, SquarePen } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ThreadList } from '@renderer/features/threads/components/ThreadList'
import { TRAFFIC_LIGHTS_SAFE_ZONE } from '@renderer/lib/sidebarLayout'

export interface AppSidebarProps {
  isOpen: boolean
  isToggleDisabled: boolean
  onToggle: () => void
  sidebarWidth: number
  toggleTitle: string
}

export function AppSidebar({
  isOpen,
  isToggleDisabled,
  onToggle,
  sidebarWidth,
  toggleTitle
}: AppSidebarProps): React.JSX.Element {
  const createNewThread = useAppStore((s) => s.createNewThread)

  return (
    <div
      aria-hidden={!isOpen}
      className="flex flex-col h-full shrink-0 overflow-hidden transition-all duration-200"
      style={{
        width: sidebarWidth,
        background: '#F0EFEB',
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? 'auto' : 'none'
      }}
    >
      <div
        className="flex items-center drag-region shrink-0"
        style={{
          height: '52px',
          paddingLeft: `${TRAFFIC_LIGHTS_SAFE_ZONE}px`,
          paddingRight: '12px'
        }}
      >
        <div className="flex items-center gap-1 no-drag ml-auto">
          <button
            disabled={isToggleDisabled}
            onClick={onToggle}
            className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity disabled:opacity-30"
            style={{ color: '#2D2D2B' }}
            title={toggleTitle}
            aria-label={toggleTitle}
          >
            <PanelLeft size={16} strokeWidth={1.5} />
          </button>
          <button
            className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity"
            style={{ color: '#2D2D2B' }}
          >
            <Search size={15} strokeWidth={1.5} />
          </button>
          <button
            onClick={createNewThread}
            className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity"
            style={{ color: '#2D2D2B' }}
            title="New chat"
          >
            <SquarePen size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <ThreadList />

      <div className="shrink-0 px-3 py-3 no-drag">
        <button
          onClick={() => window.api.openSettings()}
          className="p-1.5 rounded-md opacity-40 hover:opacity-70 transition-opacity"
          style={{ color: '#2D2D2B' }}
        >
          <Settings size={16} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
