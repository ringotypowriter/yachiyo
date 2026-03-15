import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, Search } from 'lucide-react'
import type { SettingsConfig } from '@renderer/app/types'

function ModelOption({
  model,
  isSelected,
  onSelect
}: {
  model: string
  isSelected: boolean
  onSelect: () => void
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '6px 12px 6px 10px',
        background: isSelected
          ? 'rgba(204,125,94,0.1)'
          : hovered
            ? 'rgba(0,0,0,0.04)'
            : 'transparent',
        border: 'none',
        cursor: 'pointer',
        gap: 6,
        textAlign: 'left',
        transition: 'background 0.1s'
      }}
    >
      <span
        style={{ width: 18, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 2 }}
      >
        {isSelected && <Check size={11} strokeWidth={2.5} color="#CC7D5E" />}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: isSelected ? '#CC7D5E' : '#2D2D2B',
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

export function ModelSelectorPopup({
  config,
  currentProviderName,
  currentModel,
  onSelect,
  onClose
}: {
  config: SettingsConfig
  currentProviderName: string
  currentModel: string
  onSelect: (providerName: string, model: string) => void
  onClose: () => void
}): React.ReactNode {
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const q = query.toLowerCase()
  const filtered = config.providers
    .map((provider) => ({
      name: provider.name,
      type: provider.type,
      models: provider.modelList.enabled.filter(
        (m) => !q || m.toLowerCase().includes(q) || provider.name.toLowerCase().includes(q)
      )
    }))
    .filter((p) => p.models.length > 0)

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        width: 300,
        maxHeight: 360,
        background: 'rgba(248,247,245,0.97)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid rgba(0,0,0,0.1)',
        borderRadius: 16,
        boxShadow: '0 8px 40px rgba(0,0,0,0.13), 0 2px 8px rgba(0,0,0,0.07)',
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
          borderBottom: '1px solid rgba(0,0,0,0.07)'
        }}
      >
        <Search size={14} strokeWidth={1.5} color="#aaa9a4" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models..."
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            outline: 'none',
            fontSize: 13,
            color: '#2D2D2B',
            letterSpacing: '-0.1px'
          }}
        />
      </div>

      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 6 }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: '24px 14px',
              textAlign: 'center',
              color: '#8e8e93',
              fontSize: 13
            }}
          >
            No models found
          </div>
        ) : (
          filtered.map((provider) => (
            <div key={provider.name}>
              <div
                style={{
                  padding: '10px 14px 3px',
                  fontSize: 10.5,
                  color: '#aaa9a4',
                  fontWeight: 600,
                  letterSpacing: '0.07em',
                  textTransform: 'uppercase'
                }}
              >
                {provider.name}
              </div>
              {provider.models.map((model) => (
                <ModelOption
                  key={model}
                  model={model}
                  isSelected={provider.name === currentProviderName && model === currentModel}
                  onSelect={() => {
                    onSelect(provider.name, model)
                    onClose()
                  }}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
