import { ChevronDown, CircleCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { theme } from '@renderer/theme/theme'
import {
  DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
  type SettingsConfig
} from '../../../shared/yachiyo/protocol.ts'
import {
  getToolModelConfig,
  resolveToolModelProvider
} from '../../../shared/yachiyo/providerConfig.ts'
import { formatStoredModelChip } from '../../src/lib/model/modelLabel'
import { ModelSelectorPopup } from '../../src/features/chat/components/ModelSelectorPopup'
import { canOpenToolModelPicker } from '../../src/features/chat/lib/modelSelectorState'
import { RECAP_IDLE_LABEL } from '../../src/features/layout/lib/recapIdle'
import { SettingLabel, SettingRow, SettingSection, SettingSwitch } from '../components/primitives'
import { inputStyle } from '../components/styles'

interface ChatPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function ChatPane({ draft, onChange }: ChatPaneProps): React.ReactNode {
  const activeRunEnterBehavior = draft.chat?.activeRunEnterBehavior ?? 'enter-steers'
  const stripCompactThresholdK = Math.round(
    (draft.chat?.stripCompactThresholdTokens ?? DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD) / 1000
  )
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

  useEffect(() => {
    if (!i2tModelSelectorOpen) return

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (i2tModelSelectorRef.current?.contains(target)) return
      if (i2tModelPopupRef.current?.contains(target)) return
      setI2tModelSelectorOpen(false)
    }

    const handleViewportChange = (): void => {
      setI2tModelAnchorRect(i2tModelTriggerRef.current?.getBoundingClientRect() ?? null)
    }

    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [i2tModelSelectorOpen])

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

  const currentI2tModel = draft.chat?.imageToTextModel
  const i2tModelProvider = currentI2tModel
    ? (draft.providers.find((p) => p.name === currentI2tModel.providerName) ?? null)
    : null
  const i2tModelLabel =
    i2tModelProvider && currentI2tModel?.model
      ? `${i2tModelProvider.name} - ${formatStoredModelChip(currentI2tModel.model, i2tModelProvider.name).model}`
      : 'Default (same as tool model)'

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
        <SettingLabel>Input buffering</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Merge rapid messages before sending
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Off = send immediately. Composer has a per-session override.
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
              ariaLabel="Toggle input buffering"
            />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Context management</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Strip Compact
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Trim old tool results when context exceeds the threshold.
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
              ariaLabel="Toggle Strip Compact"
            />
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Strip threshold
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Also controls the Composer context warning.
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <input
              type="number"
              min={1}
              step={1}
              value={stripCompactThresholdK}
              onChange={(e) => {
                const raw = parseInt(e.target.value, 10)
                if (!Number.isNaN(raw) && raw > 0) {
                  onChange({
                    ...draft,
                    chat: {
                      ...draft.chat,
                      stripCompactThresholdTokens: raw * 1000
                    }
                  })
                }
              }}
              className="w-20 rounded-lg px-2 py-1 text-sm text-right outline-none"
              style={inputStyle()}
              aria-label="Strip compact threshold in thousands of tokens"
            />
            <span className="text-sm" style={{ color: theme.text.secondary }}>
              K
            </span>
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Recap</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Auto-recap on idle threads
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Generate a brief summary when returning to a thread idle for {RECAP_IDLE_LABEL}+.
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
              ariaLabel="Toggle auto-recap on idle threads"
            />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Memory</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Auto-distill memory after runs
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Off = only the remember tool writes to memory.
            </div>
          </div>

          <div className="shrink-0">
            <SettingSwitch
              checked={draft.chat?.autoMemoryDistillation !== false}
              onChange={() =>
                onChange({
                  ...draft,
                  chat: {
                    ...draft.chat,
                    autoMemoryDistillation: draft.chat?.autoMemoryDistillation === false
                  }
                })
              }
              ariaLabel="Toggle auto memory distillation"
            />
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

      <SettingSection>
        <SettingLabel>Image to Text model</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Vision model for image descriptions
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {hasEnabledModels
                ? 'Used when non-image-capable models need to process images.'
                : 'Enable a model in Providers first.'}
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
                opacity: i2tModelSelectorOpen ? 1 : 0.72,
                cursor: hasEnabledModels ? 'pointer' : 'default'
              }}
              aria-label="Image to Text model selection"
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
                currentProviderName={currentI2tModel?.providerName ?? ''}
                currentModel={currentI2tModel?.model ?? ''}
                leadingOptions={[
                  {
                    label: 'Default (same as tool model)',
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
