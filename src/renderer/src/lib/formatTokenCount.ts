export function formatTokenCount(count: number): string {
  if (count < 1000) {
    return String(count)
  }
  if (count < 1_000_000) {
    const k = count / 1000
    return `${parseFloat(k.toFixed(1))}K`
  }
  const m = count / 1_000_000
  return `${parseFloat(m.toFixed(1))}M`
}
