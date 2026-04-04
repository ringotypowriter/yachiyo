import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'

interface FieldProps {
  children: React.ReactNode
  label: string
}

interface PlaceholderPaneProps {
  label?: string
}

interface SettingSwitchProps {
  ariaLabel: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
}

interface SettingLabelProps {
  children: React.ReactNode
  action?: React.ReactNode
}

export function Field({ label, children }: FieldProps): React.ReactNode {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" style={{ color: theme.text.primary }}>
        {label}
      </span>
      {children}
    </label>
  )
}

export function PlaceholderPane({ label }: PlaceholderPaneProps): React.ReactNode {
  return (
    <div className="flex-1 overflow-y-auto flex items-center justify-center">
      <div className="flex flex-col items-center gap-2.5" style={{ opacity: 0.4 }}>
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 40, height: 40, border: `2px dashed ${theme.border.input}` }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke={theme.icon.muted}
            strokeWidth="1.5"
          >
            <path d="M8 4v8M4 8h8" />
          </svg>
        </div>
        <span className="text-sm" style={{ color: theme.text.muted }}>
          {label ?? 'Content coming soon'}
        </span>
      </div>
    </div>
  )
}

interface SimpleSelectOption<T extends string> {
  value: T
  label: string
}

interface SimpleSelectProps<T extends string> {
  value: T
  options: SimpleSelectOption<T>[]
  onChange: (value: T) => void
  width?: number | string
}

export function SimpleSelect<T extends string>({
  value,
  options,
  onChange,
  width = 200
}: SimpleSelectProps<T>): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [openUpward, setOpenUpward] = useState(false)
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined)
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  function handleOpen(): void {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setTriggerRect(rect)
      const gap = 6
      const margin = 16
      const estimatedHeight = options.length * 34 + 12
      const spaceBelow = window.innerHeight - rect.bottom - gap - margin
      const spaceAbove = rect.top - gap - margin
      const shouldFlip = estimatedHeight > spaceBelow && spaceAbove > spaceBelow
      setOpenUpward(shouldFlip)
      setMaxHeight(Math.min(estimatedHeight, shouldFlip ? spaceAbove : spaceBelow))
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent): void {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const selectedLabel = options.find((o) => o.value === value)?.label ?? value

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : handleOpen())}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width,
          padding: '10px 10px 10px 12px',
          borderRadius: 10,
          border: 'none',
          background: alpha('ink', 0.04),
          cursor: 'default',
          textAlign: 'left',
          outline: 'none'
        }}
      >
        <span style={{ flex: 1, fontSize: 14, color: theme.text.primary, lineHeight: '20px' }}>
          {selectedLabel}
        </span>
        <ChevronDown
          size={13}
          strokeWidth={2}
          color={theme.icon.muted}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease'
          }}
        />
      </button>

      {open &&
        triggerRect &&
        createPortal(
          <div
            ref={dropdownRef}
            role="listbox"
            style={{
              position: 'fixed',
              ...(openUpward
                ? { bottom: window.innerHeight - triggerRect.top + 6 }
                : { top: triggerRect.bottom + 6 }),
              left: triggerRect.left,
              width: triggerRect.width,
              zIndex: 9999,
              background: theme.background.surface,
              borderRadius: 12,
              border: `1px solid ${theme.border.subtle}`,
              boxShadow: '0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.06)',
              padding: '4px 0',
              maxHeight,
              overflowY: 'auto'
            }}
          >
            {options.map((option) => {
              const selected = option.value === value
              return (
                <DropdownOption
                  key={option.value}
                  label={option.label}
                  selected={selected}
                  onSelect={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                />
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}

function DropdownOption({
  label,
  selected,
  onSelect
}: {
  label: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      role="option"
      aria-selected={selected}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(e) => {
        e.preventDefault()
        onSelect()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        margin: '0 4px',
        borderRadius: 8,
        cursor: 'default',
        background: hovered ? alpha('ink', 0.04) : 'transparent',
        transition: 'background 80ms'
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 13,
          fontWeight: selected ? 500 : 400,
          color: theme.text.primary,
          lineHeight: 1
        }}
      >
        {label}
      </span>
      {selected && <Check size={12} strokeWidth={2.5} color={theme.text.accent} />}
    </div>
  )
}

export function SettingSection({ children }: { children: React.ReactNode }): React.ReactNode {
  return <section className="mt-6 first:mt-0">{children}</section>
}

export function SettingLabel({ children, action }: SettingLabelProps): React.ReactNode {
  if (action) {
    return (
      <div className="flex items-center justify-between px-7 pt-5 pb-2.5">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: theme.text.secondary }}
        >
          {children}
        </div>
        {action}
      </div>
    )
  }

  return (
    <div
      className="px-7 pt-5 pb-2.5 text-[11px] font-semibold uppercase tracking-[0.12em]"
      style={{ color: theme.text.secondary }}
    >
      {children}
    </div>
  )
}

export function SettingRow({ children }: { children: React.ReactNode }): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className="flex items-center justify-between gap-4 px-7 py-3 transition-colors"
      style={{
        borderTop: `1px solid ${theme.border.subtle}`,
        background: hovered ? theme.background.hover : 'transparent'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </div>
  )
}

export function SettingSwitch({
  checked,
  onChange,
  disabled,
  ariaLabel
}: SettingSwitchProps): React.ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
      className="relative h-5.5 w-9.5 rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: checked ? theme.text.accent : theme.border.strong
      }}
    >
      <span
        className="absolute top-0.5 rounded-full transition-all"
        style={{
          width: 18,
          height: 18,
          left: checked ? 18 : 2,
          background: theme.text.inverse
        }}
      />
    </button>
  )
}
