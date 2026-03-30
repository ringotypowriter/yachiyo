export interface RestartableApp {
  relaunch(): void
  exit(code?: number): void
}

export function restartForUpdate(app: RestartableApp): void {
  app.relaunch()
  app.exit(0)
}
