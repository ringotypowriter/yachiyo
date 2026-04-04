import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Cpu, Factory, Search } from 'lucide-react'
import { ProviderIconAvatar } from '@renderer/lib/providerIcons'
import type { SettingsConfig } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { matchProviderPreset } from '../../../../../shared/yachiyo/providerPresets.ts'
import {
  resolveModelSelectorState,
  type AcpAgentEntry,
  type FilteredModelProvider
} from '../lib/modelSelectorState'

function ModelOption({
  model,
  disabled = false,
  isSelected,
  onSelect
}: {
  model: string
  disabled?: boolean
  isSelected: boolean
  onSelect: () => void
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      disabled={disabled}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '6px 12px 6px 10px',
        background: isSelected
          ? theme.background.accentMuted
          : hovered
            ? theme.background.hover
            : 'transparent',
        border: 'none',
        cursor: disabled ? 'progress' : 'pointer',
        gap: 6,
        textAlign: 'left',
        transition: 'background 0.1s',
        opacity: disabled ? 0.65 : 1
      }}
    >
      <span
        style={{ width: 18, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 2 }}
      >
        {isSelected && <Check size={11} strokeWidth={2.5} color={theme.icon.accent} />}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: isSelected ? theme.text.accent : theme.text.primary,
          fontWeight: isSelected ? 500 : 400,
          letterSpacing: '-0.1px',
          lineHeight: 1.4
        }}
      >
        {model}
      </span>
    </button>
  )
}

function AcpAgentOption({
  agent,
  disabled = false,
  isSelected,
  onSelect
}: {
  agent: AcpAgentEntry
  disabled?: boolean
  isSelected: boolean
  onSelect: () => void
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      disabled={disabled}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '6px 12px 6px 10px',
        background: isSelected
          ? theme.background.accentMuted
          : hovered
            ? theme.background.hover
            : 'transparent',
        border: 'none',
        cursor: disabled ? 'progress' : 'pointer',
        gap: 6,
        textAlign: 'left',
        transition: 'background 0.1s',
        opacity: disabled ? 0.65 : 1
      }}
    >
      <span
        style={{ width: 18, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 2 }}
      >
        {isSelected ? (
          <Check size={11} strokeWidth={2.5} color={theme.icon.accent} />
        ) : (
          <Cpu size={11} strokeWidth={1.8} color={theme.icon.muted} />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13,
            color: isSelected ? theme.text.accent : theme.text.primary,
            fontWeight: isSelected ? 500 : 400,
            letterSpacing: '-0.1px',
            lineHeight: 1.4
          }}
        >
          {agent.name}
        </span>
        {agent.description ? (
          <span
            style={{
              display: 'block',
              fontSize: 11,
              color: theme.text.muted,
              lineHeight: 1.35,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {agent.description}
          </span>
        ) : null}
      </span>
    </button>
  )
}

const MODEL_SELECTOR_ICON_SIZE = 14

function ProviderSectionHeader({ provider }: { provider: FilteredModelProvider }): React.ReactNode {
  const preset = matchProviderPreset(provider.name, provider.baseUrl)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '10px 14px 3px',
        fontSize: 10.5,
        color: theme.text.placeholder,
        fontWeight: 600,
        letterSpacing: '0.07em',
        textTransform: 'uppercase'
      }}
    >
      <span
        style={{
          display: 'flex',
          width: MODEL_SELECTOR_ICON_SIZE,
          height: MODEL_SELECTOR_ICON_SIZE,
          flexShrink: 0
        }}
      >
        {preset ? (
          <ProviderIconAvatar iconKey={preset.iconKey} size={MODEL_SELECTOR_ICON_SIZE} />
        ) : (
          <Factory
            size={MODEL_SELECTOR_ICON_SIZE}
            strokeWidth={1.5}
            color={theme.text.placeholder}
          />
        )}
      </span>
      {provider.name}
    </div>
  )
}

export function ModelSelectorPopup({
  align = 'left',
  anchorRect,
  config,
  containerRef,
  currentProviderName,
  currentModel,
  currentAcpProfileId,
  leadingOptions,
  onSelect,
  onSelectAcpAgent,
  onClose,
  placement = 'top',
  portal = false,
  width = 300
}: {
  align?: 'left' | 'right'
  anchorRect?: DOMRect | null
  config: SettingsConfig
  containerRef?: React.RefObject<HTMLDivElement | null>
  currentProviderName: string
  currentModel: string
  currentAcpProfileId?: string | null
  leadingOptions?: Array<{
    isSelected: boolean
    label: string
    onSelect: () => void
  }>
  onSelect: (providerName: string, model: string) => Promise<void> | void
  onSelectAcpAgent?: (agent: AcpAgentEntry) => Promise<void> | void
  onClose: () => void
  placement?: 'bottom' | 'top'
  portal?: boolean
  width?: number
}): React.ReactNode {
  const [query, setQuery] = useState('')
  const [selectionPending, setSelectionPending] = useState(false)
  const [visible, setVisible] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSelection = (action: () => Promise<void> | void): void => {
    if (selectionPending) {
      return
    }

    setSelectionPending(true)
    void Promise.resolve(action())
      .then(() => {
        onClose()
      })
      .catch(() => {
        setSelectionPending(false)
      })
  }

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !selectionPending) onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, selectionPending])

  const hasLeadingOptions = leadingOptions != null && leadingOptions.length > 0

  const selectorState = resolveModelSelectorState({
    config,
    hasLeadingOption: hasLeadingOptions,
    query
  })

  const hasAcpAgents = selectorState.acpAgents.length > 0

  const popupWidth = Math.min(width, window.innerWidth - 24)
  const popupLeft = anchorRect
    ? Math.max(
        12,
        Math.min(
          align === 'right' ? anchorRect.right - popupWidth : anchorRect.left,
          window.innerWidth - popupWidth - 12
        )
      )
    : 0
  const availableSpaceAbove = anchorRect ? anchorRect.top - 8 : 0
  const availableSpaceBelow = anchorRect ? window.innerHeight - anchorRect.bottom - 8 : 0

  const resolvedPlacement =
    portal && anchorRect
      ? placement === 'bottom'
        ? availableSpaceBelow < 360 && availableSpaceAbove > availableSpaceBelow
          ? 'top'
          : 'bottom'
        : placement === 'top'
          ? availableSpaceAbove < 360 && availableSpaceBelow > availableSpaceAbove
            ? 'bottom'
            : 'top'
          : placement
      : placement

  const popupStyle: React.CSSProperties =
    portal && anchorRect
      ? {
          position: 'fixed',
          ...(resolvedPlacement === 'top'
            ? { bottom: window.innerHeight - anchorRect.top + 8 }
            : { top: anchorRect.bottom + 8 }),
          left: popupLeft,
          width: popupWidth
        }
      : {
          position: 'absolute',
          ...(resolvedPlacement === 'top'
            ? { bottom: 'calc(100% + 8px)' }
            : { top: 'calc(100% + 8px)' }),
          left: 0,
          width
        }

  const popup = (
    <div
      ref={containerRef}
      style={{
        ...popupStyle,
        maxHeight: 360,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 16,
        boxShadow: theme.shadow.overlay,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 50,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(6px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease'
      }}
    >
      {/* Search */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: `1px solid ${theme.border.panel}`
        }}
      >
        <Search size={14} strokeWidth={1.5} color={theme.icon.placeholder} />
        <input
          ref={inputRef}
          disabled={selectionPending}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models..."
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            outline: 'none',
            fontSize: 13,
            color: theme.text.primary,
            letterSpacing: '-0.1px',
            opacity: selectionPending ? 0.65 : 1
          }}
        />
      </div>

      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 6 }}>
        {selectorState.showLeadingOption && hasLeadingOptions ? (
          <div style={{ paddingTop: 4 }}>
            {leadingOptions.map((option) => (
              <ModelOption
                key={option.label}
                disabled={selectionPending}
                model={option.label}
                isSelected={option.isSelected}
                onSelect={() => {
                  handleSelection(option.onSelect)
                }}
              />
            ))}
          </div>
        ) : null}

        {selectorState.showEmptyState ? (
          <div
            style={{
              padding: '24px 14px',
              textAlign: 'center',
              color: theme.text.muted,
              fontSize: 13
            }}
          >
            No models found
          </div>
        ) : (
          <>
            {selectorState.providers.map((provider) => (
              <div key={provider.name}>
                <ProviderSectionHeader provider={provider} />

                {provider.models.map((model) => (
                  <ModelOption
                    key={model}
                    disabled={selectionPending}
                    model={model}
                    isSelected={
                      !currentAcpProfileId &&
                      provider.name === currentProviderName &&
                      model === currentModel
                    }
                    onSelect={() => {
                      handleSelection(() => onSelect(provider.name, model))
                    }}
                  />
                ))}
              </div>
            ))}
            {hasAcpAgents ? (
              <div>
                <div
                  style={{
                    padding: '10px 14px 3px',
                    fontSize: 10.5,
                    color: theme.text.placeholder,
                    fontWeight: 600,
                    letterSpacing: '0.07em',
                    textTransform: 'uppercase'
                  }}
                >
                  ACP Agents
                </div>
                {selectorState.acpAgents.map((agent) => (
                  <AcpAgentOption
                    key={agent.id}
                    agent={agent}
                    disabled={selectionPending}
                    isSelected={agent.id === currentAcpProfileId}
                    onSelect={() => {
                      handleSelection(() => onSelectAcpAgent?.(agent))
                    }}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )

  if (portal && anchorRect) {
    return createPortal(popup, document.body)
  }

  return popup
}
