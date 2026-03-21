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

export function Field({ label, children }: FieldProps): React.ReactNode {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" style={{ color: '#2D2D2B' }}>
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
          style={{ width: 40, height: 40, border: '2px dashed #8e8e93' }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="#8e8e93"
            strokeWidth="1.5"
          >
            <path d="M8 4v8M4 8h8" />
          </svg>
        </div>
        <span className="text-sm" style={{ color: '#8e8e93' }}>
          {label ?? 'Content coming soon'}
        </span>
      </div>
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
      className="relative h-6 w-11 rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: checked ? '#CC7D5E' : 'rgba(0,0,0,0.12)',
        boxShadow: checked
          ? 'inset 0 0 0 1px rgba(181,106,74,0.16)'
          : 'inset 0 0 0 1px rgba(0,0,0,0.05)'
      }}
    >
      <span
        className="absolute top-0.5 rounded-full bg-white transition-all"
        style={{
          width: 20,
          height: 20,
          left: checked ? 22 : 2,
          boxShadow: '0 1px 3px rgba(0,0,0,0.18)'
        }}
      />
    </button>
  )
}
