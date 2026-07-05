/**
 * Schedules an async task so at most one execution is in flight. Scheduling
 * while a run is pending marks it dirty; when the run settles, the task runs
 * once more (reading the latest state). Built for the pointer overlay's
 * executeJavaScript pushes, where only the newest state matters and unbounded
 * fire-and-forget calls pile up Electron's internal did-stop-loading
 * listeners on a loading page.
 */
export function createLatestWinsRunner(run: () => Promise<void>): () => void {
  let inFlight = false
  let rerun = false

  function pump(): void {
    inFlight = true
    void run()
      .catch(() => {
        // The task owns its error reporting; the runner only guarantees the
        // schedule loop survives a rejection.
      })
      .finally(() => {
        inFlight = false
        if (rerun) {
          rerun = false
          pump()
        }
      })
  }

  return () => {
    if (inFlight) {
      rerun = true
      return
    }
    pump()
  }
}
