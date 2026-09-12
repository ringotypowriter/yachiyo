import type { AvatarPhase } from './avatarTypes.ts'

export function getActivityEyeShape(phase: AvatarPhase): { width: number; height: number } {
  if (phase === 'thinking') return { width: 0.82, height: 1.55 }
  if (phase === 'working') return { width: 1.3, height: 0.7 }
  if (phase === 'waiting') return { width: 1.18, height: 1.65 }
  return { width: 1, height: 1 }
}

export function getRestingTurn(angle: number): number {
  return Math.round(angle / 360) * 360 || 0
}

export function getWinkEyeWeight(progress: number): number {
  const p = Math.max(0, Math.min(1, progress))
  return 1 - Math.min(1, p / 0.16, (1 - p) / 0.16)
}
