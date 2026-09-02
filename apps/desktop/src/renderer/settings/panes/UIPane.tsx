import {
  DEFAULT_SIDEBAR_VISIBILITY,
  DEFAULT_TOOL_CALL_DISPLAY_MODE,
  DEFAULT_THEME_APPEARANCE,
  DEFAULT_THEME_ID
} from '@yachiyo/shared/protocol'
import type {
  AppLanguage,
  SettingsConfig,
  ThemeAppearance,
  ToolCallDisplayMode,
  ThemeId
} from '@yachiyo/shared/protocol'
import { useT } from '@yachiyo/i18n/react'
import { THEME_OPTIONS, alpha, getThemeSchemePreviewSegments, theme } from '@renderer/theme/theme'
import {
  SettingItem,
  SettingLabel,
  SettingSection,
  SettingSwitch,
  SimpleSelect
} from '../components/primitives'

const UI_FONT_SIZES = [11, 12, 13, 14, 15, 16]
const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20]
const DEFAULT_UI_FONT_SIZE = 14
const DEFAULT_CHAT_FONT_SIZE = 14
const DEFAULT_CHAT_PANEL_OPACITY = 0.92
const MIN_CHAT_PANEL_OPACITY_PERCENT = 20

interface UIPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

function ThemeStripe({ themeId }: { themeId: ThemeId }): React.ReactNode {
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        width: 104,
        height: 4,
        overflow: 'hidden',
        borderRadius: 999,
        background: theme.border.subtle
      }}
    >
      {getThemeSchemePreviewSegments(themeId).map((segment) => (
        <span
          key={`${segment.variant}-${segment.token}`}
          style={{
            flex: `${segment.weight} 0 0px`,
            background: `rgb(${segment.rgb})`
          }}
        />
      ))}
    </div>
  )
}

const THEME_SELECT_OPTIONS = THEME_OPTIONS.map((option) => ({
  value: option.id,
  label: option.label,
  preview: <ThemeStripe themeId={option.id} />
}))

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
  const t = useT()
  const current = value ?? defaultValue
  const currentIndex = steps.indexOf(current)
  const canDecrease = currentIndex > 0
  const canIncrease = currentIndex < steps.length - 1

  return (
    <SettingItem
      label={label}
      description={description}
      control={
        <div className="flex items-center gap-2">
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
              cursor: 'default'
            }}
            aria-label={t('settings.ui.decreaseAria', { label })}
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
              cursor: 'default'
            }}
            aria-label={t('settings.ui.increaseAria', { label })}
          >
            +
          </button>
        </div>
      }
    />
  )
}

function RangeSlider({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (next: number) => void
  ariaLabel: string
}): React.ReactNode {
  return (
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
          width: `${((value - min) / (max - min)) * 100}%`,
          height: 3,
          transform: 'translateY(-50%)',
          borderRadius: 99,
          background: theme.text.accent,
          pointerEvents: 'none'
        }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        aria-label={ariaLabel}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          cursor: 'default',
          margin: 0
        }}
      />
    </div>
  )
}

export function UIPane({ draft, onChange }: UIPaneProps): React.ReactNode {
  const t = useT()
  const appearanceOptions: { value: ThemeAppearance; label: string }[] = [
    { value: 'system', label: t('common.system') },
    { value: 'light', label: t('settings.ui.appearanceLight') },
    { value: 'dark', label: t('settings.ui.appearanceDark') }
  ]
  const languageOptions: { value: AppLanguage; label: string }[] = [
    { value: 'auto', label: t('common.system') },
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' }
  ]
  const chatPanelOpacityPercent = Math.round(
    (draft.general?.chatPanelOpacity ?? DEFAULT_CHAT_PANEL_OPACITY) * 100
  )
  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>{t('settings.ui.appearanceSection')}</SettingLabel>

        <SettingItem
          label={t('settings.ui.themeLabel')}
          description={t('settings.ui.themeDesc')}
          control={
            <SimpleSelect<ThemeId>
              value={draft.general?.themeId ?? DEFAULT_THEME_ID}
              options={THEME_SELECT_OPTIONS}
              width={220}
              optionHeight={40}
              onChange={(next) =>
                onChange({
                  ...draft,
                  general: {
                    ...draft.general,
                    themeId: next,
                    themeAppearance: draft.general?.themeAppearance ?? DEFAULT_THEME_APPEARANCE
                  }
                })
              }
            />
          }
        />

        <SettingItem
          label={t('settings.ui.appearanceLabel')}
          description={t('settings.ui.appearanceDesc')}
          control={
            <SimpleSelect<ThemeAppearance>
              value={draft.general?.themeAppearance ?? DEFAULT_THEME_APPEARANCE}
              options={appearanceOptions}
              width={132}
              onChange={(next) =>
                onChange({
                  ...draft,
                  general: {
                    ...draft.general,
                    themeId: draft.general?.themeId ?? DEFAULT_THEME_ID,
                    themeAppearance: next
                  }
                })
              }
            />
          }
        />

        <SettingItem
          label={t('settings.ui.chatPanelOpacityLabel')}
          description={t('settings.ui.chatPanelOpacityDesc')}
          control={
            <div className="flex items-center gap-3">
              <RangeSlider
                value={chatPanelOpacityPercent}
                min={MIN_CHAT_PANEL_OPACITY_PERCENT}
                max={100}
                step={1}
                onChange={(next) =>
                  onChange({
                    ...draft,
                    general: { ...draft.general, chatPanelOpacity: next / 100 }
                  })
                }
                ariaLabel={t('settings.ui.chatPanelOpacityLabel')}
              />
              <span
                className="text-sm font-medium tabular-nums"
                style={{ minWidth: 44, textAlign: 'right', color: theme.text.primary }}
              >
                {chatPanelOpacityPercent}%
              </span>
            </div>
          }
        />

        <SettingItem
          label={t('settings.ui.languageLabel')}
          description={t('settings.ui.languageDesc')}
          control={
            <SimpleSelect<AppLanguage>
              value={draft.general?.language ?? 'auto'}
              options={languageOptions}
              width={132}
              onChange={(next) =>
                onChange({ ...draft, general: { ...draft.general, language: next } })
              }
            />
          }
        />
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.ui.textSizeSection')}</SettingLabel>

        <FontSizeRow
          label={t('settings.ui.interfaceTextLabel')}
          description={t('settings.ui.interfaceTextDesc')}
          value={draft.general?.uiFontSize}
          steps={UI_FONT_SIZES}
          defaultValue={DEFAULT_UI_FONT_SIZE}
          onChange={(next) =>
            onChange({ ...draft, general: { ...draft.general, uiFontSize: next } })
          }
        />
        <FontSizeRow
          label={t('settings.ui.chatTextLabel')}
          description={t('settings.ui.chatTextDesc')}
          value={draft.general?.chatFontSize}
          steps={CHAT_FONT_SIZES}
          defaultValue={DEFAULT_CHAT_FONT_SIZE}
          onChange={(next) =>
            onChange({ ...draft, general: { ...draft.general, chatFontSize: next } })
          }
        />
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.ui.layoutSection')}</SettingLabel>

        <SettingItem
          label={t('settings.ui.sidebarOnLaunchLabel')}
          description={t('settings.ui.sidebarOnLaunchDesc')}
          control={
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
              ariaLabel={t('settings.ui.sidebarToggleAria')}
            />
          }
        />

        <SettingItem
          label={t('settings.ui.messagePreviewLabel')}
          description={t('settings.ui.messagePreviewDesc')}
          control={
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
              ariaLabel={t('settings.ui.messagePreviewToggleAria')}
            />
          }
        />

        <SettingItem
          label={t('settings.ui.toolCallPresentationLabel')}
          control={
            <SimpleSelect<ToolCallDisplayMode>
              value={draft.general?.toolCallDisplayMode ?? DEFAULT_TOOL_CALL_DISPLAY_MODE}
              options={[
                {
                  value: 'work-summary',
                  label: t('settings.ui.toolCallPresentationWorkSummary')
                },
                {
                  value: 'tool-deck',
                  label: t('settings.ui.toolCallPresentationToolDeck')
                }
              ]}
              width={160}
              onChange={(toolCallDisplayMode) =>
                onChange({
                  ...draft,
                  general: { ...draft.general, toolCallDisplayMode }
                })
              }
            />
          }
        />
      </SettingSection>
    </div>
  )
}
