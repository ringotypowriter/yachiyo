import { ChevronDown, CircleCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '@yachiyo/i18n/react'
import { theme } from '@renderer/theme/theme'
import {
  DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
  type SettingsConfig
} from '@yachiyo/shared/protocol'
import { getToolModelConfig, resolveToolModelProvider } from '@yachiyo/shared/providerConfig'
import { formatStoredModelChip } from '../../src/lib/model/modelLabel'
import { ModelSelectorPopup } from '../../src/features/chat/components/ModelSelectorPopup'
import { canOpenToolModelPicker } from '../../src/features/chat/lib/composer/modelSelectorState'
import { RECAP_IDLE_LABEL } from '../../src/features/layout/lib/recapIdle'
import { SettingItem, SettingLabel, SettingSection, SettingSwitch } from '../components/primitives'
import { inputStyle } from '../components/styles'

interface ChatPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

interface ModelPickerRowProps {
  ariaLabel: string
  config: SettingsConfig
  currentModel: string
  currentProviderName: string
  description?: string
  hasSelection: boolean
  label: string
  leadingOptions?: React.ComponentProps<typeof ModelSelectorPopup>['leadingOptions']
  onSelect: (providerName: string, model: string) => void
  openable: boolean
  valueLabel: string
}

/**
 * A model row: label on the left, an inline picker on the right. All three model settings
 * share the same anchoring, popup, and chevron behavior.
 */
function ModelPickerRow({
  ariaLabel,
  config,
  currentModel,
  currentProviderName,
  description,
  hasSelection,
  label,
  leadingOptions,
  onSelect,
  openable,
  valueLabel
}: ModelPickerRowProps): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)

  const syncAnchorRect = (): void => {
    setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null)
  }

  return (
    <SettingItem
      label={label}
      description={description}
      control={
        <div ref={containerRef} className="relative">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => {
              if (!openable) {
                return
              }

              syncAnchorRect()
              setOpen((current) => !current)
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity"
            style={{ color: theme.text.primary, opacity: open ? 1 : 0.72 }}
            aria-label={ariaLabel}
          >
            <CircleCheck
              size={12}
              strokeWidth={1.5}
              color={hasSelection ? theme.icon.success : theme.icon.muted}
            />
            {valueLabel}
            {openable ? (
              <ChevronDown
                size={10}
                strokeWidth={1.5}
                color={theme.icon.muted}
                style={{
                  transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease'
                }}
              />
            ) : null}
          </button>

          {open ? (
            <ModelSelectorPopup
              config={config}
              containerRef={popupRef}
              triggerRef={containerRef}
              onRequestAnchorUpdate={syncAnchorRect}
              currentProviderName={currentProviderName}
              currentModel={currentModel}
              leadingOptions={leadingOptions}
              onSelect={onSelect}
              onClose={() => setOpen(false)}
              align="right"
              anchorRect={anchorRect}
              placement="bottom"
              portal
            />
          ) : null}
        </div>
      }
    />
  )
}

export function ChatPane({ draft, onChange }: ChatPaneProps): React.ReactNode {
  const t = useT()
  const activeRunEnterBehavior = draft.chat?.activeRunEnterBehavior ?? 'enter-steers'
  const contextHandoffThresholdTokens =
    draft.chat?.stripCompactThresholdTokens ?? DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD
  const contextHandoffThresholdK = Number(
    (contextHandoffThresholdTokens / 1000).toFixed(3)
  ).toString()
  const toolModel = getToolModelConfig(draft)
  const selectedToolProvider = resolveToolModelProvider(draft, toolModel)

  useEffect(() => {
    if (draft.defaultModel != null) return
    for (const provider of draft.providers) {
      const firstModel = provider.modelList.enabled[0]
      if (firstModel) {
        onChange({ ...draft, defaultModel: { providerName: provider.name, model: firstModel } })
        return
      }
    }
  }, [draft, onChange])

  const enabledProviderCount = draft.providers.filter(
    (provider) => provider.modelList.enabled.length > 0
  ).length
  const hasEnabledModels = enabledProviderCount > 0
  const canOpenToolModelSelector = canOpenToolModelPicker({
    hasEnabledModels,
    toolModelMode: toolModel.mode
  })

  const currentDefaultModel = draft.defaultModel
  const defaultModelProvider = currentDefaultModel
    ? (draft.providers.find((p) => p.name === currentDefaultModel.providerName) ?? null)
    : null
  const defaultModelLabel =
    defaultModelProvider && currentDefaultModel?.model
      ? `${defaultModelProvider.name} - ${formatStoredModelChip(currentDefaultModel.model, defaultModelProvider.name).model}`
      : ''

  const toolModelLabel =
    toolModel.mode === 'custom' && selectedToolProvider && toolModel.model
      ? `${selectedToolProvider.name} - ${formatStoredModelChip(toolModel.model, selectedToolProvider.name).model}`
      : toolModel.mode === 'default'
        ? `${t('common.default')}${defaultModelLabel ? ` — ${defaultModelLabel}` : ''}`
        : t('common.disabled')

  const currentI2tModel = draft.chat?.imageToTextModel
  const i2tModelProvider = currentI2tModel
    ? (draft.providers.find((p) => p.name === currentI2tModel.providerName) ?? null)
    : null
  const i2tModelLabel =
    i2tModelProvider && currentI2tModel?.model
      ? `${i2tModelProvider.name} - ${formatStoredModelChip(currentI2tModel.model, i2tModelProvider.name).model}`
      : t('settings.chat.sameAsToolModel')

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>{t('settings.chat.conversationSection')}</SettingLabel>

        <SettingItem
          label={t('settings.chat.enterSteersLabel')}
          description={t('settings.chat.enterSteersDesc')}
          control={
            <SettingSwitch
              checked={activeRunEnterBehavior === 'enter-steers'}
              onChange={() =>
                onChange({
                  ...draft,
                  chat: {
                    ...draft.chat,
                    activeRunEnterBehavior:
                      activeRunEnterBehavior === 'enter-steers'
                        ? 'enter-queues-follow-up'
                        : 'enter-steers'
                  }
                })
              }
              ariaLabel={t('settings.chat.enterSteersToggleAria')}
            />
          }
        />

        <SettingItem
          label={t('settings.chat.mergeRapidLabel')}
          description={t('settings.chat.mergeRapidDesc')}
          control={
            <SettingSwitch
              checked={draft.chat?.inputBufferEnabled === true}
              onChange={() =>
                onChange({
                  ...draft,
                  chat: {
                    ...draft.chat,
                    inputBufferEnabled: draft.chat?.inputBufferEnabled !== true
                  }
                })
              }
              ariaLabel={t('settings.chat.inputBufferToggleAria')}
            />
          }
        />

        <SettingItem
          label={t('settings.chat.recapLabel')}
          description={t('settings.chat.recapDesc', { duration: RECAP_IDLE_LABEL })}
          control={
            <SettingSwitch
              checked={draft.chat?.recapEnabled !== false}
              onChange={() =>
                onChange({
                  ...draft,
                  chat: { ...draft.chat, recapEnabled: draft.chat?.recapEnabled === false }
                })
              }
              ariaLabel={t('settings.chat.recapToggleAria')}
            />
          }
        />
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.chat.contextSection')}</SettingLabel>

        <SettingItem
          label={t('settings.chat.contextHandoffLabel')}
          description={t('settings.chat.contextHandoffDesc')}
          control={
            <SettingSwitch
              checked={draft.chat?.stripCompact !== false}
              onChange={() =>
                onChange({
                  ...draft,
                  chat: { ...draft.chat, stripCompact: draft.chat?.stripCompact === false }
                })
              }
              ariaLabel={t('settings.chat.contextHandoffToggleAria')}
            />
          }
        />

        <SettingItem
          label={t('settings.chat.handoffThresholdLabel')}
          description={t('settings.chat.handoffThresholdDesc')}
          control={
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                step={0.1}
                value={contextHandoffThresholdK}
                onChange={(e) => {
                  const raw = Number.parseFloat(e.target.value)
                  if (!Number.isNaN(raw) && raw > 0) {
                    onChange({
                      ...draft,
                      chat: { ...draft.chat, stripCompactThresholdTokens: Math.round(raw * 1000) }
                    })
                  }
                }}
                className="w-20 rounded-lg px-2 py-1 text-sm text-right outline-none"
                style={inputStyle()}
                aria-label={t('settings.chat.handoffThresholdAria')}
              />
              <span className="text-sm" style={{ color: theme.text.secondary }}>
                K
              </span>
            </div>
          }
        />
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.chat.modelsSection')}</SettingLabel>

        <ModelPickerRow
          label={t('settings.chat.defaultModelLabel')}
          description={
            hasEnabledModels
              ? t('settings.chat.defaultModelDesc')
              : t('settings.chat.enableModelFirst')
          }
          ariaLabel={t('settings.chat.defaultModelAria')}
          config={draft}
          openable={hasEnabledModels}
          hasSelection={Boolean(currentDefaultModel)}
          valueLabel={defaultModelLabel}
          currentProviderName={currentDefaultModel?.providerName ?? ''}
          currentModel={currentDefaultModel?.model ?? ''}
          onSelect={(providerName, model) =>
            onChange({ ...draft, defaultModel: { providerName, model } })
          }
        />

        <ModelPickerRow
          label={t('settings.chat.toolModelLabel')}
          description={hasEnabledModels ? undefined : t('settings.chat.enableModelFirst')}
          ariaLabel={t('settings.chat.toolModelAria')}
          config={draft}
          openable={canOpenToolModelSelector}
          hasSelection={toolModel.mode !== 'disabled'}
          valueLabel={toolModelLabel}
          currentProviderName={selectedToolProvider?.name ?? ''}
          currentModel={toolModel.model}
          leadingOptions={[
            {
              label: t('settings.chat.sameAsChatModel'),
              isSelected: toolModel.mode === 'default',
              onSelect: () =>
                onChange({
                  ...draft,
                  toolModel: {
                    ...toolModel,
                    mode: 'default',
                    providerId: '',
                    providerName: '',
                    model: ''
                  }
                })
            },
            {
              label: t('common.disabled'),
              isSelected: toolModel.mode === 'disabled',
              onSelect: () =>
                onChange({
                  ...draft,
                  toolModel: {
                    ...toolModel,
                    mode: 'disabled',
                    providerId: '',
                    providerName: '',
                    model: ''
                  }
                })
            }
          ]}
          onSelect={(providerName, model) => {
            const provider = draft.providers.find((entry) => entry.name === providerName) ?? null
            onChange({
              ...draft,
              toolModel: {
                ...toolModel,
                mode: 'custom',
                providerId: provider?.id ?? '',
                providerName,
                model
              }
            })
          }}
        />

        <ModelPickerRow
          label={t('settings.chat.i2tLabel')}
          description={
            hasEnabledModels ? t('settings.chat.i2tDesc') : t('settings.chat.enableModelFirst')
          }
          ariaLabel={t('settings.chat.i2tAria')}
          config={draft}
          openable={hasEnabledModels}
          hasSelection={Boolean(currentI2tModel)}
          valueLabel={i2tModelLabel}
          currentProviderName={currentI2tModel?.providerName ?? ''}
          currentModel={currentI2tModel?.model ?? ''}
          leadingOptions={[
            {
              label: t('settings.chat.sameAsToolModel'),
              isSelected: !currentI2tModel,
              onSelect: () =>
                onChange({ ...draft, chat: { ...draft.chat, imageToTextModel: undefined } })
            }
          ]}
          onSelect={(providerName, model) =>
            onChange({
              ...draft,
              chat: { ...draft.chat, imageToTextModel: { providerName, model } }
            })
          }
        />
      </SettingSection>
    </div>
  )
}
