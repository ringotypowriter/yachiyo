import { easeInOut, interpolate } from 'framer-motion'

interface PointingPose {
  handX: number
  handY: number
  handRadius: number
  bodyRotate: number
  bodyY: number
  gazeX: number
  gazeY: number
}

const rest: PointingPose = {
  handX: 66,
  handY: 26,
  handRadius: 0,
  bodyRotate: 0,
  bodyY: 0,
  gazeX: 0,
  gazeY: 0
}
const poseAt = interpolate<PointingPose>(
  [0, 0.08, 0.14, 0.23, 0.31, 0.36, 0.42, 0.5, 0.58, 1],
  [
    rest,
    { ...rest, gazeX: 2, gazeY: -1 },
    { handX: 70, handY: 24, handRadius: 3.6, bodyRotate: -2, bodyY: 0, gazeX: 3.2, gazeY: -2 },
    { handX: 79, handY: 17, handRadius: 3.6, bodyRotate: -5, bodyY: -0.5, gazeX: 3.2, gazeY: -2.4 },
    { handX: 84, handY: 13, handRadius: 3.6, bodyRotate: -5, bodyY: -0.5, gazeX: 3.2, gazeY: -2.4 },
    {
      handX: 83,
      handY: 11.5,
      handRadius: 3.7,
      bodyRotate: -6,
      bodyY: -0.8,
      gazeX: 3.5,
      gazeY: -2.8
    },
    {
      handX: 80,
      handY: 16.5,
      handRadius: 3.6,
      bodyRotate: -3.5,
      bodyY: 0,
      gazeX: 2.5,
      gazeY: -1.8
    },
    { handX: 67, handY: 26, handRadius: 3.6, bodyRotate: 1.2, bodyY: 0.4, gazeX: 0.6, gazeY: -0.3 },
    rest,
    rest
  ],
  { ease: easeInOut }
)

export const POINTING_CYCLE_MS = 7600

export function getPointingRestTarget(progress: number): 0 | 1 {
  return progress <= 0.36 ? 0 : 1
}

export function samplePointingPose(progress: number): PointingPose {
  // Motion reuses the interpolated object; publish a fresh snapshot to consumers.
  return { ...poseAt(progress) }
}
