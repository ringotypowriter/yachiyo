import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { theme, alpha } from '@renderer/theme/theme'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { useFloatingPanelLayout } from '@renderer/lib/useFloatingPanelLayout'

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

interface ListPaginationProps {
  page: number
  pageCount: number
  startIndex: number
  endIndex: number
  totalCount: number
  itemLabel: string
  onPageChange: (page: number) => void
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
  const t = useT()
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
          {label ?? t('settings.shared.placeholderComingSoon')}
        </span>
      </div>
    </div>
  )
}

interface SimpleSelectOption<T extends string> {
  value: T
  label: string
  preview?: React.ReactNode
}

interface SimpleSelectProps<T extends string> {
  value: T
  options: SimpleSelectOption<T>[]
  onChange: (value: T) => void
  width?: number | string
  optionHeight?: number
}

export function SimpleSelect<T extends string>({
  value,
  options,
  onChange,
  width = 200,
  optionHeight = 34
}: SimpleSelectProps<T>): React.ReactNode {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const estimatedHeight = options.length * optionHeight + 12
  const { floatingRef: dropdownRef, style: dropdownPositionStyle } = useFloatingPanelLayout({
    open,
    referenceRef: triggerRef,
    width: 'anchor',
    maxHeight: estimatedHeight,
    preferredPlacement: 'bottom',
    gap: 6,
    margin: 16
  })
  useRestoreFocusOnUnmount(open)

  function handleOpen(): void {
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
  }, [dropdownRef, open])

  const selectedOption = options.find((o) => o.value === value)
  const selectedLabel = selectedOption?.label ?? value

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
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flex: 1,
            fontSize: 14,
            color: theme.text.primary,
            lineHeight: '20px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0
          }}
        >
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
          >
            {selectedLabel}
          </span>
          {selectedOption?.preview != null ? (
            <span style={{ flexShrink: 0 }}>{selectedOption.preview}</span>
          ) : null}
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
        createPortal(
          <div
            ref={dropdownRef}
            role="listbox"
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              ...dropdownPositionStyle,
              zIndex: 9999,
              background: theme.background.surface,
              borderRadius: 12,
              border: `1px solid ${theme.border.subtle}`,
              boxShadow: theme.shadow.menu,
              padding: '4px 0',
              overflowY: 'auto'
            }}
          >
            {options.map((option) => {
              const selected = option.value === value
              return (
                <DropdownOption
                  key={option.value}
                  label={option.label}
                  preview={option.preview}
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
  preview,
  selected,
  onSelect
}: {
  label: string
  preview?: React.ReactNode
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
      {preview != null ? <span style={{ flexShrink: 0 }}>{preview}</span> : null}
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

export function ListPagination({
  page,
  pageCount,
  startIndex,
  endIndex,
  totalCount,
  itemLabel,
  onPageChange
}: ListPaginationProps): React.ReactNode {
  const t = useT()
  const canGoBackward = page > 1
  const canGoForward = page < pageCount
  const rangeLabel = totalCount === 0 ? '0' : `${startIndex + 1}–${endIndex}`

  return (
    <div
      className="flex items-center justify-between gap-3 px-7 py-2.5 text-xs"
      style={{
        color: theme.text.muted,
        borderTop: `1px solid ${theme.border.subtle}`,
        background: theme.background.surfaceMuted
      }}
    >
      <div className="tabular-nums">
        {t('settings.shared.paginationRange', {
          range: rangeLabel,
          total: totalCount,
          items: itemLabel
        })}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg transition-opacity disabled:opacity-30"
          style={{
            color: theme.text.secondary,
            border: `1px solid ${theme.border.subtle}`,
            background: theme.background.surface
          }}
          disabled={!canGoBackward}
          aria-label={t('settings.shared.prevPageAria')}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={13} />
        </button>
        <span className="min-w-12 text-center tabular-nums" style={{ color: theme.text.secondary }}>
          {page} / {pageCount}
        </span>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg transition-opacity disabled:opacity-30"
          style={{
            color: theme.text.secondary,
            border: `1px solid ${theme.border.subtle}`,
            background: theme.background.surface
          }}
          disabled={!canGoForward}
          aria-label={t('settings.shared.nextPageAria')}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={13} />
        </button>
      </div>
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
      className="relative h-5.5 w-9.5 rounded-full transition-all disabled:opacity-40"
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
