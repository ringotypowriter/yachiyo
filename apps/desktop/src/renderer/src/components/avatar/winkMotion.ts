interface WinkPose {
  eye: string
  otherEye: string
  bodyRotate: number
  bodyY: number
  bodyScaleX: number
  bodyScaleY: number
  gazeX: number
  gazeY: number
}

function oval(rx: number, ry: number, x = 42, y = 31): number[] {
  const k = 0.552285
  return [
    x,
    y - ry,
    x + rx * k,
    y - ry,
    x + rx,
    y - ry * k,
    x + rx,
    y,
    x + rx,
    y + ry * k,
    x + rx * k,
    y + ry,
    x,
    y + ry,
    x - rx * k,
    y + ry,
    x - rx,
    y + ry * k,
    x - rx,
    y,
    x - rx,
    y - ry * k,
    x - rx * k,
    y - ry,
    x,
    y - ry
  ]
}

// Four connected cubic segments throughout: a filled eye folds into a soft,
// asymmetric crease pointing toward the other eye, rather than changing icons.
const crease = [
  39.4, 27.6, 41.2, 27.9, 44.5, 29.6, 45.2, 31.3, 44.4, 32.7, 40.3, 35.1, 38.8, 34.1, 37.7, 33.1,
  40.4, 32.2, 42.7, 31.1, 40.8, 30.3, 37.9, 28.8, 39.4, 27.6
]
const squeeze = [
  39.6, 29, 41.6, 28.8, 44.8, 30.1, 45.7, 31.4, 44.6, 32.6, 40.5, 34, 39, 33.3, 37.9, 32.3, 40.8,
  31.6, 43.2, 31.3, 41.1, 30.9, 38.2, 30.1, 39.6, 29
]
const softEye = oval(3, 3.5, 58, 30.6)
const relaxed = [0, 0, 1, 1, 0, 0]
const frames = [
  { at: 0, eye: oval(3, 4), otherEye: oval(3, 4, 58), pose: relaxed },
  {
    at: 0.16,
    eye: oval(2.5, 4.4),
    otherEye: oval(3, 4.05, 58),
    pose: [4, 0.8, 1.03, 0.96, -1.2, 0.3]
  },
  {
    at: 0.34,
    eye: crease,
    otherEye: oval(3, 3.7, 58, 30.8),
    pose: [-8, -1.8, 1.035, 0.98, 1.2, -0.6]
  },
  { at: 0.5, eye: squeeze, otherEye: softEye, pose: [-12, -2.8, 1.055, 0.95, 1.8, -1] },
  { at: 0.62, eye: squeeze, otherEye: softEye, pose: [-7, 0.2, 1.07, 0.92, 1.2, -0.5] },
  {
    at: 0.72,
    eye: crease,
    otherEye: oval(3, 3.7, 58, 30.8),
    pose: [-4, -1.4, 0.98, 1.035, 0.5, -0.3]
  },
  {
    at: 0.84,
    eye: oval(3.3, 4.4),
    otherEye: oval(3.05, 4.1, 58),
    pose: [3, 0.4, 1.015, 0.985, -0.3, 0.2]
  },
  { at: 1, eye: oval(3, 4), otherEye: oval(3, 4, 58), pose: relaxed }
]

export const WINK_DURATION_MS = 900

export function sampleWinkPose(progress: number, side: 'left' | 'right' = 'left'): WinkPose {
  const p = Math.max(0, Math.min(1, progress))
  const end = frames.findIndex((frame) => frame.at >= p)
  const next = frames[Math.max(1, end)]
  const previous = frames[Math.max(1, end) - 1]
  const t = (p - previous.at) / (next.at - previous.at)
  const eased = t * t * (3 - 2 * t)
  const blend = (a: number[], b: number[]): number[] =>
    a.map((value, i) => value + (b[i] - value) * eased)
  const contour = (a: number[], b: number[]): string => {
    const points = blend(a, b).map((value, i) =>
      side === 'right' && i % 2 === 0 ? 100 - value : value
    )
    return `M ${points.slice(0, 2).join(' ')} ${[2, 8, 14, 20].map((i) => `C ${points.slice(i, i + 6).join(' ')}`).join(' ')} Z`
  }
  const eye = contour(previous.eye, next.eye)
  const otherEye = contour(previous.otherEye, next.otherEye)
  const [bodyRotate, bodyY, bodyScaleX, bodyScaleY, gazeX, gazeY] = blend(previous.pose, next.pose)
  const mirror = (value: number): number => (side === 'right' && value !== 0 ? -value : value)
  return {
    eye,
    otherEye,
    bodyRotate: mirror(bodyRotate),
    bodyY,
    bodyScaleX,
    bodyScaleY,
    gazeX: mirror(gazeX),
    gazeY
  }
}
