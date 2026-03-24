import { useState } from 'react'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { theme } from '@renderer/theme/theme'
import { settingsPanelStyle } from '../components/styles'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY
} from '@renderer/lib/sidebarLayout'

const UI_FONT_SIZES = [11, 12, 13, 14, 15, 16]
const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20]
const DEFAULT_UI_FONT_SIZE = 14
const DEFAULT_CHAT_FONT_SIZE = 14

interface UIPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
  subTab: string
}

function FontSizeRow({
  label,
  description,
  value,
  steps,
  defaultValue,
  onChange
}: {
  label: string
  description: string
  value: number | undefined
  steps: number[]
  defaultValue: number
  onChange: (next: number) => void
}): React.ReactNode {
  const current = value ?? defaultValue
  const currentIndex = steps.indexOf(current)
  const canDecrease = currentIndex > 0
  const canIncrease = currentIndex < steps.length - 1

  return (
    <div
      className="flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
      style={{
        background: theme.background.surfaceLight,
        border: `1px solid ${theme.border.default}`
      }}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
          {label}
        </div>
        <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
          {description}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={!canDecrease}
          onClick={() => canDecrease && onChange(steps[currentIndex - 1])}
          className="flex items-center justify-center rounded-lg text-sm font-medium transition-opacity disabled:opacity-30"
          style={{
            width: 28,
            height: 28,
            background: theme.background.surface,
            border: `1px solid ${theme.border.default}`,
            color: theme.text.primary
          }}
          aria-label={`Decrease ${label.toLowerCase()}`}
        >
          −
        </button>
        <span
          className="text-sm font-medium tabular-nums"
          style={{ minWidth: 36, textAlign: 'center', color: theme.text.primary }}
        >
          {current}px
        </span>
        <button
          type="button"
          disabled={!canIncrease}
          onClick={() => canIncrease && onChange(steps[currentIndex + 1])}
          className="flex items-center justify-center rounded-lg text-sm font-medium transition-opacity disabled:opacity-30"
          style={{
            width: 28,
            height: 28,
            background: theme.background.surface,
            border: `1px solid ${theme.border.default}`,
            color: theme.text.primary
          }}
          aria-label={`Increase ${label.toLowerCase()}`}
        >
          +
        </button>
      </div>
    </div>
  )
}

function ThemeSubTab({
  draft,
  onChange
}: {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}): React.ReactNode {
  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl">
        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: theme.text.muted }}
          >
            Text size
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <FontSizeRow
              label="Interface text"
              description="Applies to navigation, buttons, and labels."
              value={draft.general?.uiFontSize}
              steps={UI_FONT_SIZES}
              defaultValue={DEFAULT_UI_FONT_SIZE}
              onChange={(next) =>
                onChange({
                  ...draft,
                  general: { ...draft.general, uiFontSize: next }
                })
              }
            />
            <FontSizeRow
              label="Chat text"
              description="Applies to message content in conversations."
              value={draft.general?.chatFontSize}
              steps={CHAT_FONT_SIZES}
              defaultValue={DEFAULT_CHAT_FONT_SIZE}
              onChange={(next) =>
                onChange({
                  ...draft,
                  general: { ...draft.general, chatFontSize: next }
                })
              }
            />
          </div>
        </section>
      </div>
    </div>
  )
}

function LayoutSubTab(): React.ReactNode {
  const [sidebarWidth, setSidebarWidthState] = useState<number>(
    () =>
      parseInt(globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? '', 10) ||
      DEFAULT_SIDEBAR_WIDTH
  )

  const handleChange = (next: number): void => {
    setSidebarWidthState(next)
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next))
    // Broadcast to main window via storage event (cross-window sync)
    window.dispatchEvent(
      new StorageEvent('storage', { key: SIDEBAR_WIDTH_STORAGE_KEY, newValue: String(next) })
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl">
        <section className="rounded-[28px] px-5 py-5" style={settingsPanelStyle()}>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: theme.text.muted }}
          >
            Sidebar
          </div>

          <div
            className="mt-3 flex items-center justify-between gap-4 rounded-2xl px-4 py-3"
            style={{
              background: theme.background.surfaceLight,
              border: `1px solid ${theme.border.default}`
            }}
          >
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                Sidebar width
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                Drag the sidebar edge in the main window, or set a precise value here.
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <input
                type="range"
                min={MIN_SIDEBAR_WIDTH}
                max={MAX_SIDEBAR_WIDTH}
                step={10}
                value={sidebarWidth}
                onChange={(e) => handleChange(parseInt(e.target.value, 10))}
                className="w-28"
                aria-label="Sidebar width"
              />
              <span
                className="text-sm font-medium tabular-nums"
                style={{ minWidth: 44, textAlign: 'right', color: theme.text.primary }}
              >
                {sidebarWidth}px
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

export function UIPane({ draft, onChange, subTab }: UIPaneProps): React.ReactNode {
  if (subTab === 'theme') {
    return <ThemeSubTab draft={draft} onChange={onChange} />
  }

  if (subTab === 'layout') {
    return <LayoutSubTab />
  }

  return null
}
