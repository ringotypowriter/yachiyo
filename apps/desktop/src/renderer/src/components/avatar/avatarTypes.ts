export type AvatarPhase =
  | 'idle'
  | 'loading'
  | 'thinking'
  | 'speaking'
  | 'working'
  | 'waiting'
  | 'success'

export const avatarLabels: Record<AvatarPhase, string> = {
  idle: 'Ready',
  loading: 'Loading',
  thinking: 'Thinking',
  speaking: 'Responding',
  working: 'Working',
  waiting: 'Waiting for you',
  success: 'Done'
}
