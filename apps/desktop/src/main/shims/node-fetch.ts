/**
 * Shim that redirects node-fetch to globalThis.fetch (Electron net.fetch),
 * so bundled libraries like Telegraf go through the system proxy.
 *
 * Errors are wrapped so that .message remains writable — Telegraf's
 * redactToken helper mutates error.message to strip bot tokens.
 */
const nodeFetch = (
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): ReturnType<typeof fetch> =>
  globalThis.fetch(url, init).catch((err: Error) => {
    const wrapped = new Error(err.message)
    wrapped.name = err.name
    wrapped.stack = err.stack
    throw wrapped
  })

export default nodeFetch
