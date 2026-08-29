/**
 * Environment variables injected by Yachiyo into tool-spawned child processes.
 * Hidden from the model — not exposed via tool input schemas. Edit this constant
 * to add or remove injected keys.
 */
export const INJECTED_ENV: Readonly<Record<string, string>> = Object.freeze({
  KAGETE_OVERLAY_LABEL: 'Yachiyo'
})

/** Merge INJECTED_ENV onto a base env. Injected keys override base. */
export function withInjectedEnv(
  base: NodeJS.ProcessEnv = process.env,
  input: { runId?: string } = {}
): NodeJS.ProcessEnv {
  const env = { ...base, ...INJECTED_ENV }
  if (input.runId) {
    env.YACHIYO_RUN_ID = input.runId
  } else {
    delete env.YACHIYO_RUN_ID
  }
  return env
}
