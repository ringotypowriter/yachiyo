import { useDeferredValue, useMemo, useState } from 'react'
import {
  Brain,
  Eraser,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import { AppDialog } from '@renderer/components/AppDialog'
import { imeSafeEnter } from '@renderer/lib/imeUtils'
import { SettingSwitch, SimpleSelect } from '../components/primitives'
import {
  REASONING_EFFORT_LEVELS,
  type ComposerReasoningSelection,
  type ProviderConfig,
  type ProviderReasoningConfig,
  type ProviderReasoningModelConfig,
  type ReasoningEffortLevel
} from '../../../shared/yachiyo/protocol.ts'
import { computeImageIncapableForNewModels } from '../../../shared/yachiyo/providerConfig.ts'
import {
  getReasoningSelectorState,
  isReasoningEffortSelectable,
  normalizeProviderReasoningConfig
} from '../../../shared/yachiyo/reasoningEffort.ts'
import { filterProviderModels } from './providersPaneModel'

interface ModelToggleProps {
  enabled: boolean
  model: string
  imageCapable: boolean
  onOpenReasoning: () => void
  onRemove: () => void
  onToggle: () => void
  onToggleImageCapable: () => void
}

interface ReasoningModalProps {
  defaultEffort: ComposerReasoningSelection
  model: string
  onClose: () => void
  onSetDefault: (selection: ComposerReasoningSelection) => void
  onToggleOption: (selection: ComposerReasoningSelection) => void
  options: ComposerReasoningSelection[]
  provider: ProviderConfig
}

interface ModelListSectionProps {
  onProviderChange: (update: (provider: ProviderConfig) => ProviderConfig) => void
  provider: ProviderConfig
}

const REASONING_CHOICES: readonly {
  label: string
  value: ComposerReasoningSelection
}[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' }
]

function isReasoningLevel(
  selection: ComposerReasoningSelection
): selection is ReasoningEffortLevel {
  return selection !== 'off'
}

function sortReasoningEfforts(efforts: ReasoningEffortLevel[]): ReasoningEffortLevel[] {
  return REASONING_EFFORT_LEVELS.filter((level) => efforts.includes(level))
}

function withoutReasoningModel(
  reasoning: ProviderReasoningConfig | undefined,
  model: string
): ProviderReasoningConfig | undefined {
  const models = reasoning?.models?.filter((entry) => entry.model !== model) ?? []
  return normalizeProviderReasoningConfig({
    ...(reasoning ?? {}),
    models
  })
}

function withProviderReasoning(
  provider: ProviderConfig,
  reasoning: ProviderReasoningConfig | undefined
): ProviderConfig {
  const next = { ...provider }
  if (reasoning) {
    next.reasoning = reasoning
  } else {
    delete next.reasoning
  }
  return next
}

function upsertReasoningModel(
  provider: ProviderConfig,
  model: string,
  update: (state: {
    defaultEffort: ComposerReasoningSelection
    efforts: ReasoningEffortLevel[]
    allowOff: boolean
  }) => ProviderReasoningModelConfig
): ProviderConfig {
  const state = getReasoningSelectorState({
    provider: { ...provider, thinkingEnabled: true },
    model
  })
  const current = {
    allowOff: state.options.includes('off'),
    defaultEffort: state.selected,
    efforts: state.options.filter(isReasoningLevel)
  }
  const models = [
    ...(provider.reasoning?.models?.filter((entry) => entry.model !== model) ?? []),
    update(current)
  ]
  return withProviderReasoning(
    provider,
    normalizeProviderReasoningConfig({
      ...(provider.reasoning ?? {}),
      models
    })
  )
}

function buildReasoningModelConfig(input: {
  allowOff: boolean
  defaultEffort: ComposerReasoningSelection
  efforts: ReasoningEffortLevel[]
  model: string
}): ProviderReasoningModelConfig {
  const efforts = sortReasoningEfforts(input.efforts)
  if (efforts.length === 0) {
    return {
      model: input.model,
      enabled: false,
      enabledEfforts: [],
      defaultEffort: 'off',
      allowOff: true
    }
  }

  const options: ComposerReasoningSelection[] = [
    ...(input.allowOff ? (['off'] as const) : []),
    ...efforts
  ]
  const defaultEffort = options.includes(input.defaultEffort) ? input.defaultEffort : efforts[0]

  return {
    model: input.model,
    enabledEfforts: efforts,
    defaultEffort,
    allowOff: input.allowOff
  }
}

function formatReasoningOptionList(options: ComposerReasoningSelection[]): string {
  const labels = options.map(
    (option) => REASONING_CHOICES.find((choice) => choice.value === option)?.label ?? option
  )
  return labels.join(', ')
}

function ReasoningSettingsModal({
  model,
  options,
  defaultEffort,
  onToggleOption,
  onSetDefault,
  onClose,
  provider
}: ReasoningModalProps): React.ReactNode {
  const choices = REASONING_CHOICES.filter(
    (choice) =>
      choice.value === 'off' ||
      isReasoningEffortSelectable({
        provider,
        model,
        effort: choice.value
      })
  )
  const defaultOptions = options.map((value) => ({
    value,
    label: REASONING_CHOICES.find((choice) => choice.value === value)?.label ?? value
  }))

  return (
    <AppDialog
      title={model}
      description="Reasoning levels shown in the composer"
      showCloseButton
      width="min(520px, 100%)"
      bodyPadding="16px 20px"
      zIndex={9998}
      ariaLabel={`Reasoning settings for ${model}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        <div>
          <div className="mb-2 text-xs font-medium" style={{ color: theme.text.primary }}>
            Available levels
          </div>
          <div className="grid grid-cols-3 gap-2">
            {choices.map((choice) => {
              const active = options.includes(choice.value)
              return (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => onToggleOption(choice.value)}
                  className="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
                  style={{
                    color: active ? theme.text.counter : theme.text.secondary,
                    background: active ? theme.background.counterSoft : alpha('ink', 0.04),
                    border: `1px solid ${active ? theme.border.counter : theme.border.subtle}`
                  }}
                >
                  {choice.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium" style={{ color: theme.text.primary }}>
              Default
            </div>
            <div className="mt-1 text-xs truncate" style={{ color: theme.text.muted }}>
              {formatReasoningOptionList(options)}
            </div>
          </div>
          <SimpleSelect<ComposerReasoningSelection>
            value={defaultEffort}
            options={defaultOptions}
            width={140}
            onChange={onSetDefault}
          />
        </div>
      </div>
    </AppDialog>
  )
}

function ModelToggle({
  model,
  enabled,
  imageCapable,
  onToggle,
  onRemove,
  onOpenReasoning,
  onToggleImageCapable
}: ModelToggleProps): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  const ImageCapabilityIcon = imageCapable ? ImageIcon : ImageOff
  const imageCapabilityLabel = imageCapable ? 'Image Capable' : 'Image Incapable'

  return (
    <div
      className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 rounded-lg transition-colors overflow-hidden"
      style={{
        background: hovered ? theme.background.hover : 'transparent'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="min-w-0">
        <span className="block text-sm truncate" style={{ color: theme.text.primary }}>
          {model}
        </span>
      </div>

      <div className="flex items-center justify-end gap-2 shrink-0">
        <button
          type="button"
          onClick={onToggleImageCapable}
          className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors"
          style={{
            width: 144,
            color: imageCapable ? theme.text.secondary : theme.text.muted,
            background: alpha('ink', 0.04)
          }}
          title={
            imageCapable
              ? 'Image capable — click to mark as text-only'
              : 'Text-only — click to mark as image capable'
          }
        >
          <ImageCapabilityIcon size={12} strokeWidth={1.7} color={theme.icon.muted} />
          {imageCapabilityLabel}
        </button>
        <button
          type="button"
          onClick={onOpenReasoning}
          className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors"
          style={{
            width: 112,
            color: theme.text.secondary,
            background: alpha('ink', 0.04)
          }}
          aria-label={`Reasoning settings for ${model}`}
          title="Reasoning"
        >
          <Brain size={12} strokeWidth={1.7} color={theme.icon.muted} />
          Reasoning
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="p-0.5 rounded opacity-0 group-hover:opacity-40 hover:opacity-100! transition-opacity"
          title="Remove model"
        >
          <X size={12} strokeWidth={1.5} color={theme.icon.muted} />
        </button>
        <SettingSwitch
          checked={enabled}
          onChange={onToggle}
          ariaLabel={`${enabled ? 'Disable' : 'Enable'} ${model}`}
        />
      </div>
    </div>
  )
}

export function ModelListSection({
  provider,
  onProviderChange
}: ModelListSectionProps): React.ReactNode {
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [manualInput, setManualInput] = useState('')
  const [query, setQuery] = useState('')
  const [reasoningModalModel, setReasoningModalModel] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)

  const allModels = [...provider.modelList.enabled, ...provider.modelList.disabled]
  const filteredModelList = useMemo(
    () => filterProviderModels(provider.modelList, deferredQuery),
    [provider.modelList, deferredQuery]
  )
  const filteredModelCount = filteredModelList.enabled.length + filteredModelList.disabled.length

  const handleFetch = async (): Promise<void> => {
    setFetching(true)
    setFetchError(null)
    try {
      const models = await window.api.yachiyo.fetchProviderModels(provider)
      if (models.length === 0) return

      onProviderChange((p) => {
        const allExisting = [...p.modelList.enabled, ...p.modelList.disabled]
        const existing = new Set(allExisting)
        const newModels = models.filter((m) => !existing.has(m))
        return {
          ...p,
          modelList: {
            ...p.modelList,
            disabled: [...p.modelList.disabled, ...newModels],
            imageIncapable: computeImageIncapableForNewModels(
              p.modelList.imageIncapable,
              allExisting,
              newModels
            )
          }
        }
      })
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Failed to fetch models'
      const ipcMatch = raw.match(/Error invoking remote method '[^']+': (.+)$/s)
      setFetchError(ipcMatch ? ipcMatch[1] : raw)
    } finally {
      setFetching(false)
    }
  }

  const handleToggle = (model: string): void => {
    onProviderChange((p) => {
      const isEnabled = p.modelList.enabled.includes(model)
      return {
        ...p,
        modelList: isEnabled
          ? {
              enabled: p.modelList.enabled.filter((m) => m !== model),
              disabled: [...p.modelList.disabled, model]
            }
          : {
              enabled: [...p.modelList.enabled, model],
              disabled: p.modelList.disabled.filter((m) => m !== model)
            }
      }
    })
  }

  const handleRemoveModel = (model: string): void => {
    if (reasoningModalModel === model) {
      setReasoningModalModel(null)
    }

    onProviderChange((p) =>
      withProviderReasoning(
        {
          ...p,
          modelList: {
            enabled: p.modelList.enabled.filter((m) => m !== model),
            disabled: p.modelList.disabled.filter((m) => m !== model),
            imageIncapable: p.modelList.imageIncapable?.filter((m) => m !== model)
          }
        },
        withoutReasoningModel(p.reasoning, model)
      )
    )
  }

  const handleToggleImageCapable = (model: string): void => {
    onProviderChange((p) => {
      const current = p.modelList.imageIncapable ?? []
      const next = current.includes(model)
        ? current.filter((m) => m !== model)
        : [...current, model]
      return {
        ...p,
        modelList: {
          ...p.modelList,
          imageIncapable: next.length > 0 ? next : undefined
        }
      }
    })
  }

  const handleClearAll = (): void => {
    setReasoningModalModel(null)
    onProviderChange((p) => ({
      ...p,
      modelList: { enabled: [], disabled: [] },
      reasoning: undefined
    }))
  }

  const handleToggleReasoningOption = (
    model: string,
    selection: ComposerReasoningSelection
  ): void => {
    onProviderChange((p) =>
      upsertReasoningModel(p, model, (state) => {
        const allowOff = selection === 'off' ? !state.allowOff : state.allowOff
        const efforts = isReasoningLevel(selection)
          ? state.efforts.includes(selection)
            ? state.efforts.filter((effort) => effort !== selection)
            : [...state.efforts, selection]
          : state.efforts

        return buildReasoningModelConfig({
          allowOff,
          defaultEffort: state.defaultEffort,
          efforts,
          model
        })
      })
    )
  }

  const handleSetDefaultReasoning = (
    model: string,
    selection: ComposerReasoningSelection
  ): void => {
    onProviderChange((p) =>
      upsertReasoningModel(p, model, (state) =>
        buildReasoningModelConfig({
          allowOff: state.allowOff,
          defaultEffort: selection,
          efforts: state.efforts,
          model
        })
      )
    )
  }

  const renderModelToggle = (model: string, enabled: boolean): React.ReactNode => {
    return (
      <ModelToggle
        key={model}
        model={model}
        enabled={enabled}
        imageCapable={!(provider.modelList.imageIncapable ?? []).includes(model)}
        onToggle={() => handleToggle(model)}
        onRemove={() => handleRemoveModel(model)}
        onOpenReasoning={() => setReasoningModalModel(model)}
        onToggleImageCapable={() => handleToggleImageCapable(model)}
      />
    )
  }

  const reasoningModalState =
    reasoningModalModel && allModels.includes(reasoningModalModel)
      ? getReasoningSelectorState({
          provider: { ...provider, thinkingEnabled: true },
          model: reasoningModalModel
        })
      : null

  const handleAddManual = (): void => {
    const model = manualInput.trim()
    if (!model || allModels.includes(model)) {
      setManualInput('')
      return
    }

    onProviderChange((p) => ({
      ...p,
      modelList: {
        ...p.modelList,
        disabled: [...p.modelList.disabled, model],
        imageIncapable: computeImageIncapableForNewModels(
          p.modelList.imageIncapable,
          [...p.modelList.enabled, ...p.modelList.disabled],
          [model]
        )
      }
    }))
    setManualInput('')
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: theme.text.primary }}>
          Models
        </span>
        <div className="flex items-center gap-2">
          {allModels.length > 0 && (
            <button
              type="button"
              onClick={handleClearAll}
              className="flex items-center gap-1 text-xs font-medium transition-opacity opacity-50 hover:opacity-100"
              style={{ color: theme.text.danger }}
              title="Clear all models"
            >
              <Eraser size={12} strokeWidth={2} />
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleFetch()}
            disabled={
              fetching ||
              (provider.type !== 'vertex' &&
                provider.type !== 'openai-codex' &&
                !provider.apiKey.trim()) ||
              (provider.type === 'openai-codex' && !provider.codexSessionPath?.trim())
            }
            className="flex items-center gap-1 text-xs font-medium transition-opacity opacity-60 hover:opacity-100 disabled:opacity-20"
            style={{ color: theme.text.accent }}
            title={
              provider.type !== 'vertex' &&
              provider.type !== 'openai-codex' &&
              !provider.apiKey.trim()
                ? 'Add an API key first'
                : provider.type === 'openai-codex' && !provider.codexSessionPath?.trim()
                  ? 'Set a Codex session path first'
                  : 'Fetch available models'
            }
          >
            {fetching ? (
              <Loader2 size={12} strokeWidth={2} className="animate-spin" />
            ) : (
              <RefreshCw size={12} strokeWidth={2} />
            )}
            {fetching ? 'Fetching...' : 'Fetch'}
          </button>
        </div>
      </div>

      {fetchError ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: theme.text.danger }}>
          <span className="truncate">Fetch failed: {fetchError}</span>
          <button
            type="button"
            onClick={() => setFetchError(null)}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      ) : null}

      <div>
        {allModels.length === 0 ? (
          <div className="py-6 text-center">
            <span className="text-sm" style={{ color: theme.text.muted }}>
              No models yet. Fetch from API or add manually.
            </span>
          </div>
        ) : (
          <>
            <label
              className="flex items-center gap-2 px-3 py-2 rounded-lg mb-1"
              style={{ background: alpha('ink', 0.04) }}
            >
              <Search size={13} strokeWidth={1.75} color={theme.icon.placeholder} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                aria-label="Search provider models"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                style={{ color: theme.text.primary }}
              />
            </label>

            {filteredModelCount === 0 ? (
              <div className="py-6 text-center">
                <span className="text-sm" style={{ color: theme.text.muted }}>
                  No models match &ldquo;{query.trim()}&rdquo;.
                </span>
              </div>
            ) : (
              <div className="space-y-0.5 py-1">
                {filteredModelList.enabled.map((model) => renderModelToggle(model, true))}
                {filteredModelList.disabled.map((model) => renderModelToggle(model, false))}
              </div>
            )}
          </>
        )}

        <div
          className="flex items-center gap-2 py-2"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <input
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={imeSafeEnter(() => handleAddManual())}
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: theme.text.primary }}
            placeholder="Add model name..."
          />
          <button
            type="button"
            onClick={handleAddManual}
            disabled={!manualInput.trim()}
            className="transition-opacity disabled:opacity-25 opacity-50 hover:opacity-100"
            title="Add model"
          >
            <Plus size={14} strokeWidth={2} color={theme.icon.accent} />
          </button>
        </div>
      </div>

      {allModels.length > 0 ? (
        <div className="text-xs" style={{ color: theme.text.muted }}>
          {provider.modelList.enabled.length} enabled, {provider.modelList.disabled.length} disabled
        </div>
      ) : null}

      {reasoningModalModel && reasoningModalState ? (
        <ReasoningSettingsModal
          model={reasoningModalModel}
          options={reasoningModalState.options}
          defaultEffort={reasoningModalState.selected}
          provider={provider}
          onToggleOption={(selection) =>
            handleToggleReasoningOption(reasoningModalModel, selection)
          }
          onSetDefault={(selection) => handleSetDefaultReasoning(reasoningModalModel, selection)}
          onClose={() => setReasoningModalModel(null)}
        />
      ) : null}
    </div>
  )
}
