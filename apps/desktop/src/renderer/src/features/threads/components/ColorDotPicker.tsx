import type React from 'react'
import { useState } from 'react'
import type { ThreadColorTag } from '@renderer/app/types'
import { THREAD_COLOR_VALUES } from '@renderer/features/threads/lib/threadColorPalette'
import { theme } from '@renderer/theme/theme'

export interface ColorDotPickerOption {
  active: boolean
  colorTag: ThreadColorTag | null
  disabled?: boolean
  label: string
  onSelect: () => void
}

export function ColorDotPicker({
  options,
  title = 'Color'
}: {
  options: ColorDotPickerOption[]
  title?: string
}): React.JSX.Element {
  const [hoveredOption, setHoveredOption] = useState<ColorDotPickerOption | null>(null)
  const activeOption = options.find((option) => option.active)
  const displayedOption = hoveredOption ?? activeOption
  const displayedLabel = displayedOption?.label ?? 'Default'
  const displayedColor = displayedOption?.colorTag
    ? THREAD_COLOR_VALUES[displayedOption.colorTag]
    : theme.text.primary

  return (
    <div className="px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span
          style={{
            color: theme.text.muted,
            fontSize: '0.68rem',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase'
          }}
        >
          {title}
        </span>
        <span
          className="min-w-0 truncate text-right"
          style={{
            color: displayedColor,
            fontSize: '0.78rem',
            fontWeight: 500
          }}
        >
          {displayedLabel}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {options.map((option) => (
          <button
            key={option.colorTag ?? 'default'}
            type="button"
            disabled={option.disabled}
            title={option.label}
            aria-label={`Mark it ${option.label}`}
            onMouseEnter={() => setHoveredOption(option)}
            onMouseLeave={() => setHoveredOption(null)}
            onClick={option.onSelect}
            className="flex items-center justify-center rounded-md transition-colors disabled:opacity-35"
            style={{
              width: 24,
              height: 24,
              background: option.active ? theme.background.hoverStrong : 'transparent'
            }}
          >
            <span
              className="rounded-full"
              style={{
                width: option.active ? 15 : 13,
                height: option.active ? 15 : 13,
                background: option.colorTag ? THREAD_COLOR_VALUES[option.colorTag] : 'transparent',
                border: option.colorTag ? 'none' : `1.5px solid ${theme.border.contrast}`,
                transition: 'width 0.12s ease, height 0.12s ease'
              }}
            />
          </button>
        ))}
      </div>
    </div>
  )
}
