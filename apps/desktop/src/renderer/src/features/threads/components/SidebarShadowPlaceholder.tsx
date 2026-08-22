import { ChevronDown, ListFilter } from 'lucide-react'
import { theme } from '@renderer/theme/theme'

interface SidebarShadowPlaceholderProps {
  icon?: React.ReactNode
  titleAccessory?: React.ReactNode
  trailing?: React.ReactNode
  variant: 'filter' | 'folder' | 'label' | 'thread'
  showPreview?: boolean
}

const shadowStyle = {
  background: theme.background.code,
  boxShadow: theme.shadow.button
}

export function SidebarShadowPlaceholder({
  icon,
  titleAccessory,
  trailing,
  variant,
  showPreview = false
}: SidebarShadowPlaceholderProps): React.JSX.Element {
  if (variant === 'filter') {
    return (
      <div aria-hidden="true" className="flex h-5 items-center gap-1.5 px-2.5">
        <ListFilter className="shrink-0" size={13} strokeWidth={1.8} />
        <span className="h-2.5 w-16 rounded-full" style={{ ...shadowStyle, opacity: 0.7 }} />
        <ChevronDown className="shrink-0" size={10} strokeWidth={2} />
      </div>
    )
  }

  if (variant === 'label') {
    return (
      <div aria-hidden="true" className="flex h-5 items-center px-2">
        <span className="h-2.5 w-16 rounded-full" style={{ ...shadowStyle, opacity: 0.7 }} />
      </div>
    )
  }

  if (variant === 'folder') {
    return (
      <div aria-hidden="true" className="flex h-[38px] items-center gap-2 px-2.5">
        {icon}
        <span className="h-2.5 w-24 rounded-full" style={{ ...shadowStyle, opacity: 0.72 }} />
        <span
          className="ml-auto h-2 w-3.5 rounded-full"
          style={{ ...shadowStyle, opacity: 0.42 }}
        />
      </div>
    )
  }

  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-2.5 px-3"
      style={{ height: showPreview ? 62 : 38 }}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className="block h-2.5 w-[56%] rounded-full"
            style={{ ...shadowStyle, opacity: 0.72 }}
          />
          {titleAccessory}
        </div>
        {showPreview ? (
          <span
            className="mt-2 block h-1.5 w-[78%] rounded-full"
            style={{ ...shadowStyle, opacity: 0.4 }}
          />
        ) : null}
      </div>
      {trailing}
    </div>
  )
}
