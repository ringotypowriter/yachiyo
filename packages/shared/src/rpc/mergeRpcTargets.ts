/**
 * Composes one RPC target from two: `overrides` (a plain record of host-level
 * operations, usually namespaced like `host.reloadSchedules`) layered over
 * `base` (typically a class instance such as YachiyoServer). Base methods are
 * bound so dispatch keeps their `this` even though serveRpcTarget applies the
 * merged object.
 */
export function mergeRpcTargets(overrides: object, base: object): object {
  return new Proxy(overrides, {
    get(overridesTarget, property, receiver) {
      if (property in overridesTarget) {
        return Reflect.get(overridesTarget, property, receiver)
      }
      const value = (base as Record<string | symbol, unknown>)[property]
      return typeof value === 'function'
        ? (value as (...args: never[]) => unknown).bind(base)
        : value
    },
    has(overridesTarget, property) {
      return property in overridesTarget || property in base
    }
  })
}
