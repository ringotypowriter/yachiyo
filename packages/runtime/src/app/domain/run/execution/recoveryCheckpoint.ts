import type { RunRecoveryCheckpoint, YachiyoStorage } from '../../../../storage/storage.ts'

export function upsertRunRecoveryCheckpoint(
  deps: { storage: Pick<YachiyoStorage, 'upsertRunRecoveryCheckpoint'> },
  checkpoint: RunRecoveryCheckpoint
): void {
  deps.storage.upsertRunRecoveryCheckpoint(checkpoint)
}
