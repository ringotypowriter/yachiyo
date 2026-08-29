import { reopenOwnedRunAdmission } from './runAdmissionReopen.ts'

export interface GatewayRunAdmission {
  closeRunAdmissionAndGetActiveRunIds(ownerId: string): Promise<string[]>
  openRunAdmission(ownerId: string): Promise<void>
  getOwnerId(): string | undefined
}

export function createGatewayRunAdmission<TRuntime>(input: {
  closeRuntime: (ownerId: string) => Promise<string[]>
  getRuntime: () => TRuntime | null
  openRuntime: (ownerId: string, runtime: TRuntime | null) => Promise<void>
  recoverRuntime: (runtime: TRuntime | null) => void
  onOpenError: (error: unknown) => void
}): GatewayRunAdmission {
  let ownerId: string | undefined

  return {
    async closeRunAdmissionAndGetActiveRunIds(nextOwnerId): Promise<string[]> {
      const activeRunIds = await input.closeRuntime(nextOwnerId)
      ownerId = nextOwnerId
      return activeRunIds
    },

    async openRunAdmission(releasingOwnerId): Promise<void> {
      const attemptedRuntime = input.getRuntime()
      await reopenOwnedRunAdmission({
        ownsAdmission: () => ownerId === releasingOwnerId,
        clearOwner: () => {
          ownerId = undefined
        },
        openRuntime: () => input.openRuntime(releasingOwnerId, attemptedRuntime),
        recoverRuntime: () => input.recoverRuntime(attemptedRuntime),
        onOpenError: input.onOpenError
      })
    },

    getOwnerId(): string | undefined {
      return ownerId
    }
  }
}
