export interface SavePngFileInput {
  pngData: ArrayBuffer | Uint8Array
  defaultFilename?: string
}

export type SavePngFileResult = { canceled: true } | { canceled: false; filePath: string }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function normalizePngFilename(input?: string): string {
  const trimmed = input?.trim()
  if (!trimmed) return 'diagram.png'

  const filename = trimmed.replace(/[/:\\]/g, '-')
  return filename.toLowerCase().endsWith('.png') ? filename : `${filename}.png`
}

export function normalizePngBytes(input: ArrayBuffer | Uint8Array): Buffer {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < PNG_SIGNATURE.length) {
    throw new Error('PNG export data must be a valid PNG image.')
  }

  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error('PNG export data must be a valid PNG image.')
    }
  }

  return Buffer.from(bytes)
}
