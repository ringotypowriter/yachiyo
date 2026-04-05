const rgbTokenVars = {
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
  success: '--yachiyo-rgb-success',
  successStrong: '--yachiyo-rgb-success-strong',
  warning: '--yachiyo-rgb-warning',
  danger: '--yachiyo-rgb-danger',
  dangerStrong: '--yachiyo-rgb-danger-strong',
  idle: '--yachiyo-rgb-idle'
} as const

type RgbToken = keyof typeof rgbTokenVars

function formatAlpha(alpha: number): string {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError(`Theme alpha must be between 0 and 1. Received: ${alpha}`)
  }

  return alpha.toString()
}

export function solid(token: RgbToken): string {
  return `rgb(var(${rgbTokenVars[token]}))`
}

export function alpha(token: RgbToken, opacity: number): string {
  return `rgb(var(${rgbTokenVars[token]}) / ${formatAlpha(opacity)})`
}

export const theme = {
  font: {
    ui: 'var(--yachiyo-font-ui)',
    display: 'var(--yachiyo-font-display)'
  },
  text: {
    primary: solid('ink'),
    secondary: solid('textSecondary'),
    tertiary: solid('textTertiary'),
    muted: solid('textMuted'),
    placeholder: solid('textPlaceholder'),
    inverse: solid('surface'),
    accent: solid('accent'),
    accentStrong: solid('accentStrong'),
    success: solid('successStrong'),
    warning: solid('warning'),
    danger: solid('danger'),
    dangerStrong: solid('dangerStrong')
  },
  background: {
    app: solid('app'),
    canvas: solid('canvas'),
    sidebar: solid('sidebar'),
    sidebarVibrancy: 'rgba(150, 210, 240, 0.15)',
    chatCard: alpha('canvas', 0.92),
    surface: alpha('surface', 0.94),
    surfaceSoft: alpha('surface', 0.88),
    surfaceMuted: alpha('surface', 0.82),
    surfaceFrosted: alpha('surface', 0.97),
    surfaceLight: alpha('surface', 0.78),
    surfaceLightest: alpha('surface', 0.72),
    surfaceOverlay: alpha('surface', 0.2),
    hover: alpha('ink', 0.04),
    hoverStrong: alpha('ink', 0.05),
    accentSoft: alpha('accent', 0.06),
    accentMuted: alpha('accent', 0.1),
    accentSurface: alpha('accent', 0.12),
    accentPanel: alpha('accent', 0.14),
    dangerSoft: alpha('danger', 0.06),
    dangerSurface: alpha('danger', 0.08),
    code: alpha('ink', 0.07),
    codeBlock: alpha('ink', 0.04)
  },
  border: {
    subtle: alpha('ink', 0.04),
    default: alpha('ink', 0.06),
    panel: alpha('ink', 0.08),
    strong: alpha('ink', 0.1),
    input: alpha('ink', 0.12),
    contrast: alpha('ink', 0.15),
    accent: alpha('accent', 0.28),
    accentStrong: alpha('accentStrong', 0.16),
    danger: alpha('danger', 0.14)
  },
  icon: {
    default: solid('ink'),
    muted: solid('textMuted'),
    placeholder: solid('textPlaceholder'),
    accent: solid('accent'),
    success: solid('successStrong'),
    danger: solid('danger')
  },
  status: {
    idle: alpha('idle', 0.78),
    success: alpha('success', 0.78),
    danger: alpha('dangerStrong', 0.76),
    accent: alpha('accent', 0.55)
  },
  shadow: {
    panel: `0 10px 30px ${alpha('ink', 0.04)}`,
    card: `0 18px 40px ${alpha('ink', 0.05)}`,
    raised: `0 6px 18px ${alpha('ink', 0.08)}`,
    button: `0 1px 3px ${alpha('ink', 0.08)}`,
    knob: `0 1px 3px ${alpha('ink', 0.18)}`,
    overlay: `0 8px 40px ${alpha('ink', 0.13)}, 0 2px 8px ${alpha('ink', 0.07)}`,
    menu: `0 14px 36px ${alpha('ink', 0.14)}, 0 2px 8px ${alpha('ink', 0.08)}`
  }
} as const

export type Theme = typeof theme
