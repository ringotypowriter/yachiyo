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
import { SettingLabel, SettingRow, SettingSection, SettingSwitch } from '../components/primitives'
import { inputStyle } from '../components/styles'

interface ChatPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
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
  const toolModelSelectorRef = useRef<HTMLDivElement>(null)
  const toolModelPopupRef = useRef<HTMLDivElement>(null)
  const toolModelTriggerRef = useRef<HTMLButtonElement>(null)
  const [toolModelSelectorOpen, setToolModelSelectorOpen] = useState(false)
  const [toolModelAnchorRect, setToolModelAnchorRect] = useState<DOMRect | null>(null)

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

  const defaultModelSelectorRef = useRef<HTMLDivElement>(null)
  const defaultModelPopupRef = useRef<HTMLDivElement>(null)
  const defaultModelTriggerRef = useRef<HTMLButtonElement>(null)
  const [defaultModelSelectorOpen, setDefaultModelSelectorOpen] = useState(false)
  const [defaultModelAnchorRect, setDefaultModelAnchorRect] = useState<DOMRect | null>(null)

  const i2tModelSelectorRef = useRef<HTMLDivElement>(null)
  const i2tModelPopupRef = useRef<HTMLDivElement>(null)
  const i2tModelTriggerRef = useRef<HTMLButtonElement>(null)
  const [i2tModelSelectorOpen, setI2tModelSelectorOpen] = useState(false)
  const [i2tModelAnchorRect, setI2tModelAnchorRect] = useState<DOMRect | null>(null)

  const updateDefaultModelAnchorRect = (): void => {
    setDefaultModelAnchorRect(defaultModelTriggerRef.current?.getBoundingClientRect() ?? null)
  }

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
        <SettingLabel>{t('settings.chat.activeRunSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.chat.enterSteersLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.chat.enterSteersDesc')}
            </div>
          </div>

          <div className="shrink-0">
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
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.chat.inputBufferingSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.chat.mergeRapidLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.chat.mergeRapidDesc')}
            </div>
          </div>

          <div className="shrink-0">
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
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.chat.contextSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.chat.contextHandoffLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.chat.contextHandoffDesc')}
            </div>
          </div>

          <div className="shrink-0">
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
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.chat.handoffThresholdLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.chat.handoffThresholdDesc')}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
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
                    chat: {
                      ...draft.chat,
                      stripCompactThresholdTokens: Math.round(raw * 1000)
                    }
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
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.chat.recapSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.chat.recapLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.chat.recapDesc', { duration: RECAP_IDLE_LABEL })}
            </div>
          </div>

          <div className="shrink-0">
            <SettingSwitch
              checked={draft.chat?.recapEnabled !== false}
              onChange={() =>
                onChange({
                  ...draft,
                  chat: {
                    ...draft.chat,
                    recapEnabled: draft.chat?.recapEnabled === false
                  }
                })
              }
              ariaLabel={t('settings.chat.recapToggleAria')}
            />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.chat.defaultModelSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.chat.defaultModelLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {hasEnabledModels
                ? t('settings.chat.defaultModelDesc')
                : t('settings.chat.enableModelFirst')}
            </div>
          </div>

          <div ref={defaultModelSelectorRef} className="relative shrink-0">
            <button
              ref={defaultModelTriggerRef}
              type="button"
              onClick={() => {
                if (!hasEnabledModels) {
                  return
                }

                updateDefaultModelAnchorRect()
                setDefaultModelSelectorOpen((open) => !open)
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity"
              style={{
                color: theme.text.primary,
                opacity: defaultModelSelectorOpen ? 1 : 0.72
              }}
              aria-label={t('settings.chat.defaultModelAria')}
            >
              <CircleCheck
                size={12}
                strokeWidth={1.5}
                color={currentDefaultModel ? theme.icon.success : theme.icon.muted}
              />
              {defaultModelLabel}
              {hasEnabledModels ? (
                <ChevronDown
                  size={10}
                  strokeWidth={1.5}
                  color={theme.icon.muted}
                  style={{
                    transform: defaultModelSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s ease'
                  }}
                />
              ) : null}
            </button>

            {defaultModelSelectorOpen ? (
              <ModelSelectorPopup
                config={draft}
                containerRef={defaultModelPopupRef}
                triggerRef={defaultModelSelectorRef}
                onRequestAnchorUpdate={() =>
                  setDefaultModelAnchorRect(
                    defaultModelTriggerRef.current?.getBoundingClientRect() ?? null
                  )
                }
                currentProviderName={currentDefaultModel?.providerName ?? ''}
                currentModel={currentDefaultModel?.model ?? ''}
                onSelect={(providerName, model) => {
                  onChange({ ...draft, defaultModel: { providerName, model } })
                }}
                onClose={() => setDefaultModelSelectorOpen(false)}
                align="right"
                anchorRect={defaultModelAnchorRect}
                placement="bottom"
                portal
              />
            ) : null}
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.chat.toolModelSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.chat.toolModelLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {hasEnabledModels
                ? t('settings.chat.toolModelDesc')
                : t('settings.chat.enableModelFirst')}
            </div>
          </div>

          <div ref={toolModelSelectorRef} className="relative shrink-0">
            <button
              ref={toolModelTriggerRef}
              type="button"
              onClick={() => {
                if (!canOpenToolModelSelector) {
                  return
                }

                setToolModelAnchorRect(toolModelTriggerRef.current?.getBoundingClientRect() ?? null)
                setToolModelSelectorOpen((open) => !open)
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity"
              style={{
                color: theme.text.primary,
                opacity: toolModelSelectorOpen ? 1 : 0.72
              }}
              aria-label={t('settings.chat.toolModelAria')}
            >
              <CircleCheck
                size={12}
                strokeWidth={1.5}
                color={toolModel.mode === 'disabled' ? theme.icon.muted : theme.icon.success}
              />
              {toolModelLabel}
              {canOpenToolModelSelector ? (
                <ChevronDown
                  size={10}
                  strokeWidth={1.5}
                  color={theme.icon.muted}
                  style={{
                    transform: toolModelSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s ease'
                  }}
                />
              ) : null}
            </button>

            {toolModelSelectorOpen ? (
              <ModelSelectorPopup
                config={draft}
                containerRef={toolModelPopupRef}
                triggerRef={toolModelSelectorRef}
                onRequestAnchorUpdate={() =>
                  setToolModelAnchorRect(
                    toolModelTriggerRef.current?.getBoundingClientRect() ?? null
                  )
                }
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
                  const provider =
                    draft.providers.find((entry) => entry.name === providerName) ?? null
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
                onClose={() => setToolModelSelectorOpen(false)}
                align="right"
                anchorRect={toolModelAnchorRect}
                placement="bottom"
                portal
              />
            ) : null}
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.chat.i2tSection')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.chat.i2tLabel')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {hasEnabledModels ? t('settings.chat.i2tDesc') : t('settings.chat.enableModelFirst')}
            </div>
          </div>

          <div ref={i2tModelSelectorRef} className="relative shrink-0">
            <button
              ref={i2tModelTriggerRef}
              type="button"
              onClick={() => {
                if (!hasEnabledModels) return
                setI2tModelAnchorRect(i2tModelTriggerRef.current?.getBoundingClientRect() ?? null)
                setI2tModelSelectorOpen((open) => !open)
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity"
              style={{
                color: theme.text.primary,
                opacity: i2tModelSelectorOpen ? 1 : 0.72
              }}
              aria-label={t('settings.chat.i2tAria')}
            >
              <CircleCheck
                size={12}
                strokeWidth={1.5}
                color={currentI2tModel ? theme.icon.success : theme.icon.muted}
              />
              {i2tModelLabel}
              {hasEnabledModels ? (
                <ChevronDown
                  size={10}
                  strokeWidth={1.5}
                  color={theme.icon.muted}
                  style={{
                    transform: i2tModelSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s ease'
                  }}
                />
              ) : null}
            </button>

            {i2tModelSelectorOpen ? (
              <ModelSelectorPopup
                config={draft}
                containerRef={i2tModelPopupRef}
                triggerRef={i2tModelSelectorRef}
                onRequestAnchorUpdate={() =>
                  setI2tModelAnchorRect(i2tModelTriggerRef.current?.getBoundingClientRect() ?? null)
                }
                currentProviderName={currentI2tModel?.providerName ?? ''}
                currentModel={currentI2tModel?.model ?? ''}
                leadingOptions={[
                  {
                    label: t('settings.chat.sameAsToolModel'),
                    isSelected: !currentI2tModel,
                    onSelect: () =>
                      onChange({
                        ...draft,
                        chat: {
                          ...draft.chat,
                          imageToTextModel: undefined
                        }
                      })
                  }
                ]}
                onSelect={(providerName, model) => {
                  onChange({
                    ...draft,
                    chat: {
                      ...draft.chat,
                      imageToTextModel: { providerName, model }
                    }
                  })
                }}
                onClose={() => setI2tModelSelectorOpen(false)}
                align="right"
                anchorRect={i2tModelAnchorRect}
                placement="bottom"
                portal
              />
            ) : null}
          </div>
        </SettingRow>
      </SettingSection>
    </div>
  )
}
