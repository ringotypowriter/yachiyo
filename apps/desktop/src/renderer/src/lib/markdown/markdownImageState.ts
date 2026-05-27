export interface ResolvedMarkdownImageSrc {
  sourceSrc: string
  resolvedSrc: string
}

export function resolveMarkdownImageSrc(
  src: string,
  resolved: ResolvedMarkdownImageSrc | null
): string {
  return resolved?.sourceSrc === src ? resolved.resolvedSrc : src
}
