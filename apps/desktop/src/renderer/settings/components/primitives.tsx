import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { theme, alpha } from '@renderer/theme/theme'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { useFloatingPanelLayout } from '@renderer/lib/useFloatingPanelLayout'
import { isImeComposingKeyEvent } from '@renderer/lib/imeUtils'
import { filterSimpleSelectOptions, moveSimpleSelectActiveIndex } from './simpleSelectModel'

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
  description?: React.ReactNode
}

type SettingHintTone = 'warning' | 'danger'

interface SettingItemTextProps {
  label: React.ReactNode
  description?: React.ReactNode
  hint?: React.ReactNode
  hintTone?: SettingHintTone
}

interface SettingItemProps extends SettingItemTextProps {
  control?: React.ReactNode
}

interface SettingBlockProps extends SettingItemTextProps {
  children: React.ReactNode
}

interface SubPageHeaderProps {
  backLabel: string
  onBack: () => void
  title: React.ReactNode
  description?: React.ReactNode
  meta?: React.ReactNode
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
  searchable?: boolean
  searchPlaceholder?: string
  emptyLabel?: string
}

export function SimpleSelect<T extends string>({
  value,
  options,
  onChange,
  width = 200,
  optionHeight = 34,
  searchable = false,
  searchPlaceholder = 'Search',
  emptyLabel = 'No results'
}: SimpleSelectProps<T>): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const visibleOptions = searchable ? filterSimpleSelectOptions(options, query) : options
  const estimatedHeight = visibleOptions.length * optionHeight + 12 + (searchable ? 46 : 0)
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
    setQuery('')
    setActiveIndex(-1)
    setOpen(true)
  }

  function handleClose(): void {
    setOpen(false)
    setQuery('')
    setActiveIndex(-1)
  }

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent): void {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        handleClose()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [dropdownRef, open])

  useEffect(() => {
    if (!open || !searchable) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, searchable])

  const selectedOption = options.find((o) => o.value === value)
  const selectedLabel = selectedOption?.label ?? value

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? handleClose() : handleOpen())}
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
            {searchable ? (
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  margin: '0 4px 4px',
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: theme.background.surface
                }}
              >
                <Search size={14} color={theme.icon.muted} />
                <input
                  ref={searchInputRef}
                  value={query}
                  role="combobox"
                  aria-label={searchPlaceholder}
                  aria-expanded={open}
                  aria-controls={listboxId}
                  aria-activedescendant={
                    activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
                  }
                  placeholder={searchPlaceholder}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setActiveIndex(0)
                  }}
                  onKeyDown={(event) => {
                    if (isImeComposingKeyEvent(event.nativeEvent)) return
                    if (event.key === 'Escape') {
                      handleClose()
                      return
                    }
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActiveIndex((current) =>
                        moveSimpleSelectActiveIndex(
                          current,
                          event.key === 'ArrowDown' ? 1 : -1,
                          visibleOptions.length
                        )
                      )
                      return
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      const option = visibleOptions[activeIndex >= 0 ? activeIndex : 0]
                      if (option) {
                        onChange(option.value)
                        handleClose()
                      }
                    }
                  }}
                  style={{
                    minWidth: 0,
                    flex: 1,
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: theme.text.primary,
                    fontSize: 13
                  }}
                />
              </div>
            ) : null}
            <div id={listboxId} role="listbox">
              {visibleOptions.map((option, index) => {
                const selected = option.value === value
                return (
                  <DropdownOption
                    key={option.value}
                    id={`${listboxId}-option-${index}`}
                    label={option.label}
                    preview={option.preview}
                    selected={selected}
                    active={index === activeIndex}
                    onActivate={() => setActiveIndex(index)}
                    onSelect={() => {
                      onChange(option.value)
                      handleClose()
                    }}
                  />
                )
              })}
              {visibleOptions.length === 0 ? (
                <div
                  style={{
                    padding: '10px 12px',
                    color: theme.text.muted,
                    fontSize: 13,
                    textAlign: 'center'
                  }}
                >
                  {emptyLabel}
                </div>
              ) : null}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

function DropdownOption({
  id,
  label,
  preview,
  selected,
  active,
  onActivate,
  onSelect
}: {
  id: string
  label: string
  preview?: React.ReactNode
  selected: boolean
  active: boolean
  onActivate: () => void
  onSelect: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const optionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (active) optionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div
      ref={optionRef}
      id={id}
      role="option"
      aria-selected={selected}
      onPointerEnter={() => {
        setHovered(true)
        onActivate()
      }}
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
        background: hovered || active ? alpha('ink', 0.04) : 'transparent',
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

export function SettingLabel({
  children,
  action,
  description
}: SettingLabelProps): React.ReactNode {
  const heading = (
    <div
      className="text-[11px] font-semibold uppercase tracking-[0.12em]"
      style={{ color: theme.text.secondary }}
    >
      {children}
    </div>
  )

  return (
    <div className={description ? 'px-7 pt-5 pb-3' : 'px-7 pt-5 pb-2.5'}>
      {action ? (
        <div className="flex items-center justify-between gap-4">
          {heading}
          {action}
        </div>
      ) : (
        heading
      )}
      {description ? (
        <div className="mt-2 text-sm leading-5" style={{ color: theme.text.tertiary }}>
          {description}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The label / description / hint stack that every setting row shares. Kept separate from
 * SettingItem so blocks and bespoke rows can reuse the exact same typography.
 */
export function SettingItemText({
  label,
  description,
  hint,
  hintTone = 'warning'
}: SettingItemTextProps): React.ReactNode {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
        {label}
      </div>
      {description ? (
        <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
          {description}
        </div>
      ) : null}
      {hint ? (
        <div
          className="mt-0.5 text-xs leading-4"
          style={{ color: hintTone === 'danger' ? theme.text.dangerStrong : theme.text.warning }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  )
}

/** A setting row: what it changes on the left, the control that changes it on the right. */
export function SettingItem({ control, ...text }: SettingItemProps): React.ReactNode {
  return (
    <SettingRow>
      <SettingItemText {...text} />
      {control ? <div className="shrink-0">{control}</div> : null}
    </SettingRow>
  )
}

/** A setting whose control needs the full row width below the label instead of beside it. */
export function SettingBlock({ children, ...text }: SettingBlockProps): React.ReactNode {
  return (
    <SettingRow>
      <div className="min-w-0 flex-1 space-y-3">
        <SettingItemText {...text} />
        {children}
      </div>
    </SettingRow>
  )
}

/** Header for a settings sub-page reached from a row (USER.md, SOUL.md, memory terms, ...). */
export function SubPageHeader({
  backLabel,
  onBack,
  title,
  description,
  meta,
  action
}: SubPageHeaderProps): React.ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 px-7 pt-5 pb-4">
      <div className="min-w-0">
        <button
          type="button"
          className="text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity opacity-60 hover:opacity-100"
          style={{ color: theme.text.accent }}
          onClick={onBack}
        >
          {`← ${backLabel}`}
        </button>
        <div className="mt-1 text-lg font-semibold" style={{ color: theme.text.primary }}>
          {title}
        </div>
        {description ? (
          <div className="mt-0.5 text-sm leading-5" style={{ color: theme.text.tertiary }}>
            {description}
          </div>
        ) : null}
        {meta ? (
          <div
            className="content-selectable mt-0.5 text-xs leading-5 break-all"
            style={{ color: theme.text.muted }}
          >
            {meta}
          </div>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-3 pt-1">{action}</div> : null}
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
