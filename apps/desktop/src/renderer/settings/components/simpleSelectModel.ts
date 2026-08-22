export function filterSimpleSelectOptions<T extends { value: string; label: string }>(
  options: T[],
  query: string
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return options

  return options.filter(
    (option) =>
      option.label.toLocaleLowerCase().includes(normalizedQuery) ||
      option.value.toLocaleLowerCase().includes(normalizedQuery)
  )
}

export function moveSimpleSelectActiveIndex(
  currentIndex: number,
  direction: -1 | 1,
  optionCount: number
): number {
  if (optionCount === 0) return -1
  if (currentIndex < 0) return direction === 1 ? 0 : optionCount - 1
  return (currentIndex + direction + optionCount) % optionCount
}
