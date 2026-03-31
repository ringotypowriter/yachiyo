import { ChevronDown, CircleCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { theme } from '@renderer/theme/theme'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import {
  getToolModelConfig,
  resolveToolModelProvider
} from '../../../shared/yachiyo/providerConfig.ts'
import { formatStoredModelChip } from '../../src/lib/model/modelLabel'
import { ModelSelectorPopup } from '../../src/features/chat/components/ModelSelectorPopup'
import { canOpenToolModelPicker } from '../../src/features/chat/lib/modelSelectorState'
import { FixedStepSlider } from '../components/FixedStepSlider'
import { resolveClosestFixedStepOption } from '../components/fixedStepSliderUtils'
import { SettingLabel, SettingRow, SettingSection, SettingSwitch } from '../components/primitives'

const MAX_CHAT_TOKEN_LEVELS = [
  { label: '1k', value: 1024 },
  { label: '2k', value: 2048 },
  { label: '3k', value: 3072 },
  { label: '4k', value: 4096 }
] as const

interface ChatPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function ChatPane({ draft, onChange }: ChatPaneProps): React.ReactNode {
  const activeRunEnterBehavior = draft.chat?.activeRunEnterBehavior ?? 'enter-steers'
  const maxChatToken = draft.chat?.maxChatToken
  const maxChatTokenLevel =
    maxChatToken == null
      ? undefined
      : resolveClosestFixedStepOption(MAX_CHAT_TOKEN_LEVELS, maxChatToken)
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const defaultModelSelectorRef = useRef<HTMLDivElement>(null)
  const defaultModelPopupRef = useRef<HTMLDivElement>(null)
  const defaultModelTriggerRef = useRef<HTMLButtonElement>(null)
  const [defaultModelSelectorOpen, setDefaultModelSelectorOpen] = useState(false)
  const [defaultModelAnchorRect, setDefaultModelAnchorRect] = useState<DOMRect | null>(null)

  const updateToolModelAnchorRect = (): void => {
    setToolModelAnchorRect(toolModelTriggerRef.current?.getBoundingClientRect() ?? null)
  }

  const updateDefaultModelAnchorRect = (): void => {
    setDefaultModelAnchorRect(defaultModelTriggerRef.current?.getBoundingClientRect() ?? null)
  }

  useEffect(() => {
    if (!toolModelSelectorOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (toolModelSelectorRef.current?.contains(target)) {
        return
      }

      if (toolModelPopupRef.current?.contains(target)) {
        return
      }

      setToolModelSelectorOpen(false)
    }

    const handleViewportChange = (): void => {
      updateToolModelAnchorRect()
    }

    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [toolModelSelectorOpen])

  useEffect(() => {
    if (!defaultModelSelectorOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (defaultModelSelectorRef.current?.contains(target)) {
        return
      }

      if (defaultModelPopupRef.current?.contains(target)) {
        return
      }

      setDefaultModelSelectorOpen(false)
    }

    const handleViewportChange = (): void => {
      updateDefaultModelAnchorRect()
    }

    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [defaultModelSelectorOpen])

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
        ? `Default${defaultModelLabel ? ` — ${defaultModelLabel}` : ''}`
        : 'Disabled'

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>Active run</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Enter steers during active runs
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Off = queue follow-up. Alt+Enter swaps.
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
              ariaLabel="Toggle Enter steering during active runs"
            />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Thread output</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Max Chat Token
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Caps reply length for app chat, external DMs, and group replies.
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <FixedStepSlider
              ariaLabel="Max Chat Token"
              options={MAX_CHAT_TOKEN_LEVELS}
              value={maxChatToken}
              onChange={(nextValue) =>
                onChange({
                  ...draft,
                  chat: {
                    ...draft.chat,
                    activeRunEnterBehavior,
                    maxChatToken: nextValue
                  }
                })
              }
            />
            <span
              className="text-sm font-medium tabular-nums"
              style={{ minWidth: 48, textAlign: 'right', color: theme.text.primary }}
            >
              {maxChatTokenLevel?.label ?? 'Auto'}
            </span>
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Default model</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Model used for new threads
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {hasEnabledModels
                ? 'Per-thread overrides take precedence.'
                : 'Enable a model in Providers first.'}
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
                opacity: defaultModelSelectorOpen ? 1 : 0.72,
                cursor: hasEnabledModels ? 'pointer' : 'default'
              }}
              aria-label="Default model selection"
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
        <SettingLabel>Tool model</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Thread titles and small auxiliary tasks
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {hasEnabledModels
                ? 'Uses the selected model below.'
                : 'Enable a model in Providers first.'}
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

                updateToolModelAnchorRect()
                setToolModelSelectorOpen((open) => !open)
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity"
              style={{
                color: theme.text.primary,
                opacity: toolModelSelectorOpen ? 1 : 0.72,
                cursor: canOpenToolModelSelector ? 'pointer' : 'default'
              }}
              aria-label="Tool model selection"
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
                currentProviderName={selectedToolProvider?.name ?? ''}
                currentModel={toolModel.model}
                leadingOptions={[
                  {
                    label: 'Default (same as chat model)',
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
                    label: 'Disabled',
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
    </div>
  )
}
