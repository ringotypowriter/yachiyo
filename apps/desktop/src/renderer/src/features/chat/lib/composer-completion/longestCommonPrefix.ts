export function longestCommonPrefix(values: string[], caseInsensitive = false): string {
  if (values.length === 0) return ''
  if (values.length === 1) return values[0]
  const first = values[0]
  let end = first.length
  for (let i = 1; i < values.length; i++) {
    const other = values[i]
    let j = 0
    const max = Math.min(end, other.length)
    while (j < max) {
      const a = first.charCodeAt(j)
      const b = other.charCodeAt(j)
      if (a === b) {
        j++
        continue
      }
      if (caseInsensitive && first[j].toLowerCase() === other[j].toLowerCase()) {
        j++
        continue
      }
      break
    }
    end = j
    if (end === 0) return ''
  }
  return first.slice(0, end)
}
