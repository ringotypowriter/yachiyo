import { theme } from '@renderer/theme/theme'
import { resolveClosestFixedStepOption } from './fixedStepSliderUtils'

export interface FixedStepSliderOption {
  label: string
  value: number
}

interface FixedStepSliderProps {
  ariaLabel: string
  options: readonly FixedStepSliderOption[]
  value?: number
  onChange: (value: number) => void
  width?: number
  showLabels?: boolean
}

export function FixedStepSlider({
  ariaLabel,
  options,
  value,
  onChange,
  width = 132,
  showLabels = false
}: FixedStepSliderProps): React.ReactNode {
  const selectedOption = value == null ? undefined : resolveClosestFixedStepOption(options, value)
  const selectedIndex =
    selectedOption == null
      ? -1
      : options.findIndex((option) => option.value === selectedOption.value)
  const segmentCount = options.length
  const fillWidth =
    selectedIndex < 0 ? 0 : segmentCount <= 1 ? 100 : ((selectedIndex + 1) / segmentCount) * 100

  return (
    <div style={{ width }}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: `repeat(${segmentCount}, minmax(0, 1fr))`,
          alignItems: 'center',
          height: 28
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: 8,
            transform: 'translateY(-50%)',
            borderRadius: 99,
            background: 'rgba(17, 24, 39, 0.08)',
            pointerEvents: 'none'
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            width: `${fillWidth}%`,
            height: 8,
            transform: 'translateY(-50%)',
            borderRadius: 99,
            background: theme.text.accent,
            pointerEvents: 'none'
          }}
        />
        {options.map((option) => {
          const selected = option.value === selectedOption?.value

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${ariaLabel} ${option.label}`}
              onClick={() => onChange(option.value)}
              style={{
                position: 'relative',
                width: '100%',
                height: 28,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                padding: 0
              }}
            />
          )
        })}
      </div>
      {showLabels ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 6,
            color: theme.text.tertiary,
            fontSize: 12,
            lineHeight: 1
          }}
        >
          {options.map((option) => (
            <span
              key={option.value}
              style={{
                width: 24,
                textAlign: 'center',
                color:
                  option.value === selectedOption?.value ? theme.text.primary : theme.text.tertiary
              }}
            >
              {option.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
