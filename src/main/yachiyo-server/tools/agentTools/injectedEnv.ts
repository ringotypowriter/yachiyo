/**
 * Environment variables injected by Yachiyo into every tool-spawned process
 * (bash commands, jsRepl sandbox). Hidden from the model — not exposed via
 * tool input schemas. Edit this constant to add/remove injected keys.
 */
export const INJECTED_ENV: Readonly<Record<string, string>> = Object.freeze({
  KAGETE_OVERLAY_LABEL: 'Yachiyo'
})

/** Merge INJECTED_ENV onto a base env. Injected keys override base. */
export function withInjectedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...INJECTED_ENV }
}
