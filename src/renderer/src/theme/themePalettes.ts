import type { ThemeId } from '../../../shared/yachiyo/protocol.ts'

type ThemeVariant = 'light' | 'dark'

export const themeRgbTokenVars = {
  ink: '--yachiyo-rgb-ink',
  textSecondary: '--yachiyo-rgb-text-secondary',
  textTertiary: '--yachiyo-rgb-text-tertiary',
  textMuted: '--yachiyo-rgb-text-muted',
  textPlaceholder: '--yachiyo-rgb-text-placeholder',
  app: '--yachiyo-rgb-app',
  canvas: '--yachiyo-rgb-canvas',
  sidebar: '--yachiyo-rgb-sidebar',
  surface: '--yachiyo-rgb-surface',
  accent: '--yachiyo-rgb-accent',
  accentStrong: '--yachiyo-rgb-accent-strong',
  scrim: '--yachiyo-rgb-scrim',
  onAccentOverlay: '--yachiyo-rgb-on-accent-overlay',
  success: '--yachiyo-rgb-success',
  successStrong: '--yachiyo-rgb-success-strong',
  warning: '--yachiyo-rgb-warning',
  danger: '--yachiyo-rgb-danger',
  dangerStrong: '--yachiyo-rgb-danger-strong',
  idle: '--yachiyo-rgb-idle'
} as const

export type RgbToken = keyof typeof themeRgbTokenVars
export type ThemePalette = Record<RgbToken, string>

export interface ThemeOption {
  id: ThemeId
  label: string
  description: string
  palettes: Record<ThemeVariant, ThemePalette>
}

export interface ThemePreviewSegment {
  token: 'app' | 'sidebar' | 'surface' | 'ink' | 'accent'
  rgb: string
  weight: number
}

export interface ThemeSchemePreviewSegment {
  variant: ThemeVariant
  token: 'app' | 'sidebar' | 'surface' | 'accent'
  rgb: string
  weight: number
}

const previewTokens: readonly ThemePreviewSegment['token'][] = [
  'app',
  'sidebar',
  'surface',
  'ink',
  'accent'
]
const previewWeights = [38, 24, 30, 1, 7] as const
const schemePreviewSpec: readonly Omit<ThemeSchemePreviewSegment, 'rgb'>[] = [
  { variant: 'light', token: 'app', weight: 32 },
  { variant: 'light', token: 'sidebar', weight: 18 },
  { variant: 'light', token: 'surface', weight: 16 },
  { variant: 'dark', token: 'surface', weight: 14 },
  { variant: 'dark', token: 'sidebar', weight: 8 },
  { variant: 'light', token: 'accent', weight: 6 },
  { variant: 'dark', token: 'accent', weight: 6 }
]

const lightSemanticTokens = {
  scrim: '0 0 0',
  onAccentOverlay: '255 255 255',
  success: '78 131 102',
  successStrong: '92 173 138',
  warning: '192 86 33',
  danger: '181 58 47',
  dangerStrong: '143 65 50',
  idle: '192 189 184'
} as const

const darkSemanticTokens = {
  scrim: '0 0 0',
  onAccentOverlay: '255 255 255',
  success: '116 160 132',
  successStrong: '139 191 158',
  warning: '218 155 95',
  danger: '218 105 94',
  dangerStrong: '232 135 120',
  idle: '105 113 119'
} as const

type ThemeIdentityTokens = Omit<ThemePalette, keyof typeof lightSemanticTokens>

function lightPalette(tokens: ThemeIdentityTokens): ThemePalette {
  return { ...tokens, ...lightSemanticTokens }
}

function darkPalette(tokens: ThemeIdentityTokens): ThemePalette {
  return { ...tokens, ...darkSemanticTokens }
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: 'mizu',
    label: 'Mizu',
    description: 'Clear water blue.',
    palettes: {
      light: lightPalette({
        ink: '45 45 43',
        textSecondary: '91 90 87',
        textTertiary: '107 106 102',
        textMuted: '142 142 147',
        textPlaceholder: '170 169 164',
        app: '234 242 247',
        canvas: '242 248 252',
        sidebar: '224 237 245',
        surface: '255 255 255',
        accent: '75 175 201',
        accentStrong: '42 122 149'
      }),
      dark: darkPalette({
        ink: '238 241 242',
        textSecondary: '204 210 213',
        textTertiary: '158 168 173',
        textMuted: '123 134 140',
        textPlaceholder: '93 104 111',
        app: '24 27 30',
        canvas: '29 33 37',
        sidebar: '32 38 43',
        surface: '38 42 46',
        accent: '99 179 195',
        accentStrong: '130 203 214'
      })
    }
  },
  {
    id: 'sumi',
    label: 'Sumi',
    description: 'Neutral ink gray.',
    palettes: {
      light: lightPalette({
        ink: '42 43 45',
        textSecondary: '88 90 94',
        textTertiary: '105 108 113',
        textMuted: '139 143 149',
        textPlaceholder: '168 172 178',
        app: '240 242 244',
        canvas: '247 248 249',
        sidebar: '231 235 239',
        surface: '255 255 255',
        accent: '104 149 190',
        accentStrong: '72 111 151'
      }),
      dark: darkPalette({
        ink: '239 240 241',
        textSecondary: '205 207 210',
        textTertiary: '160 164 169',
        textMuted: '125 130 136',
        textPlaceholder: '94 100 107',
        app: '24 25 27',
        canvas: '29 31 34',
        sidebar: '35 38 42',
        surface: '42 45 49',
        accent: '122 171 210',
        accentStrong: '151 195 228'
      })
    }
  },
  {
    id: 'ume',
    label: 'Ume',
    description: 'Soft plum accent.',
    palettes: {
      light: lightPalette({
        ink: '48 42 44',
        textSecondary: '95 86 90',
        textTertiary: '112 102 107',
        textMuted: '146 137 142',
        textPlaceholder: '174 166 170',
        app: '247 241 244',
        canvas: '252 247 249',
        sidebar: '241 230 235',
        surface: '255 255 255',
        accent: '200 106 134',
        accentStrong: '154 72 98'
      }),
      dark: darkPalette({
        ink: '242 238 240',
        textSecondary: '213 205 209',
        textTertiary: '170 158 164',
        textMuted: '137 124 131',
        textPlaceholder: '107 95 102',
        app: '29 24 27',
        canvas: '35 29 32',
        sidebar: '42 34 39',
        surface: '48 40 45',
        accent: '217 139 160',
        accentStrong: '233 167 184'
      })
    }
  },
  {
    id: 'aoba',
    label: 'Aoba',
    description: 'Quiet leaf green.',
    palettes: {
      light: lightPalette({
        ink: '43 47 44',
        textSecondary: '86 94 88',
        textTertiary: '102 111 105',
        textMuted: '137 146 140',
        textPlaceholder: '166 174 169',
        app: '240 246 242',
        canvas: '247 251 248',
        sidebar: '228 239 233',
        surface: '255 255 255',
        accent: '106 174 143',
        accentStrong: '72 129 101'
      }),
      dark: darkPalette({
        ink: '238 242 239',
        textSecondary: '205 212 207',
        textTertiary: '160 170 164',
        textMuted: '125 136 129',
        textPlaceholder: '95 106 99',
        app: '23 28 26',
        canvas: '28 34 31',
        sidebar: '33 42 37',
        surface: '39 48 43',
        accent: '134 198 167',
        accentStrong: '164 221 190'
      })
    }
  },
  {
    id: 'mint',
    label: 'Mint',
    description: 'Fresh mint glass.',
    palettes: {
      light: lightPalette({
        ink: '38 49 47',
        textSecondary: '78 95 91',
        textTertiary: '98 116 111',
        textMuted: '132 148 143',
        textPlaceholder: '164 178 174',
        app: '235 247 244',
        canvas: '247 253 251',
        sidebar: '161 227 216',
        surface: '255 255 255',
        accent: '42 128 118',
        accentStrong: '24 96 88'
      }),
      dark: darkPalette({
        ink: '236 244 241',
        textSecondary: '202 215 211',
        textTertiary: '156 174 169',
        textMuted: '121 139 134',
        textPlaceholder: '91 110 104',
        app: '20 29 28',
        canvas: '24 36 34',
        sidebar: '29 48 44',
        surface: '35 55 50',
        accent: '161 227 216',
        accentStrong: '194 246 237'
      })
    }
  },
  {
    id: 'fuji',
    label: 'Fuji',
    description: 'Soft wisteria fields.',
    palettes: {
      light: lightPalette({
        ink: '46 42 48',
        textSecondary: '92 86 96',
        textTertiary: '109 102 114',
        textMuted: '144 136 152',
        textPlaceholder: '172 164 180',
        app: '242 238 247',
        canvas: '248 245 252',
        sidebar: '231 224 241',
        surface: '255 255 255',
        accent: '172 142 202',
        accentStrong: '138 108 168'
      }),
      dark: darkPalette({
        ink: '241 238 245',
        textSecondary: '209 204 217',
        textTertiary: '165 158 178',
        textMuted: '130 123 145',
        textPlaceholder: '100 93 115',
        app: '27 24 31',
        canvas: '32 28 36',
        sidebar: '38 33 45',
        surface: '44 39 51',
        accent: '192 168 220',
        accentStrong: '212 188 232'
      })
    }
  },
  {
    id: 'yamabuki',
    label: 'Yamabuki',
    description: 'Golden kerria bloom.',
    palettes: {
      light: lightPalette({
        ink: '46 44 40',
        textSecondary: '92 88 82',
        textTertiary: '109 104 96',
        textMuted: '145 139 130',
        textPlaceholder: '172 166 156',
        app: '247 245 238',
        canvas: '252 250 244',
        sidebar: '239 233 218',
        surface: '255 255 255',
        accent: '202 156 72',
        accentStrong: '168 126 48'
      }),
      dark: darkPalette({
        ink: '242 240 236',
        textSecondary: '210 206 198',
        textTertiary: '166 160 150',
        textMuted: '131 126 116',
        textPlaceholder: '101 96 86',
        app: '30 28 23',
        canvas: '35 33 27',
        sidebar: '42 38 30',
        surface: '48 44 36',
        accent: '220 180 100',
        accentStrong: '236 200 128'
      })
    }
  },
  {
    id: 'gobyou',
    label: 'Gobyou',
    description: 'Five seconds of midsummer.',
    palettes: {
      light: lightPalette({
        ink: '43 40 39',
        textSecondary: '90 85 82',
        textTertiary: '108 102 98',
        textMuted: '142 136 132',
        textPlaceholder: '170 164 158',
        app: '242 238 235',
        canvas: '248 244 241',
        sidebar: '232 224 218',
        surface: '255 255 255',
        accent: '225 72 62',
        accentStrong: '188 50 42'
      }),
      dark: darkPalette({
        ink: '242 238 235',
        textSecondary: '210 204 198',
        textTertiary: '165 158 150',
        textMuted: '130 123 115',
        textPlaceholder: '98 92 85',
        app: '26 24 23',
        canvas: '31 28 27',
        sidebar: '36 32 30',
        surface: '42 38 35',
        accent: '245 130 118',
        accentStrong: '255 162 150'
      })
    }
  }
]

const themeOptionsById: Record<ThemeId, ThemeOption> = {
  mizu: THEME_OPTIONS[0],
  sumi: THEME_OPTIONS[1],
  ume: THEME_OPTIONS[2],
  aoba: THEME_OPTIONS[3],
  mint: THEME_OPTIONS[4],
  fuji: THEME_OPTIONS[5],
  yamabuki: THEME_OPTIONS[6],
  gobyou: THEME_OPTIONS[7]
}

export function getThemeOption(themeId: ThemeId): ThemeOption {
  return themeOptionsById[themeId]
}

export function getThemePalette(themeId: ThemeId, variant: ThemeVariant): ThemePalette {
  return getThemeOption(themeId).palettes[variant]
}

export function getThemePreviewSegments(
  themeId: ThemeId,
  variant: ThemeVariant
): ThemePreviewSegment[] {
  const palette = getThemePalette(themeId, variant)
  return previewTokens.map((token, index) => ({
    token,
    rgb: palette[token],
    weight: previewWeights[index]
  }))
}

export function getThemeSchemePreviewSegments(themeId: ThemeId): ThemeSchemePreviewSegment[] {
  return schemePreviewSpec.map((segment) => ({
    ...segment,
    rgb: getThemePalette(themeId, segment.variant)[segment.token]
  }))
}
