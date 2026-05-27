export function toUnique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/')
}
