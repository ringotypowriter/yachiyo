import { useState } from 'react'
import { DEFAULT_SIDEBAR_VISIBILITY } from '../../../shared/yachiyo/protocol.ts'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { theme, alpha } from '@renderer/theme/theme'
import { SettingLabel, SettingRow, SettingSection, SettingSwitch } from '../components/primitives'
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
    <SettingRow>
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
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
          className="flex items-center justify-center text-sm font-medium transition-opacity disabled:opacity-25 opacity-50 hover:opacity-100"
          style={{
            width: 24,
            height: 24,
            background: 'none',
            border: 'none',
            color: theme.text.primary,
            cursor: 'pointer'
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
          className="flex items-center justify-center text-sm font-medium transition-opacity disabled:opacity-25 opacity-50 hover:opacity-100"
          style={{
            width: 24,
            height: 24,
            background: 'none',
            border: 'none',
            color: theme.text.primary,
            cursor: 'pointer'
          }}
          aria-label={`Increase ${label.toLowerCase()}`}
        >
          +
        </button>
      </div>
    </SettingRow>
  )
}

export function UIPane({ draft, onChange }: UIPaneProps): React.ReactNode {
  const [sidebarWidth, setSidebarWidthState] = useState<number>(
    () =>
      parseInt(globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? '', 10) ||
      DEFAULT_SIDEBAR_WIDTH
  )

  const handleSidebarWidth = (next: number): void => {
    setSidebarWidthState(next)
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next))
    window.dispatchEvent(
      new StorageEvent('storage', { key: SIDEBAR_WIDTH_STORAGE_KEY, newValue: String(next) })
    )
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>Text size</SettingLabel>

        <FontSizeRow
          label="Interface text"
          description="Applies to navigation, buttons, and labels."
          value={draft.general?.uiFontSize}
          steps={UI_FONT_SIZES}
          defaultValue={DEFAULT_UI_FONT_SIZE}
          onChange={(next) =>
            onChange({ ...draft, general: { ...draft.general, uiFontSize: next } })
          }
        />
        <FontSizeRow
          label="Chat text"
          description="Applies to message content in conversations."
          value={draft.general?.chatFontSize}
          steps={CHAT_FONT_SIZES}
          defaultValue={DEFAULT_CHAT_FONT_SIZE}
          onChange={(next) =>
            onChange({ ...draft, general: { ...draft.general, chatFontSize: next } })
          }
        />
      </SettingSection>

      <SettingSection>
        <SettingLabel>Layout</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Show sidebar on launch
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Off starts focused on the conversation.
            </div>
          </div>

          <div className="shrink-0">
            <SettingSwitch
              checked={
                (draft.general?.sidebarVisibility ?? DEFAULT_SIDEBAR_VISIBILITY) === 'expanded'
              }
              onChange={() => {
                const current = draft.general?.sidebarVisibility ?? DEFAULT_SIDEBAR_VISIBILITY
                onChange({
                  ...draft,
                  general: {
                    ...draft.general,
                    sidebarVisibility: current === 'expanded' ? 'collapsed' : 'expanded'
                  }
                })
              }}
              ariaLabel="Toggle sidebar visibility on launch"
            />
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Sidebar width
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Drag the sidebar edge in the main window, or set a precise value here.
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div style={{ position: 'relative', width: 112, height: 20 }}>
              {/* track */}
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: 0,
                  right: 0,
                  height: 3,
                  transform: 'translateY(-50%)',
                  borderRadius: 99,
                  background: alpha('ink', 0.08),
                  pointerEvents: 'none'
                }}
              />
              {/* fill */}
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: 0,
                  width: `${((sidebarWidth - MIN_SIDEBAR_WIDTH) / (MAX_SIDEBAR_WIDTH - MIN_SIDEBAR_WIDTH)) * 100}%`,
                  height: 3,
                  transform: 'translateY(-50%)',
                  borderRadius: 99,
                  background: theme.text.accent,
                  pointerEvents: 'none'
                }}
              />
              <input
                type="range"
                min={MIN_SIDEBAR_WIDTH}
                max={MAX_SIDEBAR_WIDTH}
                step={10}
                value={sidebarWidth}
                onChange={(e) => handleSidebarWidth(parseInt(e.target.value, 10))}
                aria-label="Sidebar width"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: 0,
                  cursor: 'pointer',
                  margin: 0
                }}
              />
            </div>
            <span
              className="text-sm font-medium tabular-nums"
              style={{ minWidth: 44, textAlign: 'right', color: theme.text.primary }}
            >
              {sidebarWidth}px
            </span>
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Show message preview
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Shows a preview line under each thread in the sidebar.
            </div>
          </div>

          <div className="shrink-0">
            <SettingSwitch
              checked={draft.general?.sidebarPreview !== false}
              onChange={() =>
                onChange({
                  ...draft,
                  general: {
                    ...draft.general,
                    sidebarPreview: draft.general?.sidebarPreview === false
                  }
                })
              }
              ariaLabel="Toggle message preview in sidebar"
            />
          </div>
        </SettingRow>
      </SettingSection>
    </div>
  )
}
