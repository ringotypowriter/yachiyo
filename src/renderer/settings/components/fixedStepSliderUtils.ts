import type { FixedStepSliderOption } from './FixedStepSlider'

export function resolveClosestFixedStepOption(
  options: readonly FixedStepSliderOption[],
  value: number
): FixedStepSliderOption {
  return options.reduce((closest, option) =>
    Math.abs(option.value - value) < Math.abs(closest.value - value) ? option : closest
  )
}
