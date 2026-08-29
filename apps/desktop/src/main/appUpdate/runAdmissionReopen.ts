export interface OwnedRunAdmissionReopenInput {
  ownsAdmission: () => boolean
  clearOwner: () => void
  openRuntime: () => Promise<void>
  recoverRuntime: () => void
  onOpenError: (error: unknown) => void
}

/**
 * Releases main-process ownership before crossing the utility RPC boundary.
 * A replacement runtime created while that RPC is rejecting therefore starts
 * with admission open. Only the recorded owner may perform the release.
 */
export async function reopenOwnedRunAdmission(input: OwnedRunAdmissionReopenInput): Promise<void> {
  if (!input.ownsAdmission()) return

  input.clearOwner()
  try {
    await input.openRuntime()
  } catch (error) {
    input.onOpenError(error)
    try {
      input.recoverRuntime()
    } catch (recoveryError) {
      input.onOpenError(recoveryError)
    }
  }
}
