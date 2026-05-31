export interface DockBadgeController {
  increment: () => void
  clear: () => void
  getCount: () => number
}

export interface DockBadgeControllerDeps {
  platform: NodeJS.Platform
  setBadgeCount: (count: number) => boolean
}

export function createDockBadgeController({
  platform,
  setBadgeCount
}: DockBadgeControllerDeps): DockBadgeController {
  let count = 0
  const enabled = platform === 'darwin'

  function apply(nextCount: number): void {
    if (!enabled) return
    count = nextCount
    setBadgeCount(count)
  }

  return {
    increment: () => apply(count + 1),
    clear: () => apply(0),
    getCount: () => count
  }
}
