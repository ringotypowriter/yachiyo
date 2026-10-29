/** Electron's `powerSaveBlocker` and `powerMonitor`, narrowed for tests. */
export interface PowerApi {
  startBlocker(): number
  stopBlocker(id: number): void
  isOnBattery(): boolean
  onPowerSourceChange(listener: () => void): () => void
}

export interface RemoteKeepAwake {
  setWanted(wanted: boolean): void
  dispose(): void
}

/**
 * Holds `prevent-app-suspension` while remote wants the Mac reachable and it is on AC power,
 * so an idle Mac keeps serving the phone. Closing the lid still sleeps the machine.
 */
export function createRemoteKeepAwake(power: PowerApi): RemoteKeepAwake {
  let wanted = false
  let blockerId: number | null = null

  const reconcile = (): void => {
    const hold = wanted && !power.isOnBattery()
    if (hold && blockerId === null) {
      blockerId = power.startBlocker()
    } else if (!hold && blockerId !== null) {
      power.stopBlocker(blockerId)
      blockerId = null
    }
  }
  const offPowerChange = power.onPowerSourceChange(reconcile)

  return {
    setWanted(next) {
      wanted = next
      reconcile()
    },
    dispose() {
      wanted = false
      reconcile()
      offPowerChange()
    }
  }
}
